-- Step 15, audit row P8: an agency may keep the client's written authority on file as a stored document, beside the tick
-- (sponsorship_statement.written_authority_on_file stays the rule; the document is optional). One row per uploaded copy, on the agency's own
-- job that names a client. The same file store, limits and retention as case documents: PDF, JPEG or PNG up to 4 MiB, at most 20 stored per
-- job, and the copy is deleted 30 days after the job closes (the `services_case_copy` setting, retention rule 43). The row stays as the record
-- that a document was on file. No row level security, as every portal table: apps/portal/lib/files.ts filters by the login's own company.
set role portal_owner;

create table job_authority_document(
  id bigint generated always as identity primary key, job_id bigint not null references job(id) on delete cascade,
  organisation_id bigint not null references organisation(id), uploaded_by_membership_id bigint references membership(id),
  storage_key text, file_name text, content_type text, byte_size integer,
  uploaded_at timestamptz not null default now(), copy_deleted_at timestamptz,
  check ((storage_key is null) = (copy_deleted_at is not null)));
create index job_authority_document_job_idx on job_authority_document(job_id);
create index job_authority_document_org_idx on job_authority_document(organisation_id);
create index job_authority_document_member_idx on job_authority_document(uploaded_by_membership_id);

grant select on job_authority_document to app_portal, app_admin;
grant insert (job_id, organisation_id, uploaded_by_membership_id, storage_key, file_name, content_type, byte_size) on job_authority_document to app_portal;

-- Retention rule 43: the copy 30 days after the job closes, as rule 18 does for a closed case's documents. Rule 32 (a closed job deleted after
-- 36 months) cascades to the row. The rest of the function is its 0011 text, edited in place and checked.
do $m$
declare
  old_sql constant text := $o$     $q$with d as (delete from staff_rate_limit where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null)
  ) as t(ord$o$;
  new_sql constant text := $o$     $q$with d as (delete from staff_rate_limit where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (43, 'services_case_copy', 'job_authority_document', $q$select d.id::text as id from job_authority_document d join job j on j.id = d.job_id
          where j.closed_at < now() - make_interval(days => $1) and d.storage_key is not null$q$, null, 'sql',
     $q$with t as (select id, storage_key from job_authority_document where id = any($2::bigint[]) for update),
             u as (update job_authority_document d set storage_key = null, file_name = null, copy_deleted_at = now() from t where d.id = t.id returning 1)
        select (select count(*) from u)::int, coalesce((select array_agg(storage_key) from t), '{}')$q$, null)
  ) as t(ord$o$;
  def text := pg_get_functiondef('private.retention_rules()'::regprocedure);
begin
  if (length(def) - length(replace(def, old_sql, ''))) <> length(old_sql) then raise exception '0038: the end of rule 42 not found exactly once'; end if;
  execute replace(def, old_sql, new_sql);
end $m$;

reset role;
