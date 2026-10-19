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
