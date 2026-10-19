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
