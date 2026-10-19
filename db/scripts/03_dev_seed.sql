-- DEVELOPMENT ONLY. Reference data so the UI is usable on day one.
-- Run as owner after 01 and 02. Shift times are PLACEHOLDERS: replace with your real shifts.
insert into hr.department (code, name) values ('OPS', 'Operations'), ('SALES', 'Sales'), ('ADMIN', 'Administration')
  on conflict (code) do nothing;
insert into hr.device (name, location_code, datetime_format, status_label_map)
  values ('Main entrance', '101', 'M/D/YYYY h:mm:ss AM', '{"C/In":"in","C/Out":"out"}')
  on conflict do nothing;
insert into hr.document_category (code, name, sensitivity, has_expiry) values
  ('CNIC', 'CNIC copy', 'highly_sensitive', true),
  ('CONTRACT', 'Signed employment contract', 'sensitive', false),
  ('BANK_LETTER', 'Bank account letter', 'highly_sensitive', false)
  on conflict (code) do nothing;
-- Placeholder night shift seen in the August sample (clock-in ~17:00, out ~03:00).
insert into hr.shift (code, name, start_local, end_local, unpaid_break_minutes,
                      clock_in_window_before_minutes, clock_out_window_after_minutes)
  values ('NIGHT-PLACEHOLDER', 'Night shift (PLACEHOLDER: confirm times)', '17:00', '02:00', 60, 180, 240)
  on conflict (code) do nothing;
insert into hr.work_calendar (code, name) values ('MON-FRI-NIGHT', 'Mon-Fri night (placeholder)') on conflict (code) do nothing;
insert into hr.work_calendar_rule (calendar_id, iso_weekday, shift_id, valid_during)
  select c.id, d, case when d <= 5 then s.id end, daterange('2026-01-01', null)
  from hr.work_calendar c, hr.shift s, generate_series(1, 7) d
  where c.code = 'MON-FRI-NIGHT' and s.code = 'NIGHT-PLACEHOLDER'
    and not exists (select 1 from hr.work_calendar_rule r where r.calendar_id = c.id);
-- Document REQUIREMENTS are deliberately not seeded: HR/legal must decide
-- what is genuinely required per worker type (data minimisation), and an
-- Admin approves each requirement in the app.
