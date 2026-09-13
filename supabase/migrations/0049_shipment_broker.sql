-- Corridor — 0049 shipment-specific customs broker assignment

alter table public.shipments add column broker_id uuid;

create index shipments_org_broker_idx
  on public.shipments (organization_id, broker_id)
  where broker_id is not null;

alter table public.shipments
  add constraint shipments_broker_org_fkey
  foreign key (broker_id, organization_id)
  references public.partners (id, organization_id)
  on delete restrict;

create function public.validate_shipment_broker_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.broker_id is not null and not exists (
    select 1
    from public.partners p
    where p.id = new.broker_id
      and p.organization_id = new.organization_id
    and p.type in ('broker', 'both')
  ) then
    raise check_violation using
      constraint = 'shipments_broker_role_guard',
      message = 'shipment broker must be a broker or dual-role partner in the same organization';
  end if;
  return new;
end;
$$;

create trigger shipments_broker_role_guard
  before insert or update of broker_id, organization_id on public.shipments
  for each row execute function public.validate_shipment_broker_role();

create function public.protect_assigned_broker_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.type not in ('broker', 'both') and exists (
    select 1 from public.shipments s
    where s.broker_id = new.id and s.organization_id = new.organization_id
  ) then
    raise check_violation using
      constraint = 'partners_assigned_broker_role_guard',
      message = 'an assigned broker cannot be changed to a non-broker role';
  end if;
  return new;
end;
$$;

create trigger partners_assigned_broker_role_guard
  before update of type on public.partners
  for each row execute function public.protect_assigned_broker_role();
