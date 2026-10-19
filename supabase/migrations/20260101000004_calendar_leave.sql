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
