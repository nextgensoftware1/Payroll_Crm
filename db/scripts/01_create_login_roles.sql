-- Run ONCE per environment as the database owner (Supabase: SQL editor or psql as postgres),
-- AFTER `alembic upgrade head`. Passwords are supplied at run time and never stored in git:
--   psql "$OWNER_URL" -v api_pw="$(openssl rand -base64 24)" -v worker_pw="$(openssl rand -base64 24)" -f 01_create_login_roles.sql
-- Then put the passwords into the backend secret store (DATABASE_URL / WORKER_DATABASE_URL).
create role hr_api_login    login noinherit password :'api_pw';
create role hr_worker_login login noinherit password :'worker_pw';
grant hr_app    to hr_api_login;      -- API does SET LOCAL ROLE hr_app per request
grant hr_worker to hr_worker_login;   -- worker does SET LOCAL ROLE hr_worker per transaction
alter role hr_api_login    set statement_timeout = '15s';
alter role hr_worker_login set statement_timeout = '5min';
