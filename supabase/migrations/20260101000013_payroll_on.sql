-- =====================================================================
-- 0013 PAYROLL ON (owner decision 2026-10-19)
--
-- ON  : payroll_execution  -> real monthly payroll runs: calculate, review,
--                             approve, LOCK (insert-only snapshot), payslips
-- OFF : payment_execution  -> the app never sends or records money moving;
--                             pay from the bank as usual
-- OFF : tax_calculation    -> no tax until official rates are verified
-- OFF : late_deduction     -> the OLD "one hour's salary" type stays unapprovable;
--                             the owner's 4%-of-a-day rule is applied by payroll
-- These three stay pinned OFF by the CHECK constraint.
-- =====================================================================

alter table hr.feature_flag drop constraint money_execution_flags_locked_off;
alter table hr.feature_flag add constraint money_execution_flags_locked_off check (
  key not in ('payment_execution', 'tax_calculation', 'late_deduction') or enabled = false
);
update hr.feature_flag
   set enabled = true,
       description = 'Owner decision 2026-10-19: monthly payroll runs are ON (calculate, approve, lock, payslips). Payments and tax remain OFF.'
 where key = 'payroll_execution';

-- Payroll approval: in single-admin mode the preparer may approve (recorded);
-- otherwise a different Admin must approve, as before.
create or replace function hr.on_payroll_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_run; f record;
begin
  select * into r from hr.payroll_run where id = new.run_id for update;
  if r.status <> 'under_review' then raise exception 'run must be under_review to approve (is %)', r.status; end if;
  if not hr.is_admin() then raise exception 'only Admin may approve payroll'; end if;
  if new.approved_by is distinct from hr.current_auth_user() then raise exception 'approved_by must be the acting user'; end if;
  if new.approved_by = r.prepared_by and not hr.flag_enabled('single_admin_mode') then
    raise exception 'segregation of duties: preparer cannot approve';
  end if;
  select * into f from hr.payroll_run_fingerprint(new.run_id);
  if f.line_count <> new.approved_line_count or f.total_net_paisa <> new.approved_total_net_paisa
     or f.content_hash <> new.approved_content_hash then
    raise exception 'approval does not match the current run contents (version %, % lines, total %)',
      r.version, f.line_count, f.total_net_paisa;
  end if;
  update hr.payroll_run set status = 'approved' where id = r.id;
  return new;
end $$;

-- Locking a period's payroll needs no further approval request in
-- single-admin mode; reopening still records a reason.
grant execute on function hr.lock_payroll_run(uuid), hr.reopen_payroll_run(uuid, text, uuid), hr.payroll_run_fingerprint(uuid) to hr_app;

-- FIX: employees could never see their own payslip. The policy looked up
-- payroll_run, which employees may not read, so the check was always false.
create function hr.run_is_final(p_run uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hr.payroll_run r where r.id = p_run and not r.is_sandbox
                 and r.status in ('locked', 'paid', 'partially_paid'))
$$;
grant execute on function hr.run_is_final(uuid) to hr_app;
drop policy payroll_line_read on hr.payroll_line;
create policy payroll_line_read on hr.payroll_line for select to hr_app using (
  hr.is_staff() or (hr.is_self(employee_id) and hr.run_is_final(run_id)));

-- Month/version/status of a run, readable by anyone who can read one of its
-- lines (payslips), without exposing the payroll_run table itself.
create function hr.run_info(p_run uuid, out month text, out version int, out status text)
language sql stable security definer set search_path = '' as $$
  select to_char(pp.period_month, 'YYYY-MM'), r.version, r.status::text
  from hr.payroll_run r join hr.payroll_period pp on pp.id = r.period_id where r.id = p_run
$$;
grant execute on function hr.run_info(uuid) to hr_app;
