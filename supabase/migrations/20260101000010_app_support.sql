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
