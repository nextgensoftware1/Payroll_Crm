-- =====================================================================
-- 0016 EMPLOYEE SELF-SERVICE REQUESTS
--   * leave types (annual, sick, casual: paid; unpaid: deducted like absence)
--   * attendance_excuse: "I was late because..." and "I forgot to punch"
--     (a separate record; raw punches are never edited)
--   * hr.my_punches(): an employee reads ONLY their own punches
--   * notifications to Admins on a new request, and to the employee on a decision
-- Employee requests are never auto-approved: hr.auto_decide refuses
-- non-staff callers, and the app never calls it for these.
-- =====================================================================

insert into hr.leave_type (code, name, is_paid) values
  ('ANNUAL', 'Annual leave', true), ('SICK', 'Sick leave', true),
  ('CASUAL', 'Casual leave', true), ('UNPAID', 'Unpaid leave', false)
on conflict (code) do nothing;

create table hr.attendance_excuse (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  business_date       date not null,
  kind                text not null check (kind in ('late', 'missing_punch')),
  reason              text not null check (length(trim(reason)) >= 3),
  added_punch_local   timestamp,                 -- missing_punch: the time they say they clocked
  late_filing         boolean not null default false,  -- filed after the dispute window
  requested_by        uuid not null default hr.current_auth_user(),
  requested_at        timestamptz not null default now(),
  approval_request_id uuid not null unique references hr.approval_request(id),
  check (kind <> 'missing_punch' or added_punch_local is not null)
);
create index attendance_excuse_lookup on hr.attendance_excuse (employee_id, business_date);
create trigger attendance_excuse_immutable before update or delete on hr.attendance_excuse
  for each row execute function hr.forbid_mutation();
create trigger attendance_excuse_audit after insert on hr.attendance_excuse
  for each row execute function hr.audit_row();
alter table hr.attendance_excuse enable row level security;
grant select, insert on hr.attendance_excuse to hr_app;
grant select on hr.attendance_excuse to hr_worker;
create policy excuse_read on hr.attendance_excuse for select to hr_app using (hr.can_view_employee(employee_id));
create policy excuse_insert on hr.attendance_excuse for insert to hr_app
  with check (hr.is_self(employee_id) and requested_by = hr.current_auth_user());
create policy worker_all on hr.attendance_excuse to hr_worker using (true) with check (true);

-- An employee's OWN punches (local device time) in a window. Nobody else's.
create function hr.my_punches(p_from timestamp, p_to timestamp) returns table (ts timestamp)
language sql stable security definer set search_path = '' as $$
  select p.device_local_ts from hr.raw_punch p
  join hr.punch_mapping pm on pm.device_id = p.device_id and pm.enrollment_no = p.enrollment_no
       and pm.status = 'approved' and pm.valid_during @> p.device_local_ts::date
  where pm.employee_id = hr.current_employee_id()
    and p.device_local_ts >= p_from and p.device_local_ts < p_to
    and not exists (select 1 from hr.attendance_correction c where c.target_raw_punch_id = p.id
                    and c.kind = 'disregard_punch' and hr.is_approved(c.approval_request_id))
  order by 1
$$;
grant execute on function hr.my_punches(timestamp, timestamp) to hr_app;

-- New request -> every real Admin's bell. Only for the caller's own request.
create function hr.notify_admins_of_request(p_request uuid, p_title text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from hr.approval_request where id = p_request and requested_by = hr.current_auth_user()) then
    raise exception 'can only announce your own request';
  end if;
  insert into hr.notification (recipient_auth_user_id, kind, subject_table, subject_id, title, body)
  select ra.auth_user_id, 'request', 'approval_request', p_request, p_title, p_body from hr.real_admins ra;
end $$;
grant execute on function hr.notify_admins_of_request(uuid, text, text) to hr_app;

-- Decision -> the requester's bell. Only once the request is decided.
create function hr.notify_requester(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select ar.requested_by, ar.status::text as status, ar.kind::text as kind, d.reason
    into r from hr.approval_request ar join hr.approval_decision d on d.approval_request_id = ar.id where ar.id = p_request;
  if not found or r.status = 'pending' then return; end if;
  if r.requested_by in (hr.system_actor(), hr.import_actor()) then return; end if;
  insert into hr.notification (recipient_auth_user_id, kind, subject_table, subject_id, title, body)
  values (r.requested_by, 'decision', 'approval_request', p_request,
          'Your ' || case r.kind when 'leave' then 'leave request' else 'attendance request' end || ' was ' || r.status,
          coalesce(r.reason, ''));
end $$;
grant execute on function hr.notify_requester(uuid) to hr_app;

-- Is a period's payroll final (locked/paid)? Readable by employees for request checks.
create function hr.period_is_locked(p_period uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hr.payroll_run r where r.period_id = p_period and not r.is_sandbox
                 and r.status in ('locked', 'paid', 'partially_paid'))
$$;
grant execute on function hr.period_is_locked(uuid) to hr_app;

-- An employee may see WHO their manager is (name only), not the manager's record.
create function hr.my_manager_name() returns text
language sql stable security definer set search_path = '' as $$
  select me.full_name from hr.manager_assignment ma join hr.employee me on me.id = ma.manager_employee_id
  where ma.employee_id = hr.current_employee_id() and ma.valid_during @> (now() at time zone 'Asia/Karachi')::date limit 1
$$;
grant execute on function hr.my_manager_name() to hr_app;

-- Is a month's payroll final? (for hiding request buttons on locked months)
create function hr.month_is_locked(p_month date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hr.payroll_period pp where pp.period_month = date_trunc('month', p_month)::date and hr.period_is_locked(pp.id))
$$;
grant execute on function hr.month_is_locked(date) to hr_app;
