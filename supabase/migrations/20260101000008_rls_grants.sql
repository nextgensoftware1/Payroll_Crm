-- =====================================================================
-- 0008 ROW-LEVEL SECURITY, GRANTS, AUDIT WIRING
-- Read this file top to bottom to review the whole access model.
--
-- Layering:
--   1. GRANTS decide which verbs a DB role may use at all.
--      No role is granted DELETE or TRUNCATE on anything.
--      Insert-only tables get INSERT + SELECT, never UPDATE.
--   2. RLS decides which ROWS. Default deny: a table with RLS on and no
--      matching policy returns zero rows.
--   3. TRIGGERS backstop both for the owner (forbid_mutation/forbid_delete)
--      and enforce workflow rules (approval guards, payroll guards).
--
-- Supabase note: Supabase's own anon / authenticated / service_role
-- roles get NOTHING on schema hr. service_role has BYPASSRLS, so it must
-- never be used by the API for user requests.
-- =====================================================================

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema hr from %I', r);
      execute format('revoke all on schema hr from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 1. Enable RLS on every table; attach never-delete + audit triggers.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'hr' loop
    execute format('alter table hr.%I enable row level security', t);
    -- hard-delete backstop on everything (insert-only tables already have forbid_mutation)
    if not exists (select 1 from pg_trigger where tgrelid = format('hr.%I', t)::regclass and tgname = t || '_immutable') then
      execute format('create trigger %I before delete on hr.%I for each row execute function hr.forbid_delete()', t || '_no_delete', t);
    end if;
    execute format('create trigger %I before truncate on hr.%I for each statement execute function hr.forbid_delete()', t || '_no_truncate_all', t);
    -- row audit, except tables that are themselves immutable evidence
    if t not in ('audit_event', 'raw_import_row', 'raw_punch', 'import_row_result', 'attendance_day',
                 'attendance_day_punch', 'notification') then
      execute format('create trigger %I after insert or update on hr.%I for each row execute function hr.audit_row()', t || '_audit', t);
    end if;
  end loop;
end $$;

-- updated_at maintenance where the column exists
do $$
declare t text;
begin
  for t in select c.table_name from information_schema.columns c
           where c.table_schema = 'hr' and c.column_name = 'updated_by'
             and c.table_name in (select tablename from pg_tables where schemaname = 'hr') loop
    execute format('create trigger %I before update on hr.%I for each row execute function hr.set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;

-- =====================================================================
-- 2. GRANTS (hr_app = API requests)
-- =====================================================================
grant execute on all functions in schema hr to hr_app, hr_worker;
revoke execute on function hr.append_audit(text, text, text, jsonb, jsonb, text) from hr_app, hr_worker;

-- Reference data: read for all signed-in users; write for staff.
grant select on hr.department, hr.team, hr.shift, hr.work_calendar, hr.work_calendar_rule,
                hr.holiday, hr.holiday_employee, hr.leave_type, hr.document_category,
                hr.document_requirement, hr.policy_config, hr.feature_flag, hr.payroll_period,
                hr.retention_policy, hr.device to hr_app;
grant insert, update on hr.department, hr.team, hr.shift, hr.work_calendar, hr.holiday,
                hr.holiday_employee, hr.leave_type, hr.document_category, hr.document_requirement,
                hr.policy_config, hr.payroll_period, hr.device to hr_app;
grant insert on hr.work_calendar_rule to hr_app;
-- feature_flag: SELECT only. Nobody can flip a flag through the API.

-- Mutable business tables
grant select, insert, update on hr.employee, hr.employee_identity, hr.employee_payment_detail,
                hr.employee_document, hr.attendance_exception, hr.attendance_dispute,
                hr.punch_mapping, hr.import_flag, hr.compensation_plan, hr.incentive_rule,
                hr.payroll_run, hr.payroll_line, hr.reconciliation, hr.final_settlement,
                hr.lifecycle_alert, hr.legal_hold, hr.user_role, hr.tax_rule_set to hr_app;
grant update (read_at) on hr.notification to hr_app;
grant select on hr.notification to hr_app;
grant update (applied_at) on hr.change_request to hr_app;

-- Import batch: evidence columns are NOT updatable. Column-level grant.
grant select, insert on hr.attendance_import_batch to hr_app;
grant update (status, reviewed_by, reviewed_at, review_note) on hr.attendance_import_batch to hr_app;

-- Insert-only (INSERT + SELECT, never UPDATE)
grant select, insert on hr.approval_request, hr.approval_decision, hr.change_request,
                hr.employee_assignment, hr.manager_assignment, hr.employment_contract,
                hr.probation_period, hr.employee_calendar_assignment, hr.leave_request,
                hr.leave_transaction, hr.file_reference, hr.document_version, hr.document_review,
                hr.attendance_correction, hr.device_clock_adjustment, hr.overtime_authorization,
                hr.overtime_record, hr.deduction_proposal, hr.loan_account, hr.loan_transaction,
                hr.payroll_approval, hr.payment_instruction, hr.payment_transaction,
                hr.payment_evidence, hr.reconciliation_variance, hr.payslip_reference,
                hr.final_settlement_component to hr_app;

-- Read-only for the API (written only by worker or definer functions)
grant select on hr.audit_event, hr.raw_import_row, hr.raw_punch, hr.import_row_result,
                hr.attendance_computation, hr.attendance_day, hr.attendance_day_punch,
                hr.payroll_snapshot, hr.payroll_payable to hr_app;

-- Views
grant select on hr.current_contract, hr.current_probation, hr.employee_payment_detail_masked,
                hr.leave_balance, hr.attendance_day_current, hr.document_exceptions,
                hr.loan_balance to hr_app;

-- =====================================================================
-- 2b. GRANTS (hr_worker = import + nightly jobs). No access to bank,
-- identity, documents, compensation, payroll or payment tables.
-- =====================================================================
grant select on hr.device, hr.device_clock_adjustment, hr.punch_mapping, hr.employee,
                hr.employee_calendar_assignment, hr.work_calendar_rule, hr.shift, hr.holiday,
                hr.holiday_employee, hr.leave_request, hr.approval_request, hr.attendance_correction,
                hr.policy_config, hr.payroll_run, hr.payroll_period, hr.employment_contract,
                hr.probation_period, hr.manager_assignment, hr.user_role, hr.file_reference,
                hr.overtime_authorization to hr_worker;
grant select, insert on hr.raw_import_row, hr.raw_punch, hr.import_row_result, hr.import_flag,
                hr.attendance_day, hr.attendance_day_punch, hr.lifecycle_alert, hr.notification to hr_worker;
grant select, insert, update on hr.attendance_exception to hr_worker;
grant select, update (status, detected_source, detected_encoding, parser_version, total_rows, parsed_rows,
                      error_rows, promoted_punches, duplicate_punches, open_flags)
      on hr.attendance_import_batch to hr_worker;
grant select, insert on hr.attendance_computation to hr_worker;
grant update (superseded_by, superseded_at) on hr.attendance_computation to hr_worker;
grant select on hr.attendance_day_current, hr.current_contract, hr.current_probation to hr_worker;

-- =====================================================================
-- 3. RLS POLICIES
-- Helper predicates (0001, 0003):
--   hr.is_admin(), hr.is_hr(), hr.is_staff(), hr.is_auditor()
--   hr.is_self(emp)   -- acting user's own ACTIVE employee record
--   hr.manages(emp)   -- acting user has manager role AND a current
--                        manager_assignment over emp
--   hr.can_view_employee(emp) = staff OR self OR manages
-- =====================================================================

-- ---- Worker: trusted system process, full row access on its tables ----
do $$
declare t text;
begin
  foreach t in array array['device', 'device_clock_adjustment', 'punch_mapping', 'employee',
    'employee_calendar_assignment', 'work_calendar_rule', 'shift', 'holiday', 'holiday_employee',
    'leave_request', 'approval_request', 'attendance_correction', 'policy_config', 'payroll_run',
    'payroll_period', 'employment_contract', 'probation_period', 'manager_assignment', 'user_role',
    'file_reference', 'overtime_authorization', 'raw_import_row', 'raw_punch', 'import_row_result',
    'import_flag', 'attendance_day', 'attendance_day_punch', 'lifecycle_alert', 'notification',
    'attendance_exception', 'attendance_import_batch', 'attendance_computation'] loop
    execute format('create policy worker_all on hr.%I to hr_worker using (true) with check (true)', t);
  end loop;
end $$;

-- ---- Reference data: any signed-in app user may read; staff write ----
do $$
declare t text;
begin
  foreach t in array array['department', 'team', 'shift', 'work_calendar', 'work_calendar_rule',
    'leave_type', 'document_category', 'document_requirement', 'policy_config', 'feature_flag',
    'payroll_period', 'retention_policy', 'holiday', 'holiday_employee'] loop
    execute format('create policy ref_read on hr.%I for select to hr_app using (hr.current_auth_user() is not null)', t);
    execute format('create policy ref_write on hr.%I for insert to hr_app with check (hr.is_staff())', t);
    execute format('create policy ref_update on hr.%I for update to hr_app using (hr.is_staff()) with check (hr.is_staff())', t);
  end loop;
end $$;

-- ---- Employee-scoped, manager may see (operational data) ----
do $$
declare t text;
begin
  foreach t in array array['employee_assignment', 'manager_assignment', 'employment_contract',
    'probation_period', 'employee_calendar_assignment', 'attendance_day', 'attendance_exception',
    'attendance_correction', 'attendance_dispute', 'overtime_authorization', 'overtime_record',
    'leave_request', 'leave_transaction', 'attendance_computation'] loop
    execute format('create policy scoped_read on hr.%I for select to hr_app using (hr.can_view_employee(employee_id))', t);
  end loop;
end $$;

-- ---- Employee-scoped, SENSITIVE: staff + self only, never managers ----
do $$
declare t text;
begin
  foreach t in array array['employee_identity', 'employee_payment_detail', 'employee_document',
    'compensation_plan', 'deduction_proposal', 'loan_account', 'loan_transaction',
    'final_settlement', 'change_request'] loop
    execute format('create policy sensitive_read on hr.%I for select to hr_app using (hr.is_staff() or hr.is_self(employee_id))', t);
  end loop;
end $$;
-- Managers may still see change requests THEY submitted
create policy own_change_requests on hr.change_request for select to hr_app
  using (requested_by = hr.current_auth_user());

-- ---- Staff-only write policies (HR proposes) ----
do $$
declare t text;
begin
  foreach t in array array['employee_assignment', 'manager_assignment', 'employment_contract',
    'probation_period', 'employee_calendar_assignment', 'attendance_correction', 'overtime_record',
    'leave_transaction', 'employee_identity', 'employee_payment_detail', 'employee_document',
    'compensation_plan', 'deduction_proposal', 'loan_account', 'loan_transaction', 'final_settlement',
    'punch_mapping', 'device_clock_adjustment', 'document_review', 'final_settlement_component',
    'incentive_rule', 'tax_rule_set', 'legal_hold', 'payroll_run', 'payroll_line', 'reconciliation',
    'reconciliation_variance', 'payslip_reference', 'device'] loop
    execute format('create policy staff_insert on hr.%I for insert to hr_app with check (hr.is_staff())', t);
  end loop;
  foreach t in array array['employee_identity', 'employee_payment_detail', 'employee_document',
    'compensation_plan', 'final_settlement', 'punch_mapping', 'incentive_rule', 'tax_rule_set',
    'legal_hold', 'payroll_run', 'payroll_line', 'reconciliation', 'attendance_exception',
    'attendance_dispute', 'device'] loop
    execute format('create policy staff_update on hr.%I for update to hr_app using (hr.is_staff()) with check (hr.is_staff())', t);
  end loop;
end $$;

-- ---- Employee register ----
create policy employee_read on hr.employee for select to hr_app using (hr.can_view_employee(id));
create policy employee_insert on hr.employee for insert to hr_app with check (hr.is_staff());
create policy employee_update on hr.employee for update to hr_app using (hr.is_staff()) with check (hr.is_staff());

-- ---- Self-service ----
create policy leave_request_insert on hr.leave_request for insert to hr_app
  with check (hr.is_staff() or (hr.is_self(employee_id) and requested_by = hr.current_auth_user()));
create policy dispute_insert on hr.attendance_dispute for insert to hr_app
  with check (hr.is_self(employee_id) and raised_by = hr.current_auth_user());
create policy change_request_insert on hr.change_request for insert to hr_app
  with check (requested_by = hr.current_auth_user()
              and (hr.is_staff() or hr.manages(employee_id) or hr.is_self(employee_id)));
create policy change_request_apply on hr.change_request for update to hr_app
  using (hr.is_admin()) with check (hr.is_admin());

-- ---- Overtime pre-authorisation: managers of that employee only ----
create policy ot_auth_insert on hr.overtime_authorization for insert to hr_app
  with check (hr.manages(employee_id) and authorized_by = hr.current_auth_user());

-- ---- Approvals centre ----
create policy approval_request_read on hr.approval_request for select to hr_app
  using (hr.is_staff() or requested_by = hr.current_auth_user()
         or hr.is_self(subject_employee_id) or hr.manages(subject_employee_id));
create policy approval_request_insert on hr.approval_request for insert to hr_app
  with check (requested_by = hr.current_auth_user());
create policy approval_decision_read on hr.approval_decision for select to hr_app
  using (exists (select 1 from hr.approval_request r where r.id = approval_request_id));  -- inherits request visibility
create policy approval_decision_insert on hr.approval_decision for insert to hr_app
  with check (decided_by = hr.current_auth_user());     -- role + SoD enforced by trigger

-- ---- Attendance import & evidence: staff only ----
create policy batch_read on hr.attendance_import_batch for select to hr_app using (hr.is_staff());
create policy batch_insert on hr.attendance_import_batch for insert to hr_app
  with check (hr.is_staff() and uploaded_by = hr.current_auth_user());
create policy batch_review on hr.attendance_import_batch for update to hr_app
  using (hr.is_staff()) with check (hr.is_staff());
create policy raw_row_read on hr.raw_import_row for select to hr_app using (hr.is_staff());
create policy row_result_read on hr.import_row_result for select to hr_app using (hr.is_staff());
create policy import_flag_read on hr.import_flag for select to hr_app using (hr.is_staff());
create policy import_flag_insert on hr.import_flag for insert to hr_app with check (hr.is_staff());
create policy import_flag_update on hr.import_flag for update to hr_app using (hr.is_staff()) with check (hr.is_staff());
create policy device_clock_read on hr.device_clock_adjustment for select to hr_app using (hr.is_staff());
create policy punch_mapping_read on hr.punch_mapping for select to hr_app using (hr.is_staff());
create policy device_read on hr.device for select to hr_app using (hr.current_auth_user() is not null);
-- raw punches: staff, or the employee/manager whose attendance day uses them
create policy raw_punch_read on hr.raw_punch for select to hr_app using (
  hr.is_staff() or exists (
    select 1 from hr.attendance_day_punch adp join hr.attendance_day d on d.id = adp.attendance_day_id
    where adp.raw_punch_id = raw_punch.id));
create policy day_punch_read on hr.attendance_day_punch for select to hr_app using (
  exists (select 1 from hr.attendance_day d where d.id = attendance_day_id));

-- ---- Files & documents: staff + owning employee only ----
create policy file_read on hr.file_reference for select to hr_app
  using (hr.is_staff() or hr.is_self(owner_employee_id)
         or (hr.is_auditor() and bucket = 'payment-evidence'));
create policy file_insert on hr.file_reference for insert to hr_app
  with check (uploaded_by = hr.current_auth_user()
              and (hr.is_staff() or (hr.is_self(owner_employee_id) and bucket = 'employee-documents')));
create policy doc_version_read on hr.document_version for select to hr_app
  using (exists (select 1 from hr.employee_document d where d.id = document_id));
create policy doc_version_insert on hr.document_version for insert to hr_app
  with check (uploaded_by = hr.current_auth_user() and exists (
    select 1 from hr.employee_document d where d.id = document_id and (hr.is_staff() or hr.is_self(d.employee_id))));
create policy doc_review_read on hr.document_review for select to hr_app
  using (exists (select 1 from hr.document_version v where v.id = document_version_id));

-- ---- Payroll: staff; employee sees own line only once LOCKED & real ----
create policy payroll_run_read on hr.payroll_run for select to hr_app using (hr.is_staff() or hr.is_auditor());
create policy payroll_line_read on hr.payroll_line for select to hr_app using (
  hr.is_staff()
  or (hr.is_self(employee_id) and exists (
        select 1 from hr.payroll_run r where r.id = run_id and not r.is_sandbox
          and r.status in ('locked', 'paid', 'partially_paid'))));
create policy payroll_approval_read on hr.payroll_approval for select to hr_app using (hr.is_staff() or hr.is_auditor());
create policy payroll_approval_insert on hr.payroll_approval for insert to hr_app with check (hr.is_admin());
create policy payroll_snapshot_read on hr.payroll_snapshot for select to hr_app using (hr.is_admin() or hr.is_auditor());
create policy payroll_payable_read on hr.payroll_payable for select to hr_app using (hr.is_admin() or hr.is_auditor());
create policy payslip_read on hr.payslip_reference for select to hr_app using (hr.is_staff() or hr.is_self(employee_id));

-- ---- Payment & reconciliation: Admin + Auditor read; Admin writes ----
do $$
declare t text;
begin
  foreach t in array array['payment_instruction', 'payment_transaction', 'payment_evidence',
    'reconciliation', 'reconciliation_variance'] loop
    execute format('create policy money_read on hr.%I for select to hr_app using (hr.is_admin() or hr.is_auditor())', t);
  end loop;
  foreach t in array array['payment_instruction', 'payment_transaction', 'payment_evidence'] loop
    execute format('create policy money_insert on hr.%I for insert to hr_app with check (hr.is_admin())', t);
  end loop;
end $$;
create policy recon_signoff on hr.reconciliation for update to hr_app using (hr.is_admin()) with check (hr.is_admin());

-- ---- Final settlement components ----
create policy fs_component_read on hr.final_settlement_component for select to hr_app using (
  exists (select 1 from hr.final_settlement s where s.id = settlement_id));

-- ---- Audit: Admin + Auditor only ----
create policy audit_read on hr.audit_event for select to hr_app using (hr.is_admin() or hr.is_auditor());

-- ---- Roles: Admin manages; everyone sees their own ----
create policy user_role_read on hr.user_role for select to hr_app
  using (hr.is_admin() or auth_user_id = hr.current_auth_user());
create policy user_role_write on hr.user_role for insert to hr_app
  with check (hr.is_admin() and granted_by = hr.current_auth_user() and auth_user_id <> hr.current_auth_user());
create policy user_role_revoke on hr.user_role for update to hr_app using (hr.is_admin()) with check (hr.is_admin());

-- ---- Alerts & notifications ----
create policy alert_read on hr.lifecycle_alert for select to hr_app using (hr.is_staff());
create policy alert_ack on hr.lifecycle_alert for update to hr_app using (hr.is_admin()) with check (hr.is_admin());
create policy notification_own on hr.notification for select to hr_app using (recipient_auth_user_id = hr.current_auth_user());
create policy notification_mark_read on hr.notification for update to hr_app
  using (recipient_auth_user_id = hr.current_auth_user()) with check (recipient_auth_user_id = hr.current_auth_user());
