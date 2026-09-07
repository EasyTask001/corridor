-- =============================================================================
-- Corridor — 0016 notification.push background job
--
-- The notification fan-out runs inside the acting user's RLS transaction, but
-- Expo push delivery needs `push_tokens_for`, which is EXECUTE-granted to
-- `service_role` only (migration 0015). Opening a service-role transaction
-- while the caller's is still open would hold two connections from the same
-- pool per request and self-deadlock under load, so the fan-out enqueues a
-- `notification.push` job instead and the worker — which already holds the
-- service role — delivers it.
--
-- `background_jobs_insert` (migration 0008) allow-lists producer job types by
-- permission, so the new type has to be added there or the enqueue is rejected.
-- =============================================================================

drop policy background_jobs_insert on public.background_jobs;
create policy background_jobs_insert on public.background_jobs for insert to authenticated
  with check (
    organization_id is not null and case job_type
      when 'customs.decide' then
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
