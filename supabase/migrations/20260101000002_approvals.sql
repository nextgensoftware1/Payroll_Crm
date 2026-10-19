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
