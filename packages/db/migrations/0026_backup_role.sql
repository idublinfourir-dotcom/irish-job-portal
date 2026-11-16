-- Step 15 (the storage wave, decisions #115 and #126): the login the daily backup uses. It can read every table, view and sequence (pg_read_all_data)
-- and nothing else: no write right anywhere, no execute on any private function, no way to switch to another app role.
-- Like 0000_roles.sql: the role belongs to the whole server, so it is created only if missing, and no password is set here. The engineer sets it
-- on the live database by hand; the tests set their own.
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_backup') then
    create role app_backup login;
  end if;
end
$$;
grant pg_read_all_data to app_backup;
-- A backup holds one connection for the snapshot and one for pg_dump.
alter role app_backup connection limit 3;
-- Every app role has timeouts (0000_roles.sql, section 2.2). A dump of the biggest table takes seconds, so 10 minutes only stops a hung statement,
-- and waiting a minute for a lock stops a backup stuck behind a migration. No idle-in-transaction timeout: the backup deliberately keeps its snapshot
-- transaction open, idle, while pg_dump runs.
alter role app_backup set statement_timeout = '10min';
alter role app_backup set lock_timeout = '1min';
