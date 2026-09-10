-- 0032 removed EXECUTE from every public function, including the predicates
-- evaluated by RLS policies. The application still accesses business tables
-- through direct transactions running as `authenticated`, so those policies
-- must be able to call their narrowly scoped helper functions.
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_permission(uuid, text) to authenticated;
grant execute on function public.is_assigned_movement(uuid) to authenticated;

-- These functions are called inside authenticated RLS transactions so their
-- work remains atomic with the surrounding mutations.
grant execute on function public.log_audit(uuid, text, text, text, jsonb, jsonb)
  to authenticated;
grant execute on function public.next_movement_number(uuid, text) to authenticated;
grant execute on function public.notify_organization(uuid, text, text, text, text, text)
  to authenticated;
grant execute on function public.record_usage(uuid, text, int, jsonb) to authenticated;
