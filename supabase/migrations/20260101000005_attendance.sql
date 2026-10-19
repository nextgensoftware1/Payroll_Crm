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
