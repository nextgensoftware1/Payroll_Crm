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
