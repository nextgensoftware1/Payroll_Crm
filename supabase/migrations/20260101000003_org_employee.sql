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
