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
