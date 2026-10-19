-- =====================================================================
-- 0012 SINGLE-ADMIN MODE (owner decision 2026-10-19)
--
-- With the flag ON:
--   * every approval request is decided automatically by a SYSTEM actor
--     (00..a070), so one Admin can run the company alone
--   * each uploaded attendance file is accepted automatically after it is
--     read; flags are kept, marked "auto-accepted"
--   * enrollment numbers seen for the first time become employees
--     automatically (name from the file, shift suggested from their punches)
--
-- What does NOT change:
--   * every automatic step is a normal row: approval_request + decision,
--     import_flag resolution, audit_event; nothing is hidden or deleted
--   * raw punches stay immutable; duplicate protection is unchanged
--   * payroll/payment execution and the old late-deduction type stay locked
--
-- Turn it off (restore two-person approval) with, as the owner:
--   update hr.feature_flag set enabled = false where key = 'single_admin_mode';
-- =====================================================================

insert into hr.feature_flag (key, enabled, description) values
  ('single_admin_mode', true,
   'Owner decision 2026-10-19: approvals are recorded automatically by the System actor; uploads are auto-accepted; new people are auto-created. Turn off to restore two-person approval.');

-- System identities (no Supabase login exists for them: they cannot sign in).
--   a070 = decides automatically   a071 = requests on behalf of the import job
insert into hr.user_role (auth_user_id, role, granted_by, grant_reason, valid_during) values
  ('00000000-0000-0000-0000-00000000a070', 'admin', '00000000-0000-0000-0000-00000000a071',
   'System actor: records automatic approvals in single-admin mode. Cannot sign in.', daterange('2020-01-01', null));

create function hr.system_actor() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00000000a070'::uuid $$;
create function hr.import_actor() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00000000a071'::uuid $$;

-- ---------------------------------------------------------------------
-- Decide a request automatically. Runs the normal decision trigger, so
-- kind-specific guards (e.g. the locked late-deduction type) still apply.
-- ---------------------------------------------------------------------
create function hr.auto_decide(p_request uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_claims text := current_setting('request.jwt.claims', true);
begin
  if not hr.flag_enabled('single_admin_mode') then
    raise exception 'single-admin mode is off: a second Admin must decide this request';
  end if;
  -- signed-in callers must be HR/Admin; background jobs have no claims
  if coalesce(v_claims, '') <> '' and not hr.is_staff() then
    raise exception 'only HR/Admin actions are approved automatically';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', hr.system_actor(), 'role', 'authenticated')::text, true);
  insert into hr.approval_decision (approval_request_id, decision, reason)
  values (p_request, 'approved', 'Auto-approved (single-admin mode): ' || coalesce(nullif(trim(p_reason), ''), 'no reason given'));
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end $$;

-- ---------------------------------------------------------------------
-- Accept an imported batch automatically (after the worker has read it).
-- ---------------------------------------------------------------------
create function hr.auto_accept_batch(p_batch uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not hr.flag_enabled('single_admin_mode') then return false; end if;
  update hr.import_flag set status = 'accepted_as_is', resolution_note = 'Auto-accepted (single-admin mode)',
         resolved_by = hr.system_actor(), resolved_at = now()
   where batch_id = p_batch and status = 'open';
  update hr.attendance_import_batch set status = 'accepted', reviewed_by = hr.system_actor(), reviewed_at = now(),
         review_note = 'Auto-accepted (single-admin mode)'
   where id = p_batch and status = 'under_review';
  return found;
end $$;

-- Same shift/calendar codes the app uses (N17 = 5 PM to 2 AM, Mon-Fri).
create function hr.ensure_shift_calendar(p_hour int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_code text := 'N' || lpad(p_hour::text, 2, '0'); v_cal uuid; v_name text;
begin
  v_name := to_char(make_time(p_hour, 0, 0), 'FMHH12 AM') || ' to ' || to_char(make_time((p_hour + 9) % 24, 0, 0), 'FMHH12 AM');
  insert into hr.shift (code, name, start_local, end_local, unpaid_break_minutes, clock_in_window_before_minutes, clock_out_window_after_minutes)
  values (v_code, v_name, make_time(p_hour, 0, 0), make_time((p_hour + 9) % 24, 0, 0), 0, 180, 240)
  on conflict (code) do nothing;
  insert into hr.work_calendar (code, name) values ('MF-' || v_code, 'Mon-Fri, ' || v_name) on conflict (code) do nothing;
  select id into v_cal from hr.work_calendar where code = 'MF-' || v_code;
  insert into hr.work_calendar_rule (calendar_id, iso_weekday, shift_id, valid_during)
  select v_cal, d, case when d <= 5 then s.id end, daterange('2020-01-01', null)
  from hr.shift s, generate_series(1, 7) d
  where s.code = v_code and not exists (select 1 from hr.work_calendar_rule r where r.calendar_id = v_cal);
  return v_cal;
end $$;

-- ---------------------------------------------------------------------
-- Create employees for enrollment numbers this device has never linked.
-- Name from the file; shift = median first punch after 12:00, rounded to
-- the hour (needs 3+ days, otherwise no shift and HR sets it).
-- ---------------------------------------------------------------------
create function hr.auto_setup_batch(p_batch uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  b record; p record; v_emp uuid; v_code text; v_req uuid; v_map uuid; v_dept uuid; v_join date; v_hour int; v_n int := 0;
begin
  if not hr.flag_enabled('single_admin_mode') then return 0; end if;
  select * into b from hr.attendance_import_batch where id = p_batch;
  if not found then return 0; end if;
  insert into hr.department (code, name) values ('OPS', 'Operations') on conflict (code) do nothing;
  select id into v_dept from hr.department where code = 'OPS';

  for p in
    select r.enrollment_no, mode() within group (order by r.name_seen) as name_seen,
           date_trunc('month', min(r.device_local_ts))::date as month_start
    from hr.raw_import_row r
    where r.batch_id = p_batch and r.parse_status = 'ok'
      and not exists (select 1 from hr.punch_mapping pm where pm.device_id = b.device_id
                      and pm.enrollment_no = r.enrollment_no and pm.status in ('approved', 'proposed'))
    group by r.enrollment_no
  loop
    v_join := p.month_start;
    v_code := 'EN-' || lpad(p.enrollment_no, 4, '0');
    if exists (select 1 from hr.employee where employee_code = v_code) then
      v_code := v_code || '-' || upper(substr(md5(b.device_id::text || p.enrollment_no), 1, 4));
    end if;
    insert into hr.employee (employee_code, full_name, employment_category, joining_date, created_by)
    values (v_code, coalesce(nullif(trim(p.name_seen), ''), 'Enrollment ' || p.enrollment_no), 'fixed_monthly', v_join, hr.import_actor())
    returning id into v_emp;
    insert into hr.employee_assignment (employee_id, department_id, job_title, valid_during, created_by)
    values (v_emp, v_dept, 'Agent', daterange(v_join, null), hr.import_actor());
    insert into hr.employment_contract (series_id, revision_no, employee_id, contract_start, action, reason, effective_date, created_by)
    values (gen_random_uuid(), 1, v_emp, v_join, 'initial', 'Created automatically from an attendance import', v_join, hr.import_actor());

    select round(percentile_cont(0.5) within group (order by h))::int into v_hour from (
      select min(extract(hour from device_local_ts) + extract(minute from device_local_ts) / 60.0) as h
      from hr.raw_import_row
      where batch_id = p_batch and parse_status = 'ok' and enrollment_no = p.enrollment_no and extract(hour from device_local_ts) >= 12
      group by device_local_ts::date) x
    having count(*) >= 3;
    if v_hour is not null then
      insert into hr.employee_calendar_assignment (employee_id, calendar_id, valid_during, created_by)
      values (v_emp, hr.ensure_shift_calendar(v_hour % 24), daterange(v_join, null), hr.import_actor());
    end if;

    v_map := gen_random_uuid();
    insert into hr.approval_request (kind, subject_table, subject_id, subject_employee_id, required_role, requested_by, reason)
    values ('punch_mapping', 'punch_mapping', v_map, v_emp, 'admin', hr.import_actor(),
            'Enrollment ' || p.enrollment_no || ' first seen in import ' || b.original_filename)
    returning id into v_req;
    insert into hr.punch_mapping (id, device_id, enrollment_no, employee_id, expected_name, valid_during, approval_request_id, created_by)
    values (v_map, b.device_id, p.enrollment_no, v_emp, coalesce(p.name_seen, ''), daterange(v_join, null), v_req, hr.import_actor());
    perform hr.auto_decide(v_req, 'new enrollment number from an import');
    update hr.punch_mapping set status = 'approved' where id = v_map;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function hr.auto_decide(uuid, text), hr.auto_accept_batch(uuid), hr.auto_setup_batch(uuid), hr.ensure_shift_calendar(int) from public;
grant execute on function hr.auto_decide(uuid, text), hr.system_actor(), hr.import_actor() to hr_app, hr_worker;
grant execute on function hr.auto_accept_batch(uuid), hr.auto_setup_batch(uuid), hr.ensure_shift_calendar(int) to hr_worker;

-- ---------------------------------------------------------------------
-- Activate rules that are still waiting (owner decision), where no
-- approved row for the same setting overlaps.
-- ---------------------------------------------------------------------
do $$
declare r record; v uuid;
begin
  for r in
    select pc.* from hr.policy_config pc
    where pc.status = 'proposed' and not pc.pending_legal_review
      and not exists (select 1 from hr.policy_config a where a.key = pc.key and a.status = 'approved' and a.valid_during && pc.valid_during)
  loop
    if r.approval_request_id is null then
      insert into hr.approval_request (kind, subject_table, subject_id, required_role, requested_by, reason, status, decided_at)
      values ('policy_config', 'policy_config', r.id, 'admin', hr.import_actor(), 'Owner decision 2026-10-19 (single-admin mode)', 'approved', now())
      returning id into v;
      update hr.policy_config set approval_request_id = v where id = r.id;
    else
      update hr.approval_request set status = 'approved', decided_at = now() where id = r.approval_request_id and status = 'pending';
    end if;
    update hr.policy_config set status = 'approved' where id = r.id;
  end loop;
end $$;

-- Alerts and "admins exist" checks ignore the system identities.
create or replace view hr.real_admins with (security_invoker = true) as
  select distinct auth_user_id from hr.user_role
  where role = 'admin' and revoked_at is null and auth_user_id not in (hr.system_actor(), hr.import_actor());
grant select on hr.real_admins to hr_app, hr_worker;
