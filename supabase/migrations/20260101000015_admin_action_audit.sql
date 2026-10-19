-- =====================================================================
-- 0015 Audit for login management done in the app (create login, reset
-- password). These happen in Supabase Auth, outside our tables, so the
-- app records them explicitly in the hash-chained audit log.
-- =====================================================================
create function hr.log_admin_action(p_table text, p_record text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not hr.is_admin() then raise exception 'only Admin actions are recorded here'; end if;
  perform hr.append_audit(p_table, p_record, 'APP', null, null, p_note);
end $$;
revoke all on function hr.log_admin_action(text, text, text) from public;
grant execute on function hr.log_admin_action(text, text, text) to hr_app;
