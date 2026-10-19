-- =====================================================================
-- 0014 FIX: people created automatically by an import got the 1st of the
-- month as their joining date, so a new hire starting on the 17th was
-- marked absent for the 1st to the 16th. Use their first punch date.
-- (Found by the realistic-company simulation.)
-- =====================================================================
create or replace function hr.auto_setup_batch(p_batch uuid) returns int
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
           min(r.device_local_ts)::date as first_day
    from hr.raw_import_row r
    where r.batch_id = p_batch and r.parse_status = 'ok'
      and not exists (select 1 from hr.punch_mapping pm where pm.device_id = b.device_id
                      and pm.enrollment_no = r.enrollment_no and pm.status in ('approved', 'proposed'))
    group by r.enrollment_no
  loop
    v_join := p.first_day; -- FIX: their first punch, not the 1st of the month
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

