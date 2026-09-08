-- =============================================================================
-- Corridor — 0025 SMS channel, driver / dispatch notification detail, company
-- profile (Avaal parity gaps 14 and 19)
--
--   1. organizations: timezone, billing address, the "include PARS in cargo
--      control numbers" filing rule, up to five dispatch e-mail addresses.
--   2. drivers: SMS opt-in with a phone per regime, and whether the driver
--      sheet is e-mailed to the person in charge.
--   3. user_profiles.phone — the SMS address of a member.
--   4. shipments_control_number() prefixes PARS on an ACI PARS shipment when
--      the organization files that way.
--   5. background_jobs_insert allow-lists driver.notify.
--
-- notifications.channel / notification_rules.channel are text[] with no value
-- check (0006), so `sms` needs no constraint change: the canonical channel
-- list is `notificationChannel` in packages/domain.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. organizations (same grain — columns)
-- -----------------------------------------------------------------------------

alter table public.organizations
  add column timezone                       text not null default 'America/Toronto',
  -- Free-form postal address, like partners.address (the invoice address).
  add column billing_address                jsonb not null default '{}'::jsonb,
  -- Avaal's "Include PARS in cargo control numbers": CCN = carrier code ||
  -- 'PARS' || reference for ACI PARS shipments.
  add column include_pars_in_cargo_numbers  boolean not null default false,
  -- Where driver sheets and entry notices go; a short list, not a table —
  -- the addresses have no identity of their own.
  add column dispatch_emails                text[] not null default '{}'
                                              check (cardinality(dispatch_emails) <= 5);

-- -----------------------------------------------------------------------------
-- 2. drivers (same grain — columns)
-- -----------------------------------------------------------------------------

alter table public.drivers
  add column sms_opt_in          boolean not null default false,
  add column sms_phone_ace       text,
  add column sms_phone_aci       text,
  add column email_driver_sheet  boolean not null default true;

-- -----------------------------------------------------------------------------
-- 3. user_profiles.phone
-- -----------------------------------------------------------------------------

alter table public.user_profiles
  add column phone text;

-- -----------------------------------------------------------------------------
-- 4. shipments_control_number() — live definition is 0019_shipments.sql:104-112.
-- Rebuilt with the PARS rule: an ACI PARS shipment carries the PARS prefix in
-- its cargo control number when the organization files that way. The
-- reference itself is unchanged, so switching the flag later only affects
-- shipments written after the switch.
-- -----------------------------------------------------------------------------

create or replace function public.shipments_control_number()
returns trigger
language plpgsql
as $$
declare
  v_include_pars boolean;
begin
  if new.regime = 'ACI' and new.is_pars then
    select include_pars_in_cargo_numbers into v_include_pars
      from public.organizations where id = new.organization_id;
    if coalesce(v_include_pars, false) and new.control_reference !~ '^PARS' then
      new.control_number := new.carrier_code || 'PARS' || new.control_reference;
      return new;
    end if;
  end if;
  new.control_number := new.carrier_code || new.control_reference;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. background_jobs_insert — live definition is 0023_customs_gateway.sql.
-- Rebuilt with driver.notify, which applyCustomsDecision enqueues (from the
-- dev simulation under a session holding movement.transmit_to_customs, or
-- from the worker / webhook under the service role).
-- -----------------------------------------------------------------------------

drop policy background_jobs_insert on public.background_jobs;
create policy background_jobs_insert on public.background_jobs for insert to authenticated
  with check (
    organization_id is not null and case job_type
      when 'customs.decide' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.poll_status' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'customs.notices_sync' then false
      when 'driver.notify' then
        public.has_permission(organization_id, 'movement.transmit_to_customs')
      when 'compliance.scan' then public.has_permission(organization_id, 'alert.manage')
      when 'document.extract' then public.has_permission(organization_id, 'document.upload')
      when 'copilot.embed_knowledge' then case payload ->> 'sourceType'
        when 'movement_note' then public.has_permission(organization_id, 'movement.write')
        when 'hold_resolution' then public.has_permission(organization_id, 'alert.manage')
        when 'sop_document' then public.has_permission(organization_id, 'document.upload')
        else false
      end
      -- Any member may enqueue this, because the payload is not a message: it
      -- carries only the ids of notification rows, and the worker re-reads the
      -- text and the recipient from `notifications` (scoped to this same
      -- organization). The worst a forged job can do is re-push a colleague's
      -- existing notification inside the caller's own org, which the
      -- integration_events row records.
      when 'notification.push' then public.is_org_member(organization_id)
      else false
    end
  );
