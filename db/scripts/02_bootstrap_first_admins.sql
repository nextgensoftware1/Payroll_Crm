-- The app requires an existing Admin to grant roles, and nobody may grant
-- themselves a role. This one-off script, run as the owner, creates the
-- first TWO Admins (two, so segregation of duties works from day one).
--
-- 1. Create both users in Supabase: Authentication > Users > Add user.
-- 2. Copy their user IDs, then run:
--    psql "$OWNER_URL" -v admin1=<uuid> -v admin2=<uuid> -v reason='Initial setup by <name>' -f 02_bootstrap_first_admins.sql
insert into hr.user_role (auth_user_id, role, granted_by, grant_reason) values
  (:'admin1', 'admin', :'admin2', :'reason'),
  (:'admin2', 'admin', :'admin1', :'reason');
-- Everything after this (HR, managers, employees) is granted in the app and audited.
