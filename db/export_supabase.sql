-- Generated from supabase/migrations by `npm run db:export`.
-- Run once on a fresh Supabase project as the database owner (postgres).
-- Do not run on a database where these migrations have already been applied.
-- This file contains the application schema and Supabase Storage setup only.
-- Login roles, initial Admin users, and development seed data are separate setup steps.
-- Source: supabase/migrations/20260101000001_foundation.sql
-- =====================================================================
-- 0001 FOUNDATION
-- Schema, database roles, identity helpers, tamper-evident audit log,
-- feature flags (payroll/payment/tax/late-deduction locked OFF),
-- effective-dated policy config, user roles, file references.
--
-- Conventions used in every later migration:
--   * all tables live in schema "hr" (NOT exposed through Supabase's Data
--     API; FastAPI is the only path in, and RLS is defence in depth)
--   * ids are uuid; timestamps are timestamptz (stored UTC)
--   * business dates are DATE values already resolved in Asia/Karachi
--   * money is BIGINT paisa, never float
--   * nothing is deleted: no DELETE grants anywhere + a trigger backstop
-- =====================================================================

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;  -- for no-overlap exclusion constraints

create schema hr;
comment on schema hr is 'Empire Networks HR & Attendance Control Centre. Not exposed via PostgREST.';

-- ---------------------------------------------------------------------
-- Database roles. NOLOGIN group roles only. Login roles and their
-- passwords are created out-of-band by the DB owner and are NEVER put in
-- a migration (hard constraint: never store credentials).
--   hr_app     : what FastAPI request handlers run as. RLS applies.
--   hr_worker  : the background import / nightly-alert worker.
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select from pg_roles where rolname = 'hr_app')    then create role hr_app nologin; end if;
  if not exists (select from pg_roles where rolname = 'hr_worker') then create role hr_worker nologin; end if;
end $$;

revoke all on schema hr from public;
grant usage on schema hr to hr_app, hr_worker;

-- ---------------------------------------------------------------------
-- Identity: who is acting? FastAPI verifies the Supabase JWT, then per
-- transaction runs:  SET LOCAL ROLE hr_app;
--                    SELECT set_config('request.jwt.claims', <claims json>, true);
-- This is the same mechanism PostgREST uses, so auth.uid()-style policies
-- behave identically from FastAPI, Supabase Storage, or a test harness,
-- and it works unchanged on Neon.
-- ---------------------------------------------------------------------
create function hr.current_auth_user() returns uuid
language plpgsql stable set search_path = '' as $$
declare v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '');
  if v is not null then
    return nullif(v::jsonb ->> 'sub', '')::uuid;
  end if;
  v := nullif(current_setting('request.jwt.claim.sub', true), '');   -- older Supabase style
  return v::uuid;
end $$;

-- ---------------------------------------------------------------------
-- Generic trigger functions
-- ---------------------------------------------------------------------
create function hr.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := hr.current_auth_user();
  return new;
end $$;

-- Backstop for insert-only tables. The primary control is GRANTs (no
-- UPDATE/DELETE granted); this trigger also stops the table owner and
-- migration scripts from mutating evidence by accident.
create function hr.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'hr.%: % is not permitted (insert-only evidence table)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end $$;

-- Backstop for "never hard-delete" on every other table.
create function hr.forbid_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'hr.%: hard delete is not permitted; change status instead', tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

-- ---------------------------------------------------------------------
-- AUDIT EVENT: insert-only, hash-chained (each row's hash covers the
-- previous row's hash), so deletion or editing of any row by someone with
-- raw DB access is detectable by re-walking the chain.
-- ---------------------------------------------------------------------
create table hr.audit_event (
  id                 bigint generated always as identity primary key,
  occurred_at        timestamptz not null default clock_timestamp(),
  table_name         text not null,
  record_id          text,
  action             text not null check (action in ('INSERT','UPDATE','DELETE','READ','EXPORT','APP')),
  actor_auth_user_id uuid,
  actor_db_role      text not null,
  request_id         text,
  old_row            jsonb,
  new_row            jsonb,
  note               text,
  prev_hash          bytea,
  row_hash           bytea not null
);
create index audit_event_record_idx on hr.audit_event (table_name, record_id);
create index audit_event_actor_idx  on hr.audit_event (actor_auth_user_id, occurred_at);

create function hr.append_audit(p_table text, p_record text, p_action text,
                                p_old jsonb, p_new jsonb, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_prev  bytea;
  v_actor uuid := hr.current_auth_user();
  v_req   text := nullif(current_setting('hr.request_id', true), '');
  v_now   timestamptz := clock_timestamp();
begin
  -- serialise the chain; volumes here are small (tens of users)
  perform pg_advisory_xact_lock(7203001);
  select row_hash into v_prev from hr.audit_event order by id desc limit 1;
  insert into hr.audit_event (occurred_at, table_name, record_id, action, actor_auth_user_id,
                              actor_db_role, request_id, old_row, new_row, note, prev_hash, row_hash)
  values (v_now, p_table, p_record, p_action, v_actor, session_user, v_req, p_old, p_new, p_note, v_prev,
          sha256(convert_to(concat_ws('|',
            encode(coalesce(v_prev, '\x'::bytea), 'hex'), v_now::text, p_table, coalesce(p_record, ''),
            p_action, coalesce(v_actor::text, ''), session_user,
            coalesce(p_old::text, ''), coalesce(p_new::text, ''), coalesce(p_note, '')), 'UTF8')));
end $$;
revoke all on function hr.append_audit(text, text, text, jsonb, jsonb, text) from public;

-- Row-change audit trigger attached to every material table.
create function hr.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform hr.append_audit(tg_table_name, to_jsonb(new) ->> 'id', 'INSERT', null, to_jsonb(new), null);
  elsif tg_op = 'UPDATE' then
    perform hr.append_audit(tg_table_name, to_jsonb(new) ->> 'id', 'UPDATE', to_jsonb(old), to_jsonb(new), null);
  else
    perform hr.append_audit(tg_table_name, to_jsonb(old) ->> 'id', 'DELETE', to_jsonb(old), null, null);
  end if;
  return null;
end $$;

-- App-level events: sensitive reads and exports (called by the API).
create function hr.log_access(p_table text, p_record text, p_action text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_action not in ('READ','EXPORT') then
    raise exception 'log_access only records READ or EXPORT';
  end if;
  perform hr.append_audit(p_table, p_record, p_action, null, null, p_note);
end $$;

-- Re-walk the hash chain. Returns the first id whose hash does not
-- verify (NULL = intact). Run by Admin/Auditor and by the backup restore test.
create function hr.verify_audit_chain() returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare e record; v_prev bytea := null; v_calc bytea;
begin
  for e in select * from hr.audit_event order by id loop
    v_calc := sha256(convert_to(concat_ws('|',
      encode(coalesce(v_prev, '\x'::bytea), 'hex'), e.occurred_at::text, e.table_name, coalesce(e.record_id, ''),
      e.action, coalesce(e.actor_auth_user_id::text, ''), e.actor_db_role,
      coalesce(e.old_row::text, ''), coalesce(e.new_row::text, ''), coalesce(e.note, '')), 'UTF8'));
    if e.prev_hash is distinct from v_prev or e.row_hash <> v_calc then
      return e.id;
    end if;
    v_prev := e.row_hash;
  end loop;
  return null;
end $$;

create trigger audit_event_immutable before update or delete on hr.audit_event
  for each row execute function hr.forbid_mutation();
create trigger audit_event_no_truncate before truncate on hr.audit_event
  for each statement execute function hr.forbid_mutation();

-- ---------------------------------------------------------------------
-- FEATURE FLAGS. The four money-execution flags are pinned OFF by a CHECK
-- constraint: the database cannot even store "on". Enabling any of them
-- requires a reviewed migration that drops the constraint.
-- ---------------------------------------------------------------------
create table hr.feature_flag (
  key         text primary key,
  enabled     boolean not null default false,
  description text not null,
  constraint money_execution_flags_locked_off check (
    key not in ('payroll_execution', 'payment_execution', 'tax_calculation', 'late_deduction')
    or enabled = false
  )
);
insert into hr.feature_flag (key, enabled, description) values
  ('payroll_execution', false, 'Non-sandbox payroll runs. HARD CONSTRAINT 1: OFF.'),
  ('payment_execution', false, 'Payment instructions/transactions. HARD CONSTRAINT 1: OFF.'),
  ('tax_calculation',   false, 'Tax engine. OFF until official Pakistan rates are verified.'),
  ('late_deduction',    false, 'One-hour-salary late deduction. PENDING LEGAL REVIEW: OFF.');

create function hr.flag_enabled(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from hr.feature_flag where key = p_key), false)
$$;

-- ---------------------------------------------------------------------
-- USER ROLES (application roles, effective-dated, never deleted)
-- ---------------------------------------------------------------------
create type hr.app_role as enum ('admin', 'hr', 'manager', 'employee', 'auditor');

create table hr.user_role (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null,              -- Supabase auth.users.id (no FK: keeps Neon portability)
  role          hr.app_role not null,
  department_id uuid,                       -- optional scope; FK added in 0003
  valid_during  daterange not null default daterange(current_date, null),
  granted_by    uuid not null,
  grant_reason  text not null check (length(trim(grant_reason)) > 0),
  revoked_at    timestamptz,
  revoked_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  check ((revoked_at is null) = (revoked_by is null))
);
create index user_role_lookup on hr.user_role (auth_user_id, role);

create function hr.has_role(p_role hr.app_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from hr.user_role ur
    where ur.auth_user_id = hr.current_auth_user()
      and ur.role = p_role
      and ur.revoked_at is null
      and ur.valid_during @> (now() at time zone 'Asia/Karachi')::date
  )
$$;
create function hr.is_admin()   returns boolean language sql stable as $$ select hr.has_role('admin') $$;
create function hr.is_hr()      returns boolean language sql stable as $$ select hr.has_role('hr') $$;
create function hr.is_auditor() returns boolean language sql stable as $$ select hr.has_role('auditor') $$;
create function hr.is_staff()   returns boolean language sql stable as $$ select hr.has_role('admin') or hr.has_role('hr') $$;

-- ---------------------------------------------------------------------
-- EFFECTIVE-DATED POLICY CONFIG (grace minutes, OT multipliers, alert
-- lead times...). Never constants in code. Approved rows for a key may not
-- overlap in time. Seed rows are PROPOSED: Admin must approve in-app.
-- ---------------------------------------------------------------------
create type hr.config_status as enum ('proposed', 'approved', 'rejected', 'retired');

create table hr.policy_config (
  id                  uuid primary key default gen_random_uuid(),
  key                 text not null,
  value               jsonb not null,
  valid_during        daterange not null,
  status              hr.config_status not null default 'proposed',
  pending_legal_review boolean not null default false,
  source_reference    text not null,            -- where the number came from
  approval_request_id uuid,                     -- FK added in 0002
  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  constraint policy_config_no_overlap
    exclude using gist (key with =, valid_during with &&) where (status = 'approved'),
  constraint legal_pending_cannot_be_approved
    check (not (pending_legal_review and status = 'approved'))
);

insert into hr.policy_config (key, value, valid_during, status, pending_legal_review, source_reference) values
  ('attendance.grace_minutes',          '10',  daterange('2026-01-01', null), 'proposed', false, 'Project brief: 10 minutes, configurable'),
  ('alerts.probation_contract_lead_days','15', daterange('2026-01-01', null), 'proposed', false, 'Project brief section E'),
  ('attendance.dispute_window_days',    '3',   daterange('2026-01-01', null), 'proposed', false, 'Project brief section D: 3 calendar days');
-- Deliberately NOT seeded: overtime multipliers, late-deduction amount,
-- tax slabs, alert follow-up days. All pending your/legal decision.

-- ---------------------------------------------------------------------
-- FILE REFERENCES (insert-only). Points at a Supabase Storage object.
-- owner_employee_id lets RLS scope files without joining every caller.
-- ---------------------------------------------------------------------
create table hr.file_reference (
  id                uuid primary key default gen_random_uuid(),
  bucket            text not null check (bucket in ('employee-documents', 'attendance-imports', 'payment-evidence', 'payslips')),
  object_path       text not null,
  sha256            bytea not null check (length(sha256) = 32),
  size_bytes        bigint not null check (size_bytes > 0),
  mime_type         text not null,
  original_filename text not null,
  owner_employee_id uuid,                     -- FK added in 0003
  uploaded_by       uuid not null,
  uploaded_at       timestamptz not null default now(),
  unique (bucket, object_path)
);
create trigger file_reference_immutable before update or delete on hr.file_reference
  for each row execute function hr.forbid_mutation();

-- Source: supabase/migrations/20260101000002_approvals.sql
-- =====================================================================
-- 0002 APPROVALS CENTRE
-- One generic propose -> decide mechanism used by every money- or
-- attendance-affecting change. Specialised tables (corrections, overtime,
-- deductions, payroll...) each point at one approval_request.
--
-- Enforced in the database, not the UI:
--   * the decider must be the acting user
--   * the decider must hold the request's required_role at decision time
--   * segregation of duties: nobody decides their own request
--   * decisions are insert-only and final (a new request is needed to revisit)
--   * kind-specific guards (e.g. late deduction can never be approved
--     while its flag is off)
-- =====================================================================

create type hr.approval_kind as enum (
  'attendance_correction', 'attendance_batch_acceptance', 'punch_mapping', 'device_clock_adjustment',
  'leave', 'unpaid_absence', 'shift_calendar_change', 'holiday',
  'overtime', 'deduction', 'compensation_change', 'position_change', 'bank_detail_change',
  'probation_contract_revision', 'loan_change', 'payroll_run', 'payroll_reopen',
  'payment_reauthorization', 'final_settlement_component', 'policy_config',
  'document_requirement', 'role_grant'
);
create type hr.approval_status as enum ('pending', 'approved', 'rejected');

create table hr.approval_request (
  id                  uuid primary key default gen_random_uuid(),
  kind                hr.approval_kind not null,
  subject_table       text not null,
  subject_id          uuid not null,
  subject_employee_id uuid,                    -- FK added in 0003; drives RLS visibility
  required_role       hr.app_role not null default 'admin',
  requested_by        uuid not null default hr.current_auth_user(),
  requested_at        timestamptz not null default now(),
  reason              text not null check (length(trim(reason)) > 0),
  status              hr.approval_status not null default 'pending',
  decided_at          timestamptz,
  unique (subject_table, subject_id, kind, requested_at)
);
create index approval_request_queue on hr.approval_request (status, kind, requested_at);
create index approval_request_subject on hr.approval_request (subject_table, subject_id);

create table hr.approval_decision (
  id                  uuid primary key default gen_random_uuid(),
  approval_request_id uuid not null unique references hr.approval_request(id),
  decision            text not null check (decision in ('approved', 'rejected')),
  decided_by          uuid not null default hr.current_auth_user(),
  decided_at          timestamptz not null default now(),
  reason              text not null check (length(trim(reason)) > 0)
);

create function hr.is_approved(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select status = 'approved' from hr.approval_request where id = p_request), false)
$$;

-- Kind-specific guards. Uses tables created in later migrations; plpgsql
-- resolves them at call time.
create function hr.assert_approvable(r hr.approval_request) returns void
language plpgsql security definer set search_path = '' as $$
declare v_kind text;
begin
  if r.kind = 'deduction' then
    select kind::text into v_kind from hr.deduction_proposal where id = r.subject_id;
    if v_kind = 'late_arrival_hour' and not hr.flag_enabled('late_deduction') then
      raise exception 'late-arrival deduction is PENDING LEGAL REVIEW and cannot be approved';
    end if;
  end if;
  if r.kind = 'policy_config' then
    if exists (select 1 from hr.policy_config where id = r.subject_id and pending_legal_review) then
      raise exception 'policy row is pending legal review and cannot be approved';
    end if;
  end if;
end $$;

create function hr.on_approval_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r hr.approval_request;
begin
  select * into r from hr.approval_request where id = new.approval_request_id for update;
  if not found then raise exception 'approval request % not found', new.approval_request_id; end if;
  if r.status <> 'pending' then
    raise exception 'approval request % is already %', r.id, r.status;
  end if;
  if new.decided_by is distinct from hr.current_auth_user() then
    raise exception 'decided_by must be the acting user';
  end if;
  if new.decided_by = r.requested_by then
    raise exception 'segregation of duties: a requester cannot decide their own request';
  end if;
  if not hr.has_role(r.required_role) then
    raise exception 'decider does not currently hold role %', r.required_role;
  end if;
  if new.decision = 'approved' then
    perform hr.assert_approvable(r);
  end if;
  update hr.approval_request
     set status = new.decision::hr.approval_status, decided_at = new.decided_at
   where id = r.id;
  return new;
end $$;

create trigger approval_decision_apply before insert on hr.approval_decision
  for each row execute function hr.on_approval_decision();
create trigger approval_decision_immutable before update or delete on hr.approval_decision
  for each row execute function hr.forbid_mutation();

alter table hr.policy_config
  add constraint policy_config_approval_fk foreign key (approval_request_id) references hr.approval_request(id);

-- Approving a policy_config row: config status may only become 'approved'
-- when its approval request is approved.
create function hr.guard_approved_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status::text = 'approved' and not hr.is_approved(new.approval_request_id) then
    raise exception 'hr.%: status approved requires an approved approval_request', tg_table_name;
  end if;
  return new;
end $$;
create trigger policy_config_guard before insert or update on hr.policy_config
  for each row execute function hr.guard_approved_status();

-- ---------------------------------------------------------------------
-- CHANGE REQUESTS (salary, position, team, bank details...). Old and new
-- values are recorded; effective treatment defaults to NEXT payroll
-- period. A separately approved proration is a different, explicit value.
-- Applying an approved change creates a NEW effective-dated row in the
-- target table; prior rows are never edited.
-- ---------------------------------------------------------------------
create type hr.effective_treatment as enum ('next_payroll_period', 'prorated_approved_separately');

create table hr.change_request (
  id                  uuid primary key default gen_random_uuid(),
  kind                hr.approval_kind not null check (kind in
                        ('compensation_change', 'position_change', 'bank_detail_change',
                         'shift_calendar_change', 'loan_change')),
  employee_id         uuid not null,          -- FK added in 0003
  old_value           jsonb not null,
  new_value           jsonb not null,
  reason              text not null check (length(trim(reason)) > 0),
  requested_effective_date date not null,
  effective_treatment hr.effective_treatment not null default 'next_payroll_period',
  proration_approval_request_id uuid references hr.approval_request(id),
  requested_by        uuid not null default hr.current_auth_user(),
  requested_at        timestamptz not null default now(),
  approval_request_id uuid not null references hr.approval_request(id),
  applied_at          timestamptz,
  check (effective_treatment = 'next_payroll_period' or proration_approval_request_id is not null)
);

-- Source: supabase/migrations/20260101000003_org_employee.sql
-- =====================================================================
-- 0003 ORGANISATION, EMPLOYEE REGISTER, LIFECYCLE
-- Anything that changes over time (department, team, title, manager,
-- contract dates, probation dates) is a separate effective-dated or
-- revisioned row, so history is never overwritten.
-- =====================================================================

create table hr.department (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid
);

create table hr.team (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references hr.department(id),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid
);

alter table hr.user_role add constraint user_role_department_fk
  foreign key (department_id) references hr.department(id);

create type hr.employee_status as enum ('active', 'terminated', 'resigned');
create type hr.employment_category as enum (
  'fixed_monthly', 'fixed_plus_incentive', 'commission_only',
  'probationary_trainee', 'contractor', 'consultant'
);

create table hr.employee (
  id                  uuid primary key default gen_random_uuid(),
  employee_code       text not null unique check (employee_code ~ '^[A-Z0-9-]{2,20}$'),
  full_name           text not null,
  preferred_name      text,
  work_email          text unique,
  phone               text,
  location            text,
  employment_category hr.employment_category not null,
  status              hr.employee_status not null default 'active',
  joining_date        date not null,
  exit_date           date,
  exit_reason         text,
  auth_user_id        uuid unique,           -- named company account; NULL until invited
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid,
  check ((status = 'active') = (exit_date is null)),
  check (exit_date is null or exit_date >= joining_date),
  check (status = 'active' or exit_reason is not null)
);
create index employee_status_idx on hr.employee (status);

-- Deferred FKs from earlier migrations
alter table hr.file_reference   add constraint file_reference_owner_fk foreign key (owner_employee_id) references hr.employee(id);
alter table hr.approval_request add constraint approval_request_employee_fk foreign key (subject_employee_id) references hr.employee(id);
alter table hr.change_request   add constraint change_request_employee_fk foreign key (employee_id) references hr.employee(id);

-- Current employee for the acting user. Returns NULL for exited staff,
-- so self-service access stops at exit (history is untouched).
create function hr.current_employee_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select e.id from hr.employee e
  where e.auth_user_id = hr.current_auth_user() and e.status = 'active'
$$;

-- Department / team / title / location placement, effective-dated
create table hr.employee_assignment (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references hr.employee(id),
  department_id     uuid not null references hr.department(id),
  team_id           uuid references hr.team(id),
  job_title         text not null,
  valid_during      daterange not null,
  change_request_id uuid references hr.change_request(id),   -- NULL only for the initial onboarding row
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  constraint employee_assignment_no_overlap exclude using gist (employee_id with =, valid_during with &&)
);

create table hr.manager_assignment (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  manager_employee_id uuid not null references hr.employee(id),
  valid_during        daterange not null,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  check (employee_id <> manager_employee_id),
  constraint manager_assignment_no_overlap exclude using gist (employee_id with =, valid_during with &&)
);

create function hr.manages(p_employee uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select hr.has_role('manager') and exists (
    select 1 from hr.manager_assignment ma
    where ma.employee_id = p_employee
      and ma.manager_employee_id = hr.current_employee_id()
      and ma.valid_during @> (now() at time zone 'Asia/Karachi')::date
  )
$$;

create function hr.is_self(p_employee uuid) returns boolean
language sql stable as $$ select p_employee is not null and p_employee = hr.current_employee_id() $$;

create function hr.can_view_employee(p_employee uuid) returns boolean
language sql stable as $$ select hr.is_staff() or hr.is_self(p_employee) or hr.manages(p_employee) $$;

-- ---------------------------------------------------------------------
-- Contracts and probation are REVISIONED: a revision is a new row in the
-- same series with a higher revision_no. The "current" dates are the
-- highest approved revision. Old dates are preserved by construction.
-- ---------------------------------------------------------------------
create type hr.lifecycle_action as enum ('initial', 'confirm', 'extend', 'renew', 'revise', 'end');

create table hr.employment_contract (
  id                  uuid primary key default gen_random_uuid(),
  series_id           uuid not null,          -- stable identity of "this contract"
  revision_no         int  not null check (revision_no >= 1),
  employee_id         uuid not null references hr.employee(id),
  contract_start      date not null,
  contract_end        date,                   -- NULL = open-ended
  action              hr.lifecycle_action not null,
  reason              text not null,
  document_reference_id uuid references hr.file_reference(id),
  effective_date      date not null,
  approval_request_id uuid references hr.approval_request(id),   -- NULL only for revision 1 at onboarding
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  unique (series_id, revision_no),
  check (contract_end is null or contract_end >= contract_start),
  check (revision_no = 1 or approval_request_id is not null)
);

create table hr.probation_period (
  id                  uuid primary key default gen_random_uuid(),
  series_id           uuid not null,
  revision_no         int  not null check (revision_no >= 1),
  employee_id         uuid not null references hr.employee(id),
  probation_start     date not null,
  probation_end       date not null,
  action              hr.lifecycle_action not null,
  reason              text not null,
  document_reference_id uuid references hr.file_reference(id),
  effective_date      date not null,
  approval_request_id uuid references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  unique (series_id, revision_no),
  check (probation_end >= probation_start),
  check (revision_no = 1 or approval_request_id is not null)
);

create view hr.current_contract with (security_invoker = true) as
  select distinct on (c.series_id) c.*
  from hr.employment_contract c
  where c.revision_no = 1 or hr.is_approved(c.approval_request_id)
  order by c.series_id, c.revision_no desc;

create view hr.current_probation with (security_invoker = true) as
  select distinct on (p.series_id) p.*
  from hr.probation_period p
  where p.revision_no = 1 or hr.is_approved(p.approval_request_id)
  order by p.series_id, p.revision_no desc;

-- ---------------------------------------------------------------------
-- SENSITIVE DETAILS live in their own tables so RLS can exclude managers
-- entirely. The DB never holds plaintext account/CNIC numbers: the API
-- encrypts with a key held outside the database (Supabase Vault or a KMS)
-- and stores ciphertext + last 4 for masked display.
-- ---------------------------------------------------------------------
create type hr.verification_status as enum ('proposed', 'verified', 'rejected', 'superseded');

create table hr.employee_payment_detail (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  bank_name           text not null,
  account_title       text not null,
  iban_ciphertext     bytea not null,
  iban_last4          text not null check (iban_last4 ~ '^[0-9A-Z]{4}$'),
  status              hr.verification_status not null default 'proposed',
  verified_by         uuid,
  verified_at         timestamptz,
  verification_method text,                 -- e.g. 'bank letter', 'cancelled cheque'
  evidence_file_id    uuid references hr.file_reference(id),
  approval_request_id uuid not null references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  check (status <> 'verified' or (verified_by is not null and verified_at is not null and evidence_file_id is not null))
);
-- at most one verified account per employee at a time
create unique index employee_payment_detail_one_verified on hr.employee_payment_detail (employee_id) where status = 'verified';
create function hr.guard_payment_detail_verified() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'verified' and not hr.is_approved(new.approval_request_id) then
    raise exception 'bank detail cannot be verified without an approved bank_detail_change request';
  end if;
  return new;
end $$;
create trigger employee_payment_detail_verify_guard before insert or update on hr.employee_payment_detail
  for each row execute function hr.guard_payment_detail_verified();

create table hr.employee_identity (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null unique references hr.employee(id),
  cnic_ciphertext  bytea,
  cnic_last4       text check (cnic_last4 ~ '^[0-9]{4}$'),
  date_of_birth    date,
  emergency_contact jsonb,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid
);

-- Masked list view: what registers, exports and dashboards use.
create view hr.employee_payment_detail_masked with (security_invoker = true) as
  select id, employee_id, bank_name, account_title, '••••' || iban_last4 as iban_masked,
         status, verified_at
  from hr.employee_payment_detail;

-- Source: supabase/migrations/20260101000004_calendar_leave.sql
-- =====================================================================
-- 0004 CALENDARS, SHIFTS, HOLIDAYS, LEAVE
-- Every employee has their OWN calendar assignment; nothing assumes a
-- shared schedule. Leave, holidays, weekly rest and absence are four
-- distinct concepts and are stored separately.
-- =====================================================================

create table hr.shift (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  start_local          time not null,         -- Asia/Karachi wall-clock
  end_local            time not null,
  crosses_midnight     boolean generated always as (end_local <= start_local) stored,
  paid_break_minutes   int not null default 0 check (paid_break_minutes >= 0),
  unpaid_break_minutes int not null default 0 check (unpaid_break_minutes >= 0),
  scheduled_minutes    int generated always as (
      (extract(epoch from (end_local - start_local))::int / 60)
      + case when end_local <= start_local then 1440 else 0 end
      - unpaid_break_minutes) stored,
  -- Pairing windows: how early before start a clock-in counts, and how
  -- long after end a clock-out still belongs to this shift. NO defaults:
  -- HR must set these consciously (they decide which business date a
  -- 2 AM punch belongs to).
  clock_in_window_before_minutes int not null check (clock_in_window_before_minutes between 0 and 720),
  clock_out_window_after_minutes int not null check (clock_out_window_after_minutes between 0 and 720),
  is_active            boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid
);

create table hr.work_calendar (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user()
);

-- One rule per ISO weekday (1 = Monday ... 7 = Sunday). shift_id NULL
-- means weekly rest day. Saturday (6) work is never implied overtime.
create table hr.work_calendar_rule (
  id           uuid primary key default gen_random_uuid(),
  calendar_id  uuid not null references hr.work_calendar(id),
  iso_weekday  int not null check (iso_weekday between 1 and 7),
  shift_id     uuid references hr.shift(id),
  valid_during daterange not null,
  approval_request_id uuid references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  constraint work_calendar_rule_no_overlap
    exclude using gist (calendar_id with =, iso_weekday with =, valid_during with &&)
);

create table hr.employee_calendar_assignment (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references hr.employee(id),
  calendar_id  uuid not null references hr.work_calendar(id),
  valid_during daterange not null,
  approval_request_id uuid references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  constraint employee_calendar_no_overlap exclude using gist (employee_id with =, valid_during with &&)
);

create table hr.holiday (
  id                  uuid primary key default gen_random_uuid(),
  holiday_date        date not null,
  name                text not null,
  applies_to_all      boolean not null default true,
  status              hr.config_status not null default 'proposed',
  approval_request_id uuid references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid
);
create trigger holiday_guard before insert or update on hr.holiday
  for each row execute function hr.guard_approved_status();

create table hr.holiday_employee (
  holiday_id  uuid not null references hr.holiday(id),
  employee_id uuid not null references hr.employee(id),
  primary key (holiday_id, employee_id)
);

-- ---------------------------------------------------------------------
-- LEAVE. Balance is a ledger (insert-only transactions); never a mutable
-- counter. Balance = SUM(minutes) per employee per leave type.
-- ---------------------------------------------------------------------
create table hr.leave_type (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  is_paid    boolean not null,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user()
);

create table hr.leave_request (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  leave_type_id       uuid not null references hr.leave_type(id),
  start_date          date not null,
  end_date            date not null,
  part_of_day         text not null default 'full' check (part_of_day in ('full', 'first_half', 'second_half')),
  reason              text,
  requested_by        uuid not null default hr.current_auth_user(),
  requested_at        timestamptz not null default now(),
  approval_request_id uuid not null references hr.approval_request(id),
  check (end_date >= start_date),
  check (part_of_day = 'full' or start_date = end_date)
);

create table hr.leave_transaction (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references hr.employee(id),
  leave_type_id    uuid not null references hr.leave_type(id),
  kind             text not null check (kind in ('opening', 'accrual', 'taken', 'adjustment', 'reversal', 'expiry')),
  minutes          int not null,               -- signed: + credit, - debit
  effective_date   date not null,
  leave_request_id uuid references hr.leave_request(id),
  reverses_id      uuid references hr.leave_transaction(id),
  approval_request_id uuid references hr.approval_request(id),
  note             text not null,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  check (kind <> 'reversal' or reverses_id is not null)
);
create trigger leave_transaction_immutable before update or delete on hr.leave_transaction
  for each row execute function hr.forbid_mutation();

create view hr.leave_balance with (security_invoker = true) as
  select employee_id, leave_type_id, sum(minutes)::int as balance_minutes
  from hr.leave_transaction group by employee_id, leave_type_id;

-- Source: supabase/migrations/20260101000005_attendance.sql
-- =====================================================================
-- 0005 ATTENDANCE
--
-- Four layers, each with a different mutability rule:
--
--   1. EVIDENCE   attendance_import_batch -> raw_import_row      insert-only
--                 (every uploaded row verbatim, accepted or not)
--   2. FACTS      raw_punch                                       insert-only
--                 (one row per distinct device event; idempotent key)
--   3. DERIVED    attendance_computation -> attendance_day         append + supersede
--                 (recomputable from 2 + approved corrections; old
--                  computations kept so payroll can cite exactly
--                  what it used)
--   4. DECISIONS  attendance_exception, attendance_correction,
--                 approval_request/decision                       propose -> approve
--
-- Nothing in layers 3-4 ever produces a deduction. Deductions are a
-- separate proposal (0007) that a human must raise and Admin approve.
-- =====================================================================

-- ---------------------------------------------------------------------
-- DEVICES. The sample ZKTeco export carries NO device serial, only
-- "Location ID" (101). The device is therefore chosen by HR at upload,
-- and the batch-level SHA-256 check (below) catches the same file being
-- uploaded twice under different devices.
-- ---------------------------------------------------------------------
create table hr.device (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  vendor           text not null default 'ZKTeco',
  serial_number    text unique,
  location_code    text not null,                -- "Location ID" column, e.g. '101'
  timezone         text not null default 'Asia/Karachi',
  -- How this device writes timestamps. Declared, never sniffed per file:
  -- a file containing only days 1-12 cannot disambiguate D/M from M/D.
  datetime_format  text not null,                -- e.g. 'M/D/YYYY h:mm:ss AM' (sample file)
  status_label_map jsonb not null,               -- e.g. {"C/In":"in","C/Out":"out"}
  is_active        boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid,
  unique (location_code, name)
);

-- Clock drift is never "fixed" in raw data. An approved adjustment over a
-- time range is applied by the computation layer.
create table hr.device_clock_adjustment (
  id                  uuid primary key default gen_random_uuid(),
  device_id           uuid not null references hr.device(id),
  applies_during      tsrange not null,          -- device-local wall-clock range
  offset_seconds      int not null check (offset_seconds between -86400 and 86400),
  reason              text not null,
  evidence            text not null,             -- how the drift was measured
  approval_request_id uuid not null references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  constraint device_clock_adjustment_no_overlap exclude using gist (device_id with =, applies_during with &&)
);
create trigger device_clock_adjustment_immutable before update or delete on hr.device_clock_adjustment
  for each row execute function hr.forbid_mutation();

-- ---------------------------------------------------------------------
-- IMPORT BATCH. Evidence columns are immutable (only status/review/count
-- columns are granted for UPDATE in 0008).
-- ---------------------------------------------------------------------
create type hr.import_source as enum ('csv', 'tsv', 'xls_biff', 'xls_html', 'xlsx', 'device_pull_pyzk', 'zkbio_api');
create type hr.batch_status as enum ('uploaded', 'parsing', 'parse_failed', 'under_review', 'accepted', 'rejected');

create table hr.attendance_import_batch (
  id                 uuid primary key default gen_random_uuid(),
  device_id          uuid not null references hr.device(id),
  declared_extension text not null,             -- what the filename said (.xls)
  detected_source    hr.import_source,          -- what the bytes actually were
  detected_encoding  text,                      -- e.g. 'iso-8859-1 (no CODEPAGE record)'
  file_reference_id  uuid not null references hr.file_reference(id),
  file_sha256        bytea not null check (length(file_sha256) = 32),
  original_filename  text not null,
  claimed_period     daterange,                 -- what HR says the file covers
  uploaded_by        uuid not null default hr.current_auth_user(),
  uploaded_at        timestamptz not null default now(),
  parser_version     text,
  status             hr.batch_status not null default 'uploaded',
  total_rows         int,
  parsed_rows        int,
  error_rows         int,
  promoted_punches   int,
  duplicate_punches  int,
  open_flags         int,
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  review_note        text,
  check (status not in ('accepted', 'rejected') or (reviewed_by is not null and review_note is not null))
);
-- The same bytes cannot be live in two batches (any device).
create unique index attendance_import_batch_live_hash
  on hr.attendance_import_batch (file_sha256) where status not in ('rejected', 'parse_failed');

-- ---------------------------------------------------------------------
-- RAW IMPORT ROW: every row of every file, verbatim, including the header
-- and rows that failed to parse. Parsed fields sit beside the verbatim
-- cells so a reviewer can see both. Insert-only.
-- ---------------------------------------------------------------------
create type hr.punch_direction as enum ('in', 'out', 'break_out', 'break_in', 'ot_in', 'ot_out', 'unknown');

create table hr.raw_import_row (
  id               uuid primary key default gen_random_uuid(),
  batch_id         uuid not null references hr.attendance_import_batch(id),
  row_number       int  not null check (row_number >= 0),   -- 0 = header
  raw_cells        jsonb not null,             -- exact cell strings, in column order
  parse_status     text not null check (parse_status in ('header', 'ok', 'error')),
  parse_error      text,
  enrollment_no    text,                       -- "No."
  name_seen        text,                       -- "Name" (never used to match)
  department_seen  text,
  device_local_ts  timestamp,                  -- parsed wall-clock, no zone
  status_label_raw text,                       -- "Status" exactly as written: 'C/In'
  direction_label  hr.punch_direction,         -- device's claim, mapped via status_label_map
  verify_method    text,                       -- "VerifyCode": FP, card, face...
  location_code    text,
  workcode         text,
  created_at       timestamptz not null default now(),
  unique (batch_id, row_number),
  check (parse_status <> 'ok' or (enrollment_no is not null and device_local_ts is not null and status_label_raw is not null)),
  check (parse_status <> 'error' or parse_error is not null)
);
create trigger raw_import_row_immutable before update or delete on hr.raw_import_row
  for each row execute function hr.forbid_mutation();

-- ---------------------------------------------------------------------
-- RAW PUNCH: the device fact. Promoted from raw_import_row only when a
-- batch is ACCEPTED (so a wrong file, once rejected, never poisons the
-- idempotency key for the right file).
--
-- Idempotency key uses DEVICE-LOCAL time and the RAW status label, so the
-- key never changes if timezone config or label mapping is later fixed.
-- Re-importing the same file: INSERT ... ON CONFLICT DO NOTHING -> 0 rows.
-- ---------------------------------------------------------------------
create table hr.raw_punch (
  id                uuid primary key default gen_random_uuid(),
  device_id         uuid not null references hr.device(id),
  enrollment_no     text not null,
  device_local_ts   timestamp not null,
  status_label_raw  text not null,
  direction_label   hr.punch_direction not null,   -- device's claim; NOT trusted for pairing
  punch_at          timestamptz not null,          -- device_local_ts AT TIME ZONE device.timezone, before drift adj.
  verify_method     text,
  first_seen_row_id uuid not null references hr.raw_import_row(id),
  promoted_at       timestamptz not null default now(),
  constraint raw_punch_idempotency unique (device_id, enrollment_no, device_local_ts, status_label_raw)
);
create index raw_punch_by_person on hr.raw_punch (device_id, enrollment_no, punch_at);
create trigger raw_punch_immutable before update or delete on hr.raw_punch
  for each row execute function hr.forbid_mutation();
create trigger raw_punch_no_truncate before truncate on hr.raw_punch
  for each statement execute function hr.forbid_mutation();

-- What happened to each row (insert-only). One row per raw_import_row.
create table hr.import_row_result (
  raw_import_row_id uuid primary key references hr.raw_import_row(id),
  batch_id          uuid not null references hr.attendance_import_batch(id),
  result            text not null check (result in ('header', 'parse_error', 'promoted', 'duplicate_existing', 'batch_rejected')),
  raw_punch_id      uuid references hr.raw_punch(id),
  created_at        timestamptz not null default now(),
  check ((result in ('promoted', 'duplicate_existing')) = (raw_punch_id is not null))
);
create trigger import_row_result_immutable before update or delete on hr.import_row_result
  for each row execute function hr.forbid_mutation();

-- Review queue for import problems. Nothing is silently discarded or guessed.
create table hr.import_flag (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null references hr.attendance_import_batch(id),
  raw_import_row_id uuid references hr.raw_import_row(id),
  kind              text not null check (kind in (
                      'unknown_enrollment',    -- No. has no approved mapping
                      'name_mismatch',         -- name in file != mapping.expected_name
                      'near_duplicate',        -- same person within N seconds (sample: 1-44 s)
                      'direction_conflict',    -- two consecutive same-direction labels (sample: 82 of 476)
                      'ambiguous_date',        -- format could be D/M or M/D
                      'outside_claimed_period',
                      'future_timestamp',
                      'encoding_uncertain',    -- e.g. BIFF with no CODEPAGE record (sample file)
                      'cross_device_duplicate')),
  details           jsonb not null,
  status            text not null default 'open' check (status in ('open', 'resolved', 'accepted_as_is')),
  resolved_by       uuid,
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz not null default now(),
  check (status = 'open' or (resolved_by is not null and resolution_note is not null))
);
create index import_flag_open on hr.import_flag (batch_id) where status = 'open';

-- ---------------------------------------------------------------------
-- PUNCH MAPPING: (device, enrollment no.) -> employee, effective-dated,
-- Admin-approved. Enrollment numbers can be re-used after someone leaves,
-- hence the date range. Never matched by name (sample has two "Asad"s).
-- ---------------------------------------------------------------------
create table hr.punch_mapping (
  id                  uuid primary key default gen_random_uuid(),
  device_id           uuid not null references hr.device(id),
  enrollment_no       text not null,
  employee_id         uuid not null references hr.employee(id),
  expected_name       text not null,
  valid_during        daterange not null,
  status              hr.config_status not null default 'proposed',
  approval_request_id uuid not null references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid,
  constraint punch_mapping_no_overlap
    exclude using gist (device_id with =, enrollment_no with =, valid_during with &&) where (status = 'approved')
);
create trigger punch_mapping_guard before insert or update on hr.punch_mapping
  for each row execute function hr.guard_approved_status();

-- ---------------------------------------------------------------------
-- DERIVED LAYER
-- A computation covers one employee over a date range. Recomputing
-- (new punches, approved correction, config change) inserts a NEW
-- computation and marks the old one superseded. Payroll lines cite
-- computation ids, so "what did payroll use?" is always answerable.
-- ---------------------------------------------------------------------
create table hr.attendance_computation (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references hr.employee(id),
  covers            daterange not null,
  engine_version    text not null,
  input_fingerprint bytea not null,             -- sha256 over punch ids + correction ids + config ids used
  config_used       jsonb not null,             -- {policy_config ids, shift ids, calendar rule ids}
  computed_at       timestamptz not null default now(),
  superseded_by     uuid references hr.attendance_computation(id),
  superseded_at     timestamptz,
  check ((superseded_by is null) = (superseded_at is null))
);
create index attendance_computation_current on hr.attendance_computation (employee_id) where superseded_by is null;

create type hr.presence as enum ('present', 'partial', 'absent', 'not_scheduled', 'on_leave', 'holiday', 'needs_review');

create table hr.attendance_day (
  id                    uuid primary key default gen_random_uuid(),
  computation_id        uuid not null references hr.attendance_computation(id),
  employee_id           uuid not null references hr.employee(id),
  -- BUSINESS DATE = the Asia/Karachi date the scheduled shift STARTS.
  -- A 3 AM Saturday clock-out belongs to Friday's night shift.
  business_date         date not null,
  calendar_rule_id      uuid references hr.work_calendar_rule(id),
  shift_id              uuid references hr.shift(id),     -- NULL = weekly rest per calendar
  is_weekly_rest        boolean not null,
  holiday_id            uuid references hr.holiday(id),   -- approved holiday only
  leave_request_id      uuid references hr.leave_request(id),  -- approved leave only
  scheduled_start       timestamptz,
  scheduled_end         timestamptz,
  first_in              timestamptz,
  last_out              timestamptz,
  worked_minutes        int check (worked_minutes >= 0),
  late_minutes          int check (late_minutes >= 0),          -- AFTER grace; informational, never a deduction
  early_departure_minutes int check (early_departure_minutes >= 0),
  beyond_shift_minutes  int check (beyond_shift_minutes >= 0),  -- candidate only; OT needs authorization + approval
  presence              hr.presence not null,
  unique (computation_id, business_date),
  check (shift_id is not null or is_weekly_rest)
);
create index attendance_day_lookup on hr.attendance_day (employee_id, business_date);

-- Which punches the engine assigned to the day, and the role it INFERRED.
create table hr.attendance_day_punch (
  attendance_day_id uuid not null references hr.attendance_day(id),
  raw_punch_id      uuid not null references hr.raw_punch(id),
  inferred_role     text not null check (inferred_role in ('in', 'out', 'intermediate', 'held_for_review')),
  inference_reason  text not null,   -- e.g. 'label C/In disagrees with order; treated as out'
  primary key (attendance_day_id, raw_punch_id)
);

-- Current, official view of attendance.
create view hr.attendance_day_current with (security_invoker = true) as
  select d.* from hr.attendance_day d
  join hr.attendance_computation c on c.id = d.computation_id
  where c.superseded_by is null;

-- Computations are frozen once payroll for the period is under review
-- or later (guard function defined in 0007 when payroll_run exists).

-- ---------------------------------------------------------------------
-- EXCEPTIONS. Keyed by (employee, business_date, kind), NOT by
-- attendance_day id, so an exception survives recomputation.
-- ---------------------------------------------------------------------
create type hr.exception_kind as enum (
  'missing_clock_in', 'missing_clock_out', 'no_punches', 'late_arrival', 'early_departure',
  'beyond_shift_hours', 'out_of_shift_activity', 'overnight_ambiguous', 'rest_day_work',
  'holiday_work', 'near_duplicate_pending', 'direction_inferred', 'unmapped_punches',
  'possible_half_day');
create type hr.exception_status as enum ('open', 'correction_proposed', 'resolved_corrected', 'resolved_no_change', 'rejected');

create table hr.attendance_exception (
  id                       uuid primary key default gen_random_uuid(),
  employee_id              uuid not null references hr.employee(id),
  business_date            date not null,
  kind                     hr.exception_kind not null,
  details                  jsonb not null,
  first_computation_id     uuid not null references hr.attendance_computation(id),
  last_seen_computation_id uuid not null references hr.attendance_computation(id),
  status                   hr.exception_status not null default 'open',
  resolution_note          text,
  resolved_by              uuid,
  resolved_at              timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), updated_by uuid,
  unique (employee_id, business_date, kind),
  check (status in ('open', 'correction_proposed') or (resolved_by is not null and resolution_note is not null))
);
create index attendance_exception_queue on hr.attendance_exception (status, business_date);

-- ---------------------------------------------------------------------
-- CORRECTIONS: separate records that reference the original punch.
-- Content is insert-only; outcome lives on its approval_request.
-- The engine applies a correction only when hr.is_approved() is true.
-- ---------------------------------------------------------------------
create type hr.correction_kind as enum (
  'add_missing_punch',        -- proposed_local_ts + proposed_role required
  'disregard_punch',          -- target_raw_punch_id required (punch stays in raw_punch)
  'set_punch_role',           -- override inferred in/out
  'assign_punch_to_date',     -- overnight edge cases
  'mark_present_offsite',     -- e.g. client visit, with evidence
  'mark_leave');

create table hr.attendance_correction (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  business_date       date not null,
  exception_id        uuid references hr.attendance_exception(id),
  kind                hr.correction_kind not null,
  target_raw_punch_id uuid references hr.raw_punch(id),
  proposed_local_ts   timestamp,
  proposed_role       text check (proposed_role in ('in', 'out')),
  proposed_business_date date,
  reason              text not null check (length(trim(reason)) > 0),
  evidence_file_id    uuid references hr.file_reference(id),
  proposed_by         uuid not null default hr.current_auth_user(),
  proposed_at         timestamptz not null default now(),
  approval_request_id uuid not null unique references hr.approval_request(id),
  check (kind <> 'add_missing_punch'    or (proposed_local_ts is not null and proposed_role is not null)),
  check (kind <> 'disregard_punch'      or target_raw_punch_id is not null),
  check (kind <> 'set_punch_role'       or (target_raw_punch_id is not null and proposed_role is not null)),
  check (kind <> 'assign_punch_to_date' or (target_raw_punch_id is not null and proposed_business_date is not null))
);
create trigger attendance_correction_immutable before update or delete on hr.attendance_correction
  for each row execute function hr.forbid_mutation();

-- ---------------------------------------------------------------------
-- DISPUTES (employee-raised). Window compliance is computed and shown;
-- it does not block filing. Late filings carry a documented reason.
-- ---------------------------------------------------------------------
create table hr.attendance_dispute (
  id                   uuid primary key default gen_random_uuid(),
  employee_id          uuid not null references hr.employee(id),
  business_date        date not null,
  record_available_at  timestamptz not null,
  raised_by            uuid not null default hr.current_auth_user(),
  raised_at            timestamptz not null default now(),
  description          text not null check (length(trim(description)) > 0),
  late_filing_reason   text check (late_filing_reason in ('delayed_access', 'illness', 'approved_leave', 'other')),
  late_filing_note     text,
  status               text not null default 'open' check (status in ('open', 'investigating', 'upheld', 'not_upheld', 'withdrawn')),
  investigated_by      uuid,
  outcome_note         text,
  correction_id        uuid references hr.attendance_correction(id),
  updated_at timestamptz not null default now(), updated_by uuid,
  check (late_filing_reason is null or late_filing_note is not null)
);

-- ---------------------------------------------------------------------
-- OVERTIME: manager authorises IN ADVANCE -> HR verifies actual minutes
-- -> Admin approves. No money here: rate/amount is computed only by the
-- (disabled) payroll engine from effective-dated config.
-- ---------------------------------------------------------------------
create table hr.overtime_authorization (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references hr.employee(id),
  business_date   date not null,
  max_minutes     int not null check (max_minutes > 0),
  reason          text not null,
  authorized_by   uuid not null default hr.current_auth_user(),
  authorized_at   timestamptz not null default now(),
  -- set by trigger from the employee's scheduled shift end: was this
  -- genuinely in advance? Late authorisations are kept but flagged.
  in_advance      boolean not null default false
);
-- Scheduled shift window for an employee on a business date (Karachi wall
-- clock -> UTC). NULL when it is a rest day or no calendar is assigned.
create function hr.scheduled_shift_window(p_employee uuid, p_date date)
returns tstzrange language sql stable security definer set search_path = '' as $$
  select tstzrange(
           (p_date + s.start_local) at time zone 'Asia/Karachi',
           ((p_date + s.start_local) + make_interval(mins => s.scheduled_minutes + s.unpaid_break_minutes))
             at time zone 'Asia/Karachi')
  from hr.employee_calendar_assignment eca
  join hr.work_calendar_rule r on r.calendar_id = eca.calendar_id
                              and r.iso_weekday = extract(isodow from p_date)::int
                              and r.valid_during @> p_date
  join hr.shift s on s.id = r.shift_id
  where eca.employee_id = p_employee and eca.valid_during @> p_date
$$;

create function hr.set_overtime_in_advance() returns trigger
language plpgsql set search_path = '' as $$
declare w tstzrange;
begin
  w := hr.scheduled_shift_window(new.employee_id, new.business_date);
  -- "in advance" = before the scheduled shift ENDS (when overtime would begin).
  -- OPEN DECISION: should the cutoff be shift start instead?
  new.in_advance := w is not null and new.authorized_at < upper(w);
  return new;
end $$;
create trigger overtime_authorization_in_advance before insert on hr.overtime_authorization
  for each row execute function hr.set_overtime_in_advance();
create trigger overtime_authorization_immutable before update or delete on hr.overtime_authorization
  for each row execute function hr.forbid_mutation();

create table hr.overtime_record (
  id                     uuid primary key default gen_random_uuid(),
  employee_id            uuid not null references hr.employee(id),
  business_date          date not null,
  authorization_id       uuid references hr.overtime_authorization(id),
  attendance_day_id      uuid not null references hr.attendance_day(id),
  hr_verified_minutes    int not null check (hr_verified_minutes > 0),
  verified_by            uuid not null default hr.current_auth_user(),
  verified_at            timestamptz not null default now(),
  verification_note      text not null,
  no_authorization_reason text,     -- required when no advance authorisation exists
  approval_request_id    uuid not null unique references hr.approval_request(id),
  check (authorization_id is not null or no_authorization_reason is not null)
);
create trigger overtime_record_immutable before update or delete on hr.overtime_record
  for each row execute function hr.forbid_mutation();

-- Source: supabase/migrations/20260101000006_documents.sql
-- =====================================================================
-- 0006 DOCUMENT REGISTER
-- Checklist per employment category; versions and reviews are
-- insert-only. A missing/expired/rejected document is surfaced at every
-- payroll-prep cycle (view below). It NEVER withholds wages.
-- Which categories are genuinely required is for HR/legal to confirm:
-- nothing is seeded as required.
-- =====================================================================

create table hr.document_category (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  sensitivity      text not null check (sensitivity in ('normal', 'sensitive', 'highly_sensitive')),
  has_expiry       boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user()
);

create table hr.document_requirement (
  id                  uuid primary key default gen_random_uuid(),
  category_id         uuid not null references hr.document_category(id),
  employment_category hr.employment_category not null,
  is_required         boolean not null,
  legal_basis_note    text not null,           -- why we collect it (data minimisation)
  valid_during        daterange not null,
  status              hr.config_status not null default 'proposed',
  approval_request_id uuid references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid,
  constraint document_requirement_no_overlap
    exclude using gist (category_id with =, employment_category with =, valid_during with &&) where (status = 'approved')
);
create trigger document_requirement_guard before insert or update on hr.document_requirement
  for each row execute function hr.guard_approved_status();

create type hr.document_status as enum (
  'missing', 'requested', 'uploaded', 'under_review', 'accepted', 'rejected', 'expired', 'not_applicable');

create table hr.employee_document (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  category_id         uuid not null references hr.document_category(id),
  status              hr.document_status not null default 'missing',
  expiry_date         date,
  not_applicable_reason text,
  requested_at        timestamptz,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid,
  unique (employee_id, category_id),
  check (status <> 'not_applicable' or not_applicable_reason is not null)
);

create table hr.document_version (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid not null references hr.employee_document(id),
  version_no        int not null check (version_no >= 1),
  file_reference_id uuid not null unique references hr.file_reference(id),
  uploaded_by       uuid not null default hr.current_auth_user(),
  uploaded_at       timestamptz not null default now(),
  unique (document_id, version_no)
);
create trigger document_version_immutable before update or delete on hr.document_version
  for each row execute function hr.forbid_mutation();

create table hr.document_review (
  id                  uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references hr.document_version(id),
  decision            text not null check (decision in ('accepted', 'rejected')),
  reason              text not null,
  expiry_date_confirmed date,
  reviewed_by         uuid not null default hr.current_auth_user(),
  reviewed_at         timestamptz not null default now()
);
create trigger document_review_immutable before update or delete on hr.document_review
  for each row execute function hr.forbid_mutation();

-- File owner must match the document's employee (no cross-filing).
create function hr.guard_document_version_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from hr.file_reference f join hr.employee_document d on d.id = new.document_id
    where f.id = new.file_reference_id and f.owner_employee_id = d.employee_id and f.bucket = 'employee-documents'
  ) then
    raise exception 'file owner/bucket does not match the document''s employee';
  end if;
  return new;
end $$;
create trigger document_version_owner_guard before insert on hr.document_version
  for each row execute function hr.guard_document_version_owner();

-- Payroll-prep visibility: anything not in good standing, every cycle.
create view hr.document_exceptions with (security_invoker = true) as
  select e.id as employee_id, e.employee_code, e.full_name, c.code as category_code,
         coalesce(d.status::text, 'missing') as status, d.expiry_date
  from hr.employee e
  join hr.document_requirement r on r.employment_category = e.employment_category
                                and r.status = 'approved' and r.is_required
                                and r.valid_during @> current_date
  join hr.document_category c on c.id = r.category_id
  left join hr.employee_document d on d.employee_id = e.id and d.category_id = r.category_id
  where e.status = 'active'
    and (d.id is null
         or d.status in ('missing', 'requested', 'rejected', 'expired')
         or (d.expiry_date is not null and d.expiry_date < current_date));

-- Source: supabase/migrations/20260101000007_compensation_payroll.sql
-- =====================================================================
-- 0007 COMPENSATION, DEDUCTIONS, LOANS, PAYROLL, PAYMENT
-- DESIGN AND SANDBOX ONLY.
--   * non-sandbox payroll runs cannot be inserted (payroll_execution OFF)
--   * payment instructions/transactions cannot be inserted (payment_execution OFF)
--   * tax rule sets cannot be marked verified without a cited source + verifier,
--     and nothing is seeded
-- Both flags are pinned OFF by a CHECK constraint in 0001.
-- =====================================================================

-- ---------------------------------------------------------------------
-- COMPENSATION (effective-dated; only approved rows are ever read)
-- ---------------------------------------------------------------------
create table hr.compensation_plan (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  pay_basis           hr.employment_category not null,
  base_monthly_paisa  bigint not null check (base_monthly_paisa >= 0),
  currency            char(3) not null default 'PKR' check (currency = 'PKR'),
  valid_during        daterange not null,
  status              hr.config_status not null default 'proposed',
  change_request_id   uuid references hr.change_request(id),
  approval_request_id uuid not null references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid,
  constraint compensation_plan_no_overlap
    exclude using gist (employee_id with =, valid_during with &&) where (status = 'approved')
);
create trigger compensation_plan_guard before insert or update on hr.compensation_plan
  for each row execute function hr.guard_approved_status();

create table hr.incentive_rule (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid references hr.employee(id),     -- NULL = applies via plan/category
  pay_basis           hr.employment_category,
  rule_definition     jsonb not null,                      -- design only; interpreted by pure engine
  valid_during        daterange not null,
  status              hr.config_status not null default 'proposed',
  approval_request_id uuid references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  updated_at timestamptz not null default now(), updated_by uuid
);
create trigger incentive_rule_guard before insert or update on hr.incentive_rule
  for each row execute function hr.guard_approved_status();

-- ---------------------------------------------------------------------
-- DEDUCTION PROPOSALS: the ONLY way money leaves a payslip. Raised by a
-- human, approved by Admin. 'late_arrival_hour' exists as a type so the
-- policy can be discussed, but hr.assert_approvable() refuses to approve
-- it while late_deduction is OFF.
-- ---------------------------------------------------------------------
create type hr.deduction_kind as enum (
  'late_arrival_hour',      -- PENDING LEGAL REVIEW
  'unapproved_absence', 'half_day', 'fine', 'damage', 'advance_recovery', 'other');

create table hr.deduction_proposal (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references hr.employee(id),
  kind                hr.deduction_kind not null,
  applies_to_month    date not null check (extract(day from applies_to_month) = 1),
  source_exception_ids uuid[] not null default '{}',
  proposed_amount_paisa bigint check (proposed_amount_paisa > 0),
  basis_explanation   text not null,
  proposed_by         uuid not null default hr.current_auth_user(),
  proposed_at         timestamptz not null default now(),
  approval_request_id uuid not null unique references hr.approval_request(id)
);
create trigger deduction_proposal_immutable before update or delete on hr.deduction_proposal
  for each row execute function hr.forbid_mutation();

-- ---------------------------------------------------------------------
-- LOANS: fixed instalment, Admin-approved changes only. Ledger is
-- insert-only. An unpaid balance carries forward; instalment does NOT
-- auto-increase (a change is a new approved loan_account revision).
-- ---------------------------------------------------------------------
create table hr.loan_account (
  id                   uuid primary key default gen_random_uuid(),
  series_id            uuid not null,
  revision_no          int not null check (revision_no >= 1),
  employee_id          uuid not null references hr.employee(id),
  principal_paisa      bigint not null check (principal_paisa > 0),
  instalment_paisa     bigint not null check (instalment_paisa > 0),
  first_instalment_month date not null check (extract(day from first_instalment_month) = 1),
  reason               text not null,
  approval_request_id  uuid not null references hr.approval_request(id),
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  unique (series_id, revision_no)
);
create trigger loan_account_immutable before update or delete on hr.loan_account
  for each row execute function hr.forbid_mutation();

create table hr.loan_transaction (
  id              uuid primary key default gen_random_uuid(),
  loan_series_id  uuid not null,
  employee_id     uuid not null references hr.employee(id),
  kind            text not null check (kind in ('disbursement', 'instalment_recovered', 'instalment_missed', 'adjustment', 'write_off')),
  amount_paisa    bigint not null,              -- signed: + increases balance owed, - reduces it
  for_month       date,
  payroll_line_id uuid,                         -- FK below
  approval_request_id uuid references hr.approval_request(id),
  note            text not null,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user()
);
create trigger loan_transaction_immutable before update or delete on hr.loan_transaction
  for each row execute function hr.forbid_mutation();

create view hr.loan_balance with (security_invoker = true) as
  select loan_series_id, employee_id, sum(amount_paisa)::bigint as balance_paisa
  from hr.loan_transaction group by loan_series_id, employee_id;

-- ---------------------------------------------------------------------
-- TAX (design only). Rows can exist as drafts; 'verified' needs a cited
-- official source and a named verifier. NOTHING SEEDED.
-- ---------------------------------------------------------------------
create table hr.tax_rule_set (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  tax_year         daterange not null,
  rules            jsonb not null,
  status           text not null default 'draft' check (status in ('draft', 'verified', 'retired')),
  official_source  text,
  verified_by      uuid,
  verified_at      timestamptz,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  check (status <> 'verified' or (official_source is not null and verified_by is not null and verified_at is not null))
);

-- =====================================================================
-- PAYROLL VERSIONING
--
--   payroll_period  1 per calendar month (1st..last day)
--   payroll_run     N versions per period; v1, v2 (reopen), ...
--   payroll_line    1 per employee per run; editable ONLY while run = draft
--   payroll_approval  Admin approves an exact (version, line count, total,
--                     content hash). Any line change after review breaks
--                     the hash and the approval is refused.
--   payroll_snapshot  insert-only frozen copy, written at lock
--   payroll_payable   per (period, employee): the single place that knows
--                     "approved net vs paid vs in flight". Payment
--                     instructions are checked against it under a row lock,
--                     which is what makes duplicate payment impossible
--                     across versions.
-- =====================================================================
create table hr.payroll_period (
  id           uuid primary key default gen_random_uuid(),
  period_month date not null unique check (extract(day from period_month) = 1),
  starts_on    date not null,
  ends_on      date not null,
  created_at timestamptz not null default now(), created_by uuid default hr.current_auth_user(),
  check (starts_on = period_month and ends_on = (period_month + interval '1 month' - interval '1 day')::date)
);

create type hr.payroll_run_status as enum (
  'draft', 'under_review', 'approved', 'locked', 'superseded', 'paid', 'partially_paid');

create table hr.payroll_run (
  id                uuid primary key default gen_random_uuid(),
  period_id         uuid not null references hr.payroll_period(id),
  version           int not null check (version >= 1),
  is_sandbox        boolean not null default true,
  status            hr.payroll_run_status not null default 'draft',
  engine_version    text not null,
  prepared_by       uuid not null default hr.current_auth_user(),
  prepared_at       timestamptz not null default now(),
  supersedes_run_id uuid references hr.payroll_run(id),
  reopen_reason     text,
  reopen_approval_request_id uuid references hr.approval_request(id),
  updated_at timestamptz not null default now(), updated_by uuid,
  unique (period_id, version, is_sandbox),
  check ((version = 1) = (supersedes_run_id is null)),
  check (version = 1 or (reopen_reason is not null and reopen_approval_request_id is not null))
);
-- At most one live (non-superseded, non-draft) real run per period.
create unique index payroll_run_one_live_per_period on hr.payroll_run (period_id)
  where not is_sandbox and status in ('under_review', 'approved', 'locked', 'paid', 'partially_paid');

create function hr.guard_payroll_run() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not new.is_sandbox and not hr.flag_enabled('payroll_execution') then
    raise exception 'payroll_execution is OFF: only sandbox runs may be created';
  end if;
  if tg_op = 'UPDATE' then
    if new.is_sandbox <> old.is_sandbox or new.period_id <> old.period_id or new.version <> old.version then
      raise exception 'payroll_run identity columns are immutable';
    end if;
    -- The API (hr_app) may only move draft <-> under_review. Everything
    -- else goes through the security-definer functions below.
    if current_user = 'hr_app' and not (
         (old.status = 'draft' and new.status = 'under_review') or
         (old.status = 'under_review' and new.status = 'draft')) then
      raise exception 'status change % -> % must use the approve/lock/reopen functions', old.status, new.status;
    end if;
  end if;
  return new;
end $$;
create trigger payroll_run_guard before insert or update on hr.payroll_run
  for each row execute function hr.guard_payroll_run();

create table hr.payroll_line (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references hr.payroll_run(id),
  employee_id            uuid not null references hr.employee(id),
  compensation_plan_id   uuid references hr.compensation_plan(id),
  attendance_computation_ids uuid[] not null,
  scheduled_days         int not null check (scheduled_days > 0),       -- employee's OWN scheduled days
  eligible_days          numeric(6,3) not null check (eligible_days >= 0),
  base_monthly_paisa     bigint not null check (base_monthly_paisa >= 0),
  prorated_base_paisa    bigint not null check (prorated_base_paisa >= 0),
  components             jsonb not null default '[]',  -- [{kind, source_table, source_id, amount_paisa}]
  gross_paisa            bigint not null,
  total_deductions_paisa bigint not null check (total_deductions_paisa >= 0),
  net_paisa              bigint not null,
  exceptions_snapshot    jsonb not null default '[]',  -- missing docs, open attendance exceptions at prep time
  unique (run_id, employee_id),
  check (eligible_days <= scheduled_days),
  check (net_paisa = gross_paisa - total_deductions_paisa)
);

create function hr.guard_payroll_line() returns trigger
language plpgsql set search_path = '' as $$
declare v_status hr.payroll_run_status;
begin
  select status into v_status from hr.payroll_run where id = coalesce(new.run_id, old.run_id);
  if v_status <> 'draft' then
    raise exception 'payroll lines can only change while the run is draft (run is %)', v_status;
  end if;
  return coalesce(new, old);
end $$;
create trigger payroll_line_guard before insert or update or delete on hr.payroll_line
  for each row execute function hr.guard_payroll_line();

alter table hr.loan_transaction add constraint loan_transaction_line_fk
  foreign key (payroll_line_id) references hr.payroll_line(id);

-- Canonical fingerprint of a run's lines.
create function hr.payroll_run_fingerprint(p_run uuid,
  out line_count int, out total_net_paisa bigint, out content_hash bytea)
language sql stable security definer set search_path = '' as $$
  select count(*)::int,
         coalesce(sum(net_paisa), 0)::bigint,
         sha256(convert_to(coalesce(string_agg(concat_ws('|',
             employee_id, compensation_plan_id, scheduled_days, eligible_days, base_monthly_paisa,
             prorated_base_paisa, components::text, gross_paisa, total_deductions_paisa, net_paisa),
           E'\n' order by employee_id), ''), 'UTF8'))
  from hr.payroll_line where run_id = p_run
$$;

create table hr.payroll_approval (
  id                      uuid primary key default gen_random_uuid(),
  run_id                  uuid not null unique references hr.payroll_run(id),
  approved_line_count     int not null,
  approved_total_net_paisa bigint not null,
  approved_content_hash   bytea not null,
  approved_by             uuid not null default hr.current_auth_user(),
  approved_at             timestamptz not null default now(),
  note                    text not null
);

create function hr.on_payroll_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_run; f record;
begin
  select * into r from hr.payroll_run where id = new.run_id for update;
  if r.status <> 'under_review' then raise exception 'run must be under_review to approve (is %)', r.status; end if;
  if not hr.is_admin() then raise exception 'only Admin may approve payroll'; end if;
  if new.approved_by is distinct from hr.current_auth_user() then raise exception 'approved_by must be the acting user'; end if;
  if new.approved_by = r.prepared_by then raise exception 'segregation of duties: preparer cannot approve'; end if;
  select * into f from hr.payroll_run_fingerprint(new.run_id);
  if f.line_count <> new.approved_line_count or f.total_net_paisa <> new.approved_total_net_paisa
     or f.content_hash <> new.approved_content_hash then
    raise exception 'approval does not match the current run contents (version %, % lines, total %)',
      r.version, f.line_count, f.total_net_paisa;
  end if;
  update hr.payroll_run set status = 'approved' where id = r.id;
  return new;
end $$;
create trigger payroll_approval_apply before insert on hr.payroll_approval
  for each row execute function hr.on_payroll_approval();
create trigger payroll_approval_immutable before update or delete on hr.payroll_approval
  for each row execute function hr.forbid_mutation();

create table hr.payroll_snapshot (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null unique references hr.payroll_run(id),
  approval_id   uuid not null unique references hr.payroll_approval(id),
  content       jsonb not null,      -- full lines + inputs + config ids, as locked
  content_hash  bytea not null,
  locked_by     uuid not null,
  locked_at     timestamptz not null default now()
);
create trigger payroll_snapshot_immutable before update or delete on hr.payroll_snapshot
  for each row execute function hr.forbid_mutation();
create trigger payroll_snapshot_no_truncate before truncate on hr.payroll_snapshot
  for each statement execute function hr.forbid_mutation();

-- One row per (period, employee). The ONLY mutable money ledger, changed
-- only by security-definer functions holding a row lock.
create table hr.payroll_payable (
  period_id               uuid not null references hr.payroll_period(id),
  employee_id             uuid not null references hr.employee(id),
  approved_net_paisa      bigint not null check (approved_net_paisa >= 0),   -- from latest LOCKED run
  source_run_id           uuid not null references hr.payroll_run(id),
  in_flight_paisa         bigint not null default 0 check (in_flight_paisa >= 0),
  confirmed_paid_paisa    bigint not null default 0 check (confirmed_paid_paisa >= 0),
  updated_at              timestamptz not null default now(),
  primary key (period_id, employee_id)
  -- NOTE: no CHECK that paid <= approved: a reopen can LOWER approved net
  -- below what was already paid; that becomes a recovery case surfaced by
  -- reconciliation, never an automatic deduction.
);

create function hr.lock_payroll_run(p_run uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_run; a hr.payroll_approval; f record; v_snap uuid;
begin
  if not hr.is_admin() then raise exception 'only Admin may lock payroll'; end if;
  select * into r from hr.payroll_run where id = p_run for update;
  if r.status <> 'approved' then raise exception 'run must be approved to lock (is %)', r.status; end if;
  select * into a from hr.payroll_approval where run_id = p_run;
  select * into f from hr.payroll_run_fingerprint(p_run);
  if f.content_hash <> a.approved_content_hash then raise exception 'run changed since approval'; end if;
  insert into hr.payroll_snapshot (run_id, approval_id, content, content_hash, locked_by)
  select p_run, a.id,
         jsonb_build_object('run', to_jsonb(r), 'approval', to_jsonb(a),
                            'lines', coalesce(jsonb_agg(to_jsonb(l) order by l.employee_id), '[]')),
         f.content_hash, hr.current_auth_user()
  from hr.payroll_line l where l.run_id = p_run
  returning id into v_snap;
  update hr.payroll_run set status = 'locked' where id = p_run;
  if not r.is_sandbox then
    insert into hr.payroll_payable (period_id, employee_id, approved_net_paisa, source_run_id)
    select r.period_id, l.employee_id, greatest(l.net_paisa, 0), p_run from hr.payroll_line l where l.run_id = p_run
    on conflict (period_id, employee_id) do update
      set approved_net_paisa = excluded.approved_net_paisa, source_run_id = excluded.source_run_id, updated_at = now();
  end if;
  return v_snap;
end $$;

-- Reopen: original run + snapshot untouched except status -> superseded;
-- a new draft version is created. Payments already made stay recorded
-- against the (period, employee) payable, so v2 can only pay the
-- difference.
create function hr.reopen_payroll_run(p_run uuid, p_reason text, p_approval_request uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r hr.payroll_run; v_new uuid;
begin
  if not hr.is_admin() then raise exception 'only Admin may reopen payroll'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reopen reason is required'; end if;
  if not hr.is_approved(p_approval_request) then raise exception 'reopen requires an approved payroll_reopen request'; end if;
  select * into r from hr.payroll_run where id = p_run for update;
  if r.status not in ('locked', 'paid', 'partially_paid') then raise exception 'only locked/paid runs can be reopened'; end if;
  update hr.payroll_run set status = 'superseded' where id = p_run;
  insert into hr.payroll_run (period_id, version, is_sandbox, engine_version, supersedes_run_id,
                              reopen_reason, reopen_approval_request_id)
  values (r.period_id, r.version + 1, r.is_sandbox, r.engine_version, p_run, p_reason, p_approval_request)
  returning id into v_new;
  return v_new;
end $$;

-- Attendance freeze: no new computation over dates whose real payroll
-- is under review or later.
create function hr.guard_attendance_freeze() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from hr.payroll_run pr join hr.payroll_period pp on pp.id = pr.period_id
    where not pr.is_sandbox
      and pr.status in ('under_review', 'approved', 'locked', 'paid', 'partially_paid')
      and daterange(pp.starts_on, pp.ends_on, '[]') && new.covers
  ) then
    raise exception 'attendance for this period is frozen by payroll; reopen payroll first';
  end if;
  return new;
end $$;
create trigger attendance_computation_freeze before insert on hr.attendance_computation
  for each row execute function hr.guard_attendance_freeze();

-- ---------------------------------------------------------------------
-- PAYMENT (design only; inserts refused while payment_execution OFF).
-- INITIATION IS NOT PROOF OF PAYMENT: 'confirmed_paid' requires evidence.
-- ---------------------------------------------------------------------
create type hr.payment_method as enum ('bank_transfer', 'cheque', 'cash');
create type hr.payment_status as enum ('authorized', 'initiated', 'confirmed_paid', 'failed', 'returned', 'cancelled');

create table hr.payment_instruction (
  id                    uuid primary key default gen_random_uuid(),
  period_id             uuid not null,
  employee_id           uuid not null,
  run_id                uuid not null references hr.payroll_run(id),
  amount_paisa          bigint not null check (amount_paisa > 0),
  method                hr.payment_method not null,
  payment_detail_id     uuid references hr.employee_payment_detail(id),   -- verified detail at authorisation
  status                hr.payment_status not null default 'authorized',
  authorized_by         uuid not null default hr.current_auth_user(),
  authorized_at         timestamptz not null default now(),
  retry_of_id           uuid references hr.payment_instruction(id),
  reauthorization_request_id uuid references hr.approval_request(id),
  foreign key (period_id, employee_id) references hr.payroll_payable(period_id, employee_id),
  check (method <> 'bank_transfer' or payment_detail_id is not null),
  check (retry_of_id is null or reauthorization_request_id is not null)
);

create function hr.guard_payment_instruction() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p hr.payroll_payable;
begin
  if not hr.flag_enabled('payment_execution') then
    raise exception 'payment_execution is OFF: payment instructions cannot be created';
  end if;
  select * into p from hr.payroll_payable where period_id = new.period_id and employee_id = new.employee_id for update;
  if new.amount_paisa > p.approved_net_paisa - p.confirmed_paid_paisa - p.in_flight_paisa then
    raise exception 'amount exceeds outstanding payable (duplicate payment prevented)';
  end if;
  if new.retry_of_id is not null and not hr.is_approved(new.reauthorization_request_id) then
    raise exception 'retry requires Admin reauthorisation';
  end if;
  update hr.payroll_payable set in_flight_paisa = in_flight_paisa + new.amount_paisa, updated_at = now()
   where period_id = new.period_id and employee_id = new.employee_id;
  return new;
end $$;
create trigger payment_instruction_guard before insert on hr.payment_instruction
  for each row execute function hr.guard_payment_instruction();

create table hr.payment_transaction (
  id              uuid primary key default gen_random_uuid(),
  instruction_id  uuid not null references hr.payment_instruction(id),
  event           text not null check (event in ('initiated', 'confirmed_paid', 'failed', 'returned', 'cancelled')),
  occurred_at     timestamptz not null,
  recorded_by     uuid not null default hr.current_auth_user(),
  recorded_at     timestamptz not null default now(),
  evidence_id     uuid,           -- FK below; required for confirmed_paid / failed / returned
  note            text not null,
  check (event in ('initiated', 'cancelled') or evidence_id is not null)
);
create trigger payment_transaction_immutable before update or delete on hr.payment_transaction
  for each row execute function hr.forbid_mutation();
create function hr.guard_payment_transaction() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not hr.flag_enabled('payment_execution') then
    raise exception 'payment_execution is OFF';
  end if;
  return new;
end $$;
create trigger payment_transaction_guard before insert on hr.payment_transaction
  for each row execute function hr.guard_payment_transaction();

create table hr.payment_evidence (
  id                uuid primary key default gen_random_uuid(),
  instruction_id    uuid not null references hr.payment_instruction(id),
  kind              text not null check (kind in ('bank_reference', 'bank_statement', 'cheque_issue', 'cheque_clearance',
                                                  'cheque_return', 'cash_receipt', 'return_notice')),
  reference_text    text,
  file_reference_id uuid references hr.file_reference(id),
  -- cheque fields
  cheque_number     text, cheque_issue_date date, cheque_payee text,
  -- cash fields
  cash_recipient_id_last4 text, cash_custodian uuid,
  recorded_by       uuid not null default hr.current_auth_user(),
  recorded_at       timestamptz not null default now(),
  check (reference_text is not null or file_reference_id is not null),
  check (kind not like 'cheque%' or cheque_number is not null),
  check (kind <> 'cash_receipt' or (cash_recipient_id_last4 is not null and cash_custodian is not null and file_reference_id is not null))
);
create trigger payment_evidence_immutable before update or delete on hr.payment_evidence
  for each row execute function hr.forbid_mutation();
alter table hr.payment_transaction add constraint payment_transaction_evidence_fk
  foreign key (evidence_id) references hr.payment_evidence(id);

create table hr.reconciliation (
  id              uuid primary key default gen_random_uuid(),
  period_id       uuid not null references hr.payroll_period(id),
  run_id          uuid not null references hr.payroll_run(id),
  computed        jsonb not null,           -- approved net vs evidence vs unpaid, per employee
  prepared_by     uuid not null default hr.current_auth_user(),
  prepared_at     timestamptz not null default now(),
  signed_off_by   uuid,
  signed_off_at   timestamptz,
  sign_off_note   text,
  check ((signed_off_by is null) = (signed_off_at is null)),
  check (signed_off_by is null or signed_off_by <> prepared_by)
);
create table hr.reconciliation_variance (
  id                uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references hr.reconciliation(id),
  employee_id       uuid not null references hr.employee(id),
  kind              text not null check (kind in ('unpaid', 'overpaid', 'evidence_missing', 'amount_mismatch', 'returned')),
  expected_paisa    bigint not null,
  actual_paisa      bigint not null,
  note              text
);

create table hr.payslip_reference (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references hr.payroll_run(id),
  employee_id       uuid not null references hr.employee(id),
  file_reference_id uuid not null references hr.file_reference(id),
  created_at        timestamptz not null default now(),
  unique (run_id, employee_id)
);

-- ---------------------------------------------------------------------
-- FINAL SETTLEMENT: itemised; each component approved separately;
-- disputed recoveries are flagged and excluded, never deducted.
-- ---------------------------------------------------------------------
create table hr.final_settlement (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null unique references hr.employee(id),
  prepared_by  uuid not null default hr.current_auth_user(),
  prepared_at  timestamptz not null default now(),
  status       text not null default 'draft' check (status in ('draft', 'under_review', 'approved', 'locked')),
  updated_at timestamptz not null default now(), updated_by uuid
);
create table hr.final_settlement_component (
  id                  uuid primary key default gen_random_uuid(),
  settlement_id       uuid not null references hr.final_settlement(id),
  kind                text not null,
  amount_paisa        bigint not null,          -- + payable to employee, - recovery
  basis               text not null,
  is_disputed         boolean not null default false,
  dispute_note        text,
  approval_request_id uuid not null unique references hr.approval_request(id),
  check (not is_disputed or dispute_note is not null)
);

-- ---------------------------------------------------------------------
-- ALERTS, NOTIFICATIONS, RETENTION, LEGAL HOLD
-- ---------------------------------------------------------------------
create table hr.lifecycle_alert (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references hr.employee(id),
  kind            text not null check (kind in ('probation_end', 'contract_end')),
  source_table    text not null check (source_table in ('probation_period', 'employment_contract')),
  source_id       uuid not null,             -- the exact revision that set the end date
  end_date        date not null,
  stage           text not null check (stage in ('initial', 'follow_up', 'final')),
  due_on          date not null,
  created_at      timestamptz not null default now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  action_chosen   text check (action_chosen in ('confirm', 'extend', 'renew', 'revise', 'end')),
  -- Idempotent nightly job: one alert per revision/end-date/stage.
  unique (source_id, end_date, stage)
  -- Alerts never change dates, status or pay. Action creates a NEW revision.
);

create table hr.notification (
  id                   uuid primary key default gen_random_uuid(),
  recipient_auth_user_id uuid not null,
  kind                 text not null,
  subject_table        text,
  subject_id           uuid,
  title                text not null,
  body                 text not null,
  created_at           timestamptz not null default now(),
  read_at              timestamptz
);
create index notification_inbox on hr.notification (recipient_auth_user_id, created_at desc);

create table hr.retention_policy (
  record_category text primary key,
  retain_years    int not null check (retain_years > 0),
  basis_note      text not null,
  status          hr.config_status not null default 'proposed'
);
insert into hr.retention_policy values
  ('payroll_financial', 6, 'Brief: 5 years, but a 6-year tax rule was discussed; longer applies. VERIFY with tax adviser.', 'proposed'),
  ('attendance_raw',    6, 'Feeds payroll; kept as long as payroll. VERIFY.', 'proposed'),
  ('audit_event',       6, 'At least as long as the records it covers. VERIFY.', 'proposed');

create table hr.legal_hold (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid references hr.employee(id),
  record_category text,
  reason          text not null,
  placed_by       uuid not null default hr.current_auth_user(),
  placed_at       timestamptz not null default now(),
  released_by     uuid,
  released_at     timestamptz,
  check (employee_id is not null or record_category is not null)
);

-- Source: supabase/migrations/20260101000008_rls_grants.sql
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

-- Source: supabase/migrations/20260101000009_supabase_storage.sql
-- =====================================================================
-- 0009 SUPABASE STORAGE (skipped automatically on Neon / plain Postgres)
--
-- All buckets are PRIVATE. Normal path: the browser asks FastAPI, FastAPI
-- checks hr.document_version under RLS, then returns a short-lived signed
-- URL (60 s). The storage.objects policies below are defence in depth in
-- case anyone ever uses the Supabase JS client directly.
--
-- Object path conventions (first folder = owning employee id):
--   employee-documents/{employee_id}/{document_id}/v{n}-{sha256[0:12]}.{ext}
--   attendance-imports/{batch_id}/{sha256}.{ext}       (staff only)
--   payment-evidence/{period}/{instruction_id}/{sha256}.{ext}  (admin/auditor)
--   payslips/{employee_id}/{period}/v{run_version}.pdf
-- Original filenames are kept in hr.file_reference, never in the path
-- (paths leak into logs).
-- =====================================================================
do $$
begin
  if not exists (select from information_schema.schemata where schema_name = 'storage') then
    raise notice 'storage schema not present; skipping Supabase storage setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
    ('employee-documents', 'employee-documents', false, 10485760,
       array['application/pdf', 'image/jpeg', 'image/png']),
    ('attendance-imports', 'attendance-imports', false, 20971520,
       array['text/csv', 'text/tab-separated-values', 'text/plain', 'text/html',
             'application/vnd.ms-excel', 'application/octet-stream',
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    ('payment-evidence', 'payment-evidence', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png']),
    ('payslips', 'payslips', false, 5242880, array['application/pdf'])
  on conflict (id) do nothing;

  -- Let Supabase's "authenticated" role call only the identity helpers.
  grant usage on schema hr to authenticated;
  grant execute on function hr.current_auth_user(), hr.current_employee_id(), hr.has_role(hr.app_role),
                            hr.is_staff(), hr.is_admin(), hr.is_auditor(), hr.is_hr() to authenticated;

  execute $p$
    create policy hr_docs_read on storage.objects for select to authenticated using (
      bucket_id = 'employee-documents'
      and (hr.is_staff() or (storage.foldername(name))[1] = hr.current_employee_id()::text))
  $p$;
  execute $p$
    create policy hr_docs_insert on storage.objects for insert to authenticated with check (
      bucket_id = 'employee-documents'
      and (hr.is_staff() or (storage.foldername(name))[1] = hr.current_employee_id()::text))
  $p$;
  execute $p$
    create policy hr_payslips_read on storage.objects for select to authenticated using (
      bucket_id = 'payslips'
      and (hr.is_staff() or (storage.foldername(name))[1] = hr.current_employee_id()::text))
  $p$;
  execute $p$
    create policy hr_imports_staff on storage.objects for select to authenticated using (
      bucket_id = 'attendance-imports' and hr.is_staff())
  $p$;
  execute $p$
    create policy hr_imports_staff_insert on storage.objects for insert to authenticated with check (
      bucket_id = 'attendance-imports' and hr.is_staff())
  $p$;
  execute $p$
    create policy hr_payment_evidence_read on storage.objects for select to authenticated using (
      bucket_id = 'payment-evidence' and (hr.is_admin() or hr.is_auditor()))
  $p$;
  -- No UPDATE or DELETE policies on any hr bucket: objects are write-once.
end $$;

-- Source: supabase/migrations/20260101000010_app_support.sql
-- =====================================================================
-- 0010 APP SUPPORT (found while writing the API + worker)
--   * document status is DERIVED from version/review events, so nobody
--     hand-edits "accepted"; employees can self-upload once HR has
--     requested a document
--   * worker records why a batch failed to parse
--   * near-duplicate threshold becomes a config row, not a constant
-- =====================================================================

-- Worker-visible parse failure reason (column grant: worker only)
alter table hr.attendance_import_batch add column worker_error text;
grant update (worker_error) on hr.attendance_import_batch to hr_worker;

insert into hr.policy_config (key, value, valid_during, status, pending_legal_review, source_reference) values
  ('attendance.near_duplicate_seconds', '60', daterange('2026-01-01', null), 'proposed', false,
   'Sample AUGUST file: double presses 1-44 s apart. Review flag only; never discards a punch.');

-- New version uploaded -> document becomes 'uploaded'
create function hr.on_document_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update hr.employee_document set status = 'uploaded' where id = new.document_id;
  return new;
end $$;
create trigger document_version_status after insert on hr.document_version
  for each row execute function hr.on_document_version();

-- Review -> accepted/rejected (+ confirmed expiry). Only the LATEST
-- version's review moves the status.
create function hr.on_document_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_doc uuid; v_latest uuid;
begin
  if not hr.is_staff() then raise exception 'only HR/Admin may review documents'; end if;
  select document_id into v_doc from hr.document_version where id = new.document_version_id;
  select id into v_latest from hr.document_version where document_id = v_doc order by version_no desc limit 1;
  if v_latest <> new.document_version_id then
    raise exception 'only the latest version of a document can be reviewed';
  end if;
  update hr.employee_document
     set status = new.decision::hr.document_status,
         expiry_date = coalesce(new.expiry_date_confirmed, expiry_date)
   where id = v_doc;
  return new;
end $$;
create trigger document_review_status after insert on hr.document_review
  for each row execute function hr.on_document_review();

-- Employees may see reviews of their own documents (policy existed via
-- join); allow HR to request documents for an employee in one step.
grant execute on function hr.on_document_version(), hr.on_document_review() to hr_app;

-- Source: supabase/migrations/20260101000011_pay_rules.sql
-- =====================================================================
-- 0011 OWNER PAY RULES (decided 2026-10-19) + compensation approvals
--   daily salary   = monthly salary / 22
--   late > grace   = 4% of that day's salary
--   absent day     = 1 full day's salary
-- Seeded as PROPOSED: an Admin activates them (Settings > Submit, then a
-- second Admin approves). Reports show deductions as CALCULATED until
-- payroll is switched on, which still requires a reviewed migration.
-- =====================================================================
insert into hr.policy_config (key, value, valid_during, status, pending_legal_review, source_reference) values
  ('payroll.working_days_divisor', '22', daterange('2026-01-01', null), 'proposed', false,
   'Owner decision 2026-10-19: daily salary = monthly salary / 22'),
  ('attendance.late_penalty_percent_of_day', '4', daterange('2026-01-01', null), 'proposed', false,
   'Owner decision 2026-10-19: late beyond the grace period = 4% of that day''s salary. Legal check recommended (wage-deduction limits).'),
  ('attendance.absence_penalty_days', '1', daterange('2026-01-01', null), 'proposed', false,
   'Owner decision 2026-10-19: absent on a working day = 1 day''s salary');

-- Reports read punches for a month by local device time.
create index if not exists raw_punch_local_ts on hr.raw_punch (device_local_ts);

-- Source: supabase/migrations/20260101000012_single_admin_mode.sql
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

-- Source: supabase/migrations/20260101000013_payroll_on.sql
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

-- Source: supabase/migrations/20260101000014_fix_auto_join_date.sql
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

-- Source: supabase/migrations/20260101000015_admin_action_audit.sql
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

-- Source: supabase/migrations/20260101000016_employee_requests.sql
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

-- Record the included migrations so the Supabase CLI and scripts/migrate.ts
-- do not try to apply them again after this SQL Editor setup.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations (version, statements, name) values
  ('20260101000001', ARRAY[]::text[], 'foundation'),
  ('20260101000002', ARRAY[]::text[], 'approvals'),
  ('20260101000003', ARRAY[]::text[], 'org_employee'),
  ('20260101000004', ARRAY[]::text[], 'calendar_leave'),
  ('20260101000005', ARRAY[]::text[], 'attendance'),
  ('20260101000006', ARRAY[]::text[], 'documents'),
  ('20260101000007', ARRAY[]::text[], 'compensation_payroll'),
  ('20260101000008', ARRAY[]::text[], 'rls_grants'),
  ('20260101000009', ARRAY[]::text[], 'supabase_storage'),
  ('20260101000010', ARRAY[]::text[], 'app_support'),
  ('20260101000011', ARRAY[]::text[], 'pay_rules'),
  ('20260101000012', ARRAY[]::text[], 'single_admin_mode'),
  ('20260101000013', ARRAY[]::text[], 'payroll_on'),
  ('20260101000014', ARRAY[]::text[], 'fix_auto_join_date'),
  ('20260101000015', ARRAY[]::text[], 'admin_action_audit'),
  ('20260101000016', ARRAY[]::text[], 'employee_requests')
on conflict (version) do nothing;
