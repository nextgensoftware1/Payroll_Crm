-- =====================================================================
-- 0011 OWNER PAY RULES (decided 2026-10-19) + compensation approvals
--   daily salary   = monthly salary / 22
--   late > grace   = 4% of that day's salary
--   absent day     = 1 full day's salary
-- Seeded as PROPOSED: an Admin activates them (Settings > Submit, then a
-- second Admin approves). Reports show deductions as CALCULATED until
-- payroll is switched on, which still requires a reviewed migration.
-- =====================================================================
insert into hr.policy_config (key, value, valid_during, status, pending_legal_review, source_reference) values
  ('payroll.working_days_divisor', '22', daterange('2026-01-01', null), 'proposed', false,
   'Owner decision 2026-10-19: daily salary = monthly salary / 22'),
  ('attendance.late_penalty_percent_of_day', '4', daterange('2026-01-01', null), 'proposed', false,
   'Owner decision 2026-10-19: late beyond the grace period = 4% of that day''s salary. Legal check recommended (wage-deduction limits).'),
  ('attendance.absence_penalty_days', '1', daterange('2026-01-01', null), 'proposed', false,
   'Owner decision 2026-10-19: absent on a working day = 1 day''s salary');

-- Reports read punches for a month by local device time.
create index if not exists raw_punch_local_ts on hr.raw_punch (device_local_ts);
