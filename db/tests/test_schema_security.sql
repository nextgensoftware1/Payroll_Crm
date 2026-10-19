-- =====================================================================
-- Schema-level acceptance tests. Run against a scratch DB after all
-- migrations:  psql -v ON_ERROR_STOP=1 -f tests/test_schema_security.sql
-- Each block raises 'FAIL ...' on failure; prints 'PASS ...' otherwise.
-- Fixture rows use real punches from AUGUST_ATTANADANCE.xls.
-- =====================================================================
\set QUIET on
set client_min_messages = notice;

-- ---------- helpers ----------
create schema if not exists t;
create or replace function t.act_as(p uuid) returns void language sql as
$$ select set_config('request.jwt.claims', json_build_object('sub', p)::text, false) $$;
create or replace function t.expect_fail(p_label text, p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'PASS %: blocked (%)', p_label, sqlerrm;
    return;
  end;
  raise exception 'FAIL %: statement was allowed', p_label;
end $$;
create or replace function t.expect_count(p_label text, p_sql text, p_expected int) returns void language plpgsql as $$
declare n int;
begin
  execute 'select count(*) from (' || p_sql || ') q' into n;
  if n <> p_expected then raise exception 'FAIL %: expected % rows, got %', p_label, p_expected, n; end if;
  raise notice 'PASS %: % row(s)', p_label, n;
end $$;
grant usage on schema t to hr_app, hr_worker, authenticated;
grant execute on all functions in schema t to hr_app, hr_worker, authenticated;

-- ---------- fixture (as owner) ----------
-- auth users: a1/a2 admins, b1 HR, c1 manager, e1/e2 employees, d1 auditor
insert into hr.user_role (auth_user_id, role, granted_by, grant_reason) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin',    '00000000-0000-0000-0000-0000000000a2', 'fixture'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin',    '00000000-0000-0000-0000-0000000000a1', 'fixture'),
  ('00000000-0000-0000-0000-0000000000b1', 'hr',       '00000000-0000-0000-0000-0000000000a1', 'fixture'),
  ('00000000-0000-0000-0000-0000000000c1', 'manager',  '00000000-0000-0000-0000-0000000000a1', 'fixture'),
  ('00000000-0000-0000-0000-0000000000c1', 'employee', '00000000-0000-0000-0000-0000000000a1', 'fixture'),
  ('00000000-0000-0000-0000-0000000000e1', 'employee', '00000000-0000-0000-0000-0000000000a1', 'fixture'),
  ('00000000-0000-0000-0000-0000000000e2', 'employee', '00000000-0000-0000-0000-0000000000a1', 'fixture'),
  ('00000000-0000-0000-0000-0000000000d1', 'auditor',  '00000000-0000-0000-0000-0000000000a1', 'fixture');

insert into hr.employee (id, employee_code, full_name, employment_category, joining_date, auth_user_id) values
  ('10000000-0000-0000-0000-0000000000c1', 'EN-0003', 'Muhammad Shoaib', 'fixed_monthly', '2025-01-01', '00000000-0000-0000-0000-0000000000c1'),
  ('10000000-0000-0000-0000-0000000000e1', 'EN-0001', 'Moon',            'fixed_monthly', '2025-03-01', '00000000-0000-0000-0000-0000000000e1'),
  ('10000000-0000-0000-0000-0000000000e2', 'EN-0027', 'Sibtain',         'fixed_monthly', '2025-06-01', '00000000-0000-0000-0000-0000000000e2');
insert into hr.manager_assignment (employee_id, manager_employee_id, valid_during) values
  ('10000000-0000-0000-0000-0000000000e1', '10000000-0000-0000-0000-0000000000c1', daterange('2025-01-01', null));

insert into hr.shift (id, code, name, start_local, end_local, unpaid_break_minutes,
                      clock_in_window_before_minutes, clock_out_window_after_minutes)
  values ('20000000-0000-0000-0000-000000000001', 'NIGHT-5P', 'Night 17:00-02:00 (fixture)', '17:00', '02:00', 60, 180, 240);
insert into hr.work_calendar (id, code, name) values ('21000000-0000-0000-0000-000000000001', 'MON-FRI-NIGHT', 'Mon-Fri night');
insert into hr.work_calendar_rule (calendar_id, iso_weekday, shift_id, valid_during)
  select '21000000-0000-0000-0000-000000000001', d, case when d <= 5 then '20000000-0000-0000-0000-000000000001'::uuid end,
         daterange('2025-01-01', null) from generate_series(1, 7) d;
insert into hr.employee_calendar_assignment (employee_id, calendar_id, valid_during)
  select id, '21000000-0000-0000-0000-000000000001', daterange('2025-01-01', null) from hr.employee;

insert into hr.document_category (id, code, name, sensitivity) values
  ('30000000-0000-0000-0000-000000000001', 'CNIC', 'CNIC copy', 'highly_sensitive');
insert into hr.employee_document (employee_id, category_id, status) values
  ('10000000-0000-0000-0000-0000000000e1', '30000000-0000-0000-0000-000000000001', 'accepted'),
  ('10000000-0000-0000-0000-0000000000e2', '30000000-0000-0000-0000-000000000001', 'uploaded');

insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, requested_by, reason, status) values
  ('40000000-0000-0000-0000-000000000001', 'bank_detail_change', 'employee_payment_detail',
   '41000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000b1', 'fixture', 'pending');
insert into hr.employee_payment_detail (id, employee_id, bank_name, account_title, iban_ciphertext, iban_last4, approval_request_id) values
  ('41000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e2', 'Fixture Bank', 'Sibtain',
   '\xdeadbeef', '1234', '40000000-0000-0000-0000-000000000001');

insert into storage.objects (bucket_id, name) values
  ('employee-documents', '10000000-0000-0000-0000-0000000000e1/doc/v1-aaa.pdf'),
  ('employee-documents', '10000000-0000-0000-0000-0000000000e2/doc/v1-bbb.pdf');

-- Device as found in the sample: Location ID 101, M/D/YYYY 12-hour, C/In / C/Out
insert into hr.device (id, name, location_code, datetime_format, status_label_map)
  values ('50000000-0000-0000-0000-000000000001', 'Main entrance', '101', 'M/D/YYYY h:mm:ss AM', '{"C/In":"in","C/Out":"out"}');

\echo '--- A. Cross-employee isolation (acceptance test 9) ---'
set role hr_app;
select t.act_as('00000000-0000-0000-0000-0000000000e1');
select t.expect_count('employee sees only self in register', 'select * from hr.employee', 1);
select t.expect_count('employee cannot fetch another employee by id',
  $$select * from hr.employee where id = '10000000-0000-0000-0000-0000000000e2'$$, 0);
select t.expect_count('employee cannot see other''s documents',
  $$select * from hr.employee_document where employee_id = '10000000-0000-0000-0000-0000000000e2'$$, 0);
select t.expect_count('employee cannot see other''s bank detail', 'select * from hr.employee_payment_detail', 0);
select t.expect_count('employee cannot see other''s bank detail via masked view', 'select * from hr.employee_payment_detail_masked', 0);
select t.expect_count('employee cannot read audit log', 'select * from hr.audit_event', 0);
select t.expect_count('employee cannot read raw import rows', 'select * from hr.raw_import_row', 0);

select t.act_as('00000000-0000-0000-0000-0000000000c1');
select t.expect_count('manager sees self + direct report only', 'select * from hr.employee', 2);
select t.expect_count('manager cannot see report''s documents (sensitive)',
  $$select * from hr.employee_document where employee_id = '10000000-0000-0000-0000-0000000000e1'$$, 0);

select t.act_as('00000000-0000-0000-0000-0000000000b1');
select t.expect_count('HR sees whole register', 'select * from hr.employee', 3);
select t.expect_count('HR sees bank detail (ciphertext only)', 'select * from hr.employee_payment_detail', 1);
reset role;

-- Supabase Storage path policy
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000e1');
select t.expect_count('storage: employee lists only own folder', $$select * from storage.objects where bucket_id = 'employee-documents'$$, 1);
reset role;

\echo '--- B. Insert-only and never-delete (hard constraints 3, 4) ---'
-- worker imports two rows so there is something to attack
set role hr_worker;
select t.act_as('00000000-0000-0000-0000-0000000000b1');
reset role;
insert into hr.file_reference (id, bucket, object_path, sha256, size_bytes, mime_type, original_filename, uploaded_by)
  values ('60000000-0000-0000-0000-000000000001', 'attendance-imports', 'b1/aug.xls', sha256('aug-file'), 82406,
          'application/vnd.ms-excel', 'AUGUST_ATTANADANCE.xls', '00000000-0000-0000-0000-0000000000b1'),
         ('60000000-0000-0000-0000-000000000002', 'attendance-imports', 'b2/sep.xls', sha256('sep-file'), 90000,
          'application/vnd.ms-excel', 'SEPTEMBER.xls', '00000000-0000-0000-0000-0000000000b1');
insert into hr.attendance_import_batch (id, device_id, declared_extension, file_reference_id, file_sha256, original_filename, uploaded_by)
  values ('61000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '.xls',
          '60000000-0000-0000-0000-000000000001', sha256('aug-file'), 'AUGUST_ATTANADANCE.xls', '00000000-0000-0000-0000-0000000000b1');

set role hr_worker;
-- Real rows: Moon 8/11 (two consecutive C/In) and Sibtain's 1-second double press
insert into hr.raw_import_row (batch_id, row_number, raw_cells, parse_status, enrollment_no, name_seen, device_local_ts, status_label_raw, direction_label, verify_method, location_code)
values
 ('61000000-0000-0000-0000-000000000001', 10, '["This Company","Moon","1","8/11/2026 3:09:01 AM","C/Out","101","","0","FP",""]', 'ok', '1', 'Moon', '2026-08-11 03:09:01', 'C/Out', 'out', 'FP', '101'),
 ('61000000-0000-0000-0000-000000000001', 11, '["This Company","Moon","1","8/11/2026 4:57:21 PM","C/In","101","","0","FP",""]',  'ok', '1', 'Moon', '2026-08-11 16:57:21', 'C/In',  'in',  'FP', '101'),
 ('61000000-0000-0000-0000-000000000001', 12, '["This Company","Moon","1","8/11/2026 10:49:58 PM","C/In","101","","0","FP",""]', 'ok', '1', 'Moon', '2026-08-11 22:49:58', 'C/In',  'in',  'FP', '101'),
 ('61000000-0000-0000-0000-000000000001', 248, '["This Company","Sibtain","27","8/4/2026 6:10:44 PM","C/In","101","","0","FP",""]', 'ok', '27', 'Sibtain', '2026-08-04 18:10:44', 'C/In', 'in', 'FP', '101'),
 ('61000000-0000-0000-0000-000000000001', 249, '["This Company","Sibtain","27","8/4/2026 6:10:45 PM","C/In","101","","0","FP",""]', 'ok', '27', 'Sibtain', '2026-08-04 18:10:45', 'C/In', 'in', 'FP', '101');

-- promotion (what the worker does when the batch is accepted)
insert into hr.raw_punch (device_id, enrollment_no, device_local_ts, status_label_raw, direction_label, punch_at, verify_method, first_seen_row_id)
select b.device_id, r.enrollment_no, r.device_local_ts, r.status_label_raw, r.direction_label,
       r.device_local_ts at time zone 'Asia/Karachi', r.verify_method, r.id
from hr.raw_import_row r join hr.attendance_import_batch b on b.id = r.batch_id
where r.batch_id = '61000000-0000-0000-0000-000000000001' and r.parse_status = 'ok'
on conflict on constraint raw_punch_idempotency do nothing;
reset role;
select t.expect_count('first import promotes 5 punches (near-dup kept, not discarded)', 'select * from hr.raw_punch', 5);

set role hr_app;
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select t.expect_fail('admin cannot UPDATE a raw punch', $$update hr.raw_punch set device_local_ts = device_local_ts + interval '1 hour'$$);
select t.expect_fail('admin cannot DELETE a raw punch', 'delete from hr.raw_punch');
select t.expect_fail('admin cannot DELETE an employee', 'delete from hr.employee');
select t.expect_fail('admin cannot UPDATE audit_event', 'update hr.audit_event set note = $q$x$q$');
select t.expect_fail('admin cannot rewrite batch evidence (sha256)', $$update hr.attendance_import_batch set file_sha256 = sha256('forged')$$);
select t.expect_fail('API cannot flip a feature flag', 'update hr.feature_flag set enabled = true');
reset role;
select t.expect_fail('even the owner cannot UPDATE a raw punch (trigger backstop)', 'update hr.raw_punch set enrollment_no = $q$99$q$');
select t.expect_fail('even the owner cannot store payment_execution = on', $$update hr.feature_flag set enabled = true where key = 'payment_execution'$$);
select t.expect_fail('even the owner cannot store tax_calculation = on', $$update hr.feature_flag set enabled = true where key = 'tax_calculation'$$);
select t.expect_fail('even the owner cannot TRUNCATE raw_punch', 'truncate hr.raw_punch cascade');

\echo '--- C. Re-import idempotency (acceptance test 3) ---'
select t.expect_fail('same file bytes cannot open a second live batch',
  $$insert into hr.attendance_import_batch (device_id, declared_extension, file_reference_id, file_sha256, original_filename, uploaded_by)
    values ('50000000-0000-0000-0000-000000000001', '.xls', '60000000-0000-0000-0000-000000000002', sha256('aug-file'),
            'copy.xls', '00000000-0000-0000-0000-0000000000b1')$$);
-- a DIFFERENT file (e.g. a September export) that overlaps the same August punches
insert into hr.attendance_import_batch (id, device_id, declared_extension, file_reference_id, file_sha256, original_filename, uploaded_by)
  values ('61000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '.xls',
          '60000000-0000-0000-0000-000000000002', sha256('sep-file'), 'SEPTEMBER.xls', '00000000-0000-0000-0000-0000000000b1');
set role hr_worker;
insert into hr.raw_import_row (batch_id, row_number, raw_cells, parse_status, enrollment_no, name_seen, device_local_ts, status_label_raw, direction_label, verify_method)
select '61000000-0000-0000-0000-000000000002', row_number, raw_cells, parse_status, enrollment_no, name_seen, device_local_ts, status_label_raw, direction_label, verify_method
from hr.raw_import_row where batch_id = '61000000-0000-0000-0000-000000000001';
with ins as (
  insert into hr.raw_punch (device_id, enrollment_no, device_local_ts, status_label_raw, direction_label, punch_at, verify_method, first_seen_row_id)
  select b.device_id, r.enrollment_no, r.device_local_ts, r.status_label_raw, r.direction_label,
         r.device_local_ts at time zone 'Asia/Karachi', r.verify_method, r.id
  from hr.raw_import_row r join hr.attendance_import_batch b on b.id = r.batch_id
  where r.batch_id = '61000000-0000-0000-0000-000000000002'
  on conflict on constraint raw_punch_idempotency do nothing returning 1)
select count(*) as newly_inserted_on_reimport from ins;
reset role;
select t.expect_count('re-import inserted zero new punches', 'select * from hr.raw_punch', 5);
select t.expect_count('both batches keep every raw row as evidence', 'select * from hr.raw_import_row', 10);
select t.expect_count('stored UTC = Karachi 03:09 minus 5h', $$select * from hr.raw_punch where punch_at = '2026-08-10 22:09:01+00'$$, 1);

\echo '--- D. Approvals: role + segregation of duties ---'
set role hr_app;
select t.act_as('00000000-0000-0000-0000-0000000000b1');
select t.expect_fail('HR cannot approve its own bank-detail request',
  $$insert into hr.approval_decision (approval_request_id, decision, reason) values ('40000000-0000-0000-0000-000000000001', 'approved', 'ok')$$);
select t.act_as('00000000-0000-0000-0000-0000000000a1');
insert into hr.approval_request (id, kind, subject_table, subject_id, reason)
  values ('40000000-0000-0000-0000-000000000002', 'policy_config', 'policy_config', gen_random_uuid(), 'admin self-test');
select t.expect_fail('admin cannot approve own request',
  $$insert into hr.approval_decision (approval_request_id, decision, reason) values ('40000000-0000-0000-0000-000000000002', 'approved', 'mine')$$);
select t.act_as('00000000-0000-0000-0000-0000000000b1');
select t.expect_fail('HR cannot decide an Admin-level request raised by someone else',
  $$insert into hr.approval_decision (approval_request_id, decision, reason) values ('40000000-0000-0000-0000-000000000002', 'approved', 'not mine')$$);
select t.act_as('00000000-0000-0000-0000-0000000000a1');
insert into hr.approval_decision (approval_request_id, decision, reason) values ('40000000-0000-0000-0000-000000000001', 'approved', 'bank letter checked');
select t.expect_fail('a decided request cannot be decided again',
  $$insert into hr.approval_decision (approval_request_id, decision, reason) values ('40000000-0000-0000-0000-000000000001', 'rejected', 'changed mind')$$);
insert into hr.policy_config (id, key, value, valid_during, source_reference)
  values ('43000000-0000-0000-0000-000000000001', 'test.unapproved_rule', '1', daterange('2030-01-01', null), 'test');
select t.expect_fail('policy config cannot be approved without an approved request',
  $$update hr.policy_config set status = 'approved' where id = '43000000-0000-0000-0000-000000000001'$$);
reset role;

\echo '--- E. Late deduction is unapprovable (hard constraint 2, test 11) ---'
insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, requested_by, reason)
  values ('40000000-0000-0000-0000-000000000003', 'deduction', 'deduction_proposal', '42000000-0000-0000-0000-000000000001',
          '10000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 'late x3');
insert into hr.deduction_proposal (id, employee_id, kind, applies_to_month, basis_explanation, proposed_by, approval_request_id)
  values ('42000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e1', 'late_arrival_hour', '2026-08-01',
          'three late days', '00000000-0000-0000-0000-0000000000b1', '40000000-0000-0000-0000-000000000003');
set role hr_app;
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select t.expect_fail('admin cannot approve a late-arrival deduction',
  $$insert into hr.approval_decision (approval_request_id, decision, reason) values ('40000000-0000-0000-0000-000000000003', 'approved', 'policy')$$);
reset role;

\echo '--- F. Payroll versioning (tests 5, 8, 11) ---'
insert into hr.payroll_period (id, period_month, starts_on, ends_on) values ('70000000-0000-0000-0000-000000000001', '2026-08-01', '2026-08-01', '2026-08-31');
set role hr_app;
select t.act_as('00000000-0000-0000-0000-0000000000b1');
-- payroll_execution is ON since migration 0013 (owner decision): real runs can be created
insert into hr.payroll_run (period_id, version, is_sandbox, engine_version) values ('70000000-0000-0000-0000-000000000001', 1, false, 'v0');
select t.expect_count('a real payroll run can now be created (payroll on)', $$select * from hr.payroll_run where not is_sandbox$$, 1);
insert into hr.payroll_run (id, period_id, version, is_sandbox, engine_version)
  values ('71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 1, true, 'sandbox-0');
-- Worked example from the brief: 60,000 / 26 x 17 = 39,230.77  (paisa: 6,000,000 x 17 / 26 = 3,923,076.9 -> 3,923,077)
insert into hr.payroll_line (run_id, employee_id, attendance_computation_ids, scheduled_days, eligible_days,
                             base_monthly_paisa, prorated_base_paisa, gross_paisa, total_deductions_paisa, net_paisa)
  values ('71000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e1', '{}', 26, 17,
          6000000, 3923077, 3923077, 0, 3923077);
update hr.payroll_run set status = 'under_review' where id = '71000000-0000-0000-0000-000000000001';
select t.expect_fail('lines frozen once under review',
  $$update hr.payroll_line set net_paisa = net_paisa + 100, gross_paisa = gross_paisa + 100$$);
select t.expect_fail('HR cannot approve payroll', $$insert into hr.payroll_approval (run_id, approved_line_count, approved_total_net_paisa, approved_content_hash, note)
  select '71000000-0000-0000-0000-000000000001', line_count, total_net_paisa, content_hash, 'x' from hr.payroll_run_fingerprint('71000000-0000-0000-0000-000000000001')$$);
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select t.expect_fail('admin approval with wrong total is refused', $$insert into hr.payroll_approval (run_id, approved_line_count, approved_total_net_paisa, approved_content_hash, note)
  select '71000000-0000-0000-0000-000000000001', line_count, total_net_paisa + 1, content_hash, 'x' from hr.payroll_run_fingerprint('71000000-0000-0000-0000-000000000001')$$);
insert into hr.payroll_approval (run_id, approved_line_count, approved_total_net_paisa, approved_content_hash, note)
  select '71000000-0000-0000-0000-000000000001', line_count, total_net_paisa, content_hash, 'v1 reviewed'
  from hr.payroll_run_fingerprint('71000000-0000-0000-0000-000000000001');
select hr.lock_payroll_run('71000000-0000-0000-0000-000000000001') is not null as locked;
select t.expect_fail('API cannot move a locked run directly',
  $$update hr.payroll_run set status = 'draft' where id = '71000000-0000-0000-0000-000000000001'$$);
select t.expect_fail('snapshot cannot be updated', $$update hr.payroll_snapshot set content = '{}'$$);
reset role;
insert into hr.approval_request (id, kind, subject_table, subject_id, requested_by, reason, status)
  values ('40000000-0000-0000-0000-000000000004', 'payroll_reopen', 'payroll_run', '71000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-0000000000b1', 'missed commission', 'pending');
set role hr_app;
select t.act_as('00000000-0000-0000-0000-0000000000a2');
insert into hr.approval_decision (approval_request_id, decision, reason) values ('40000000-0000-0000-0000-000000000004', 'approved', 'agreed');
select hr.reopen_payroll_run('71000000-0000-0000-0000-000000000001', 'missed commission', '40000000-0000-0000-0000-000000000004') is not null as reopened;
reset role;
select t.expect_count('reopen: v1 superseded, v2 draft, both kept',
  $$select * from hr.payroll_run where (version = 1 and status = 'superseded') or (version = 2 and status = 'draft')$$, 2);
select t.expect_count('reopen: original snapshot preserved', 'select * from hr.payroll_snapshot', 1);
select t.expect_fail('payment instruction cannot be created (payment_execution OFF)',
  $$insert into hr.payment_instruction (period_id, employee_id, run_id, amount_paisa, method)
    values ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000e1', '71000000-0000-0000-0000-000000000001', 100, 'cash')$$);

\echo '--- G. Audit chain integrity (test 10) ---'
do $$ begin
  if hr.verify_audit_chain() is not null then raise exception 'FAIL audit chain broken at %', hr.verify_audit_chain(); end if;
  raise notice 'PASS audit chain verifies over % events', (select count(*) from hr.audit_event);
end $$;

\echo '=== ALL SCHEMA TESTS PASSED ==='
