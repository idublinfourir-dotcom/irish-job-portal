-- Step 15 Q5: staff link DETE employer names to companies in the admin panel, instead of only by hand with dete-cli.ts link. Tests:
-- packages/db/test/dete-links-admin.test.ts.
--   1. dete_link_rejection: a suggestion staff turned down (a DETE name and a company), so the suggestion list (dete-links.ts) never offers it again.
--      An unlink also writes one. app_admin reads it; only the functions below write it.
--   2. private.dete_link(staff, dete_name, organisation): an account reviewer (matrix 20c "First-time sponsor review (CRO lookup, DETE match)")
--      adds the DETE name to the company as a legal name from 'dete' (as the company seed does; an existing name of the same normalised form on
--      that company is used instead), points every DETE row of the name at it, refreshes the permit history labels and writes one audit row.
--      Refused when the name is linked to another company, or when another company already has a name of that form (staff merge first).
--   3. private.dete_unlink(staff, dete_name): an account reviewer takes the link off every row of the name, removes the name the link added when
--      nothing else points at it, remembers the pair as rejected, refreshes the labels and writes one audit row.
--   4. private.dete_reject(staff, dete_name, organisation): an account reviewer turns a suggestion down; one audit row.
-- One person is enough for each: the matrix row has no 2P mark, and the audit row keeps every id, so a wrong link is undone with an unlink.
set role portal_owner;

-- ===== 1. rejected suggestions
create table dete_link_rejection(
  dete_name text not null, organisation_id bigint not null references organisation(id),
  rejected_by_staff_id text not null references staff_user(id), rejected_at timestamptz not null default now(),
  primary key (dete_name, organisation_id));
create index dete_link_rejection_org_idx on dete_link_rejection(organisation_id);
create index dete_link_rejection_staff_idx on dete_link_rejection(rejected_by_staff_id);
grant select on dete_link_rejection to app_admin;

-- The company a link may point at: exists and is not merged away. Locks it so a merge waits for the link.
create function private.dete_link_company(p_org bigint) returns organisation language plpgsql security definer set search_path = public, pg_temp as $$
declare o organisation;
begin
  select * into o from organisation where id = p_org for no key update;
  if o.id is null then raise exception 'dete link refused: NOT_FOUND' using errcode = 'P0001'; end if;
  if o.merged_into_id is not null then raise exception 'dete link refused: COMPANY_MERGED' using errcode = 'P0001'; end if;
  return o;
end $$;

-- The DETE name's rows, locked; refused when there are none.
create function private.dete_link_rows(p_name text) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from dete_permit_count where dete_name = p_name for update;
  if not found then raise exception 'dete link refused: NAME_NOT_FOUND' using errcode = 'P0001'; end if;
end $$;

-- ===== 2. link
create function private.dete_link(p_staff text, p_name text, p_org bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o organisation; v_norm text := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g'));
  v_other bigint; v_name organisation_name; v_added boolean := false; v_rows integer; v_labels integer;
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer'], 'NOT_DETE_LINK_STAFF');
  o := private.dete_link_company(p_org);
  perform private.dete_link_rows(p_name);
  select n.organisation_id into v_other from dete_permit_count d join organisation_name n on n.id = d.organisation_name_id
   where d.dete_name = p_name and n.organisation_id is distinct from o.id limit 1;
  if found then raise exception 'dete link refused: LINKED_ELSEWHERE' using errcode = 'P0001'; end if;
  if v_norm = '' then raise exception 'dete link refused: BAD_NAME' using errcode = 'P0001'; end if;
  -- the name of this form on this company (a legal one first), or the refusal when the form belongs to another company or to none
  select * into v_name from organisation_name where normalised_name = v_norm order by (organisation_id = o.id) desc nulls last, (kind = 'legal') desc, id limit 1;
  if v_name.id is not null and v_name.organisation_id is distinct from o.id then raise exception 'dete link refused: NAME_TAKEN' using errcode = 'P0001'; end if;
  if v_name.id is null then
    insert into organisation_name(organisation_id, name, normalised_name, kind, source, confirmed_by_staff_id, confirmed_at)
      values (o.id, p_name, v_norm, 'legal', 'dete', p_staff, now()) returning * into v_name;
    v_added := true;
  end if;
  update dete_permit_count set organisation_name_id = v_name.id where dete_name = p_name and organisation_name_id is distinct from v_name.id;
  get diagnostics v_rows = row_count;
  delete from dete_link_rejection where dete_name = p_name and organisation_id = o.id; -- a link wins over an earlier "no"
  v_labels := private.refresh_permit_history();
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, after, source)
    values ('admin_action', p_staff, 'organisation.dete_link', 'organisation', o.id::text, '{organisation_name_id}',
            jsonb_build_object('dete_name', p_name, 'organisation_name_id', v_name.id, 'name_added', v_added, 'rows', v_rows), 'panel');
  return jsonb_build_object('organisationId', o.id::text, 'organisationNameId', v_name.id::text, 'nameAdded', v_added, 'rowsLinked', v_rows,
    'labelsChanged', v_labels, 'permitHistory', (select permit_history from organisation where id = o.id));
end $$;

-- ===== 3. unlink
create function private.dete_unlink(p_staff text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids bigint[]; v_orgs bigint[]; v_rows integer; v_removed bigint[]; v_labels integer;
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer'], 'NOT_DETE_LINK_STAFF');
  perform private.dete_link_rows(p_name);
  select array_agg(distinct d.organisation_name_id), array_agg(distinct n.organisation_id) filter (where n.organisation_id is not null) into v_ids, v_orgs
    from dete_permit_count d join organisation_name n on n.id = d.organisation_name_id where d.dete_name = p_name;
  if v_ids is null then raise exception 'dete link refused: NOT_LINKED' using errcode = 'P0001'; end if;
  update dete_permit_count set organisation_name_id = null where dete_name = p_name and organisation_name_id is not null;
  get diagnostics v_rows = row_count;
  -- a DETE name the link (or the seed) added goes with it when nothing else points at it, so it neither stays a wrong legal name nor blocks a new link
  with gone as (delete from organisation_name n where n.id = any(v_ids) and n.source = 'dete'
      and not exists (select 1 from dete_permit_count d where d.organisation_name_id = n.id)
      and not exists (select 1 from job j where j.permit_employer_name_id = n.id)
      and not exists (select 1 from review_item r where r.organisation_name_id = n.id) returning n.id)
  select coalesce(array_agg(id order by id), '{}') into v_removed from gone;
  insert into dete_link_rejection(dete_name, organisation_id, rejected_by_staff_id) select p_name, u, p_staff from unnest(v_orgs) u on conflict do nothing;
  v_labels := private.refresh_permit_history();
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, source)
    select 'admin_action', p_staff, 'organisation.dete_unlink', 'organisation', u::text, '{organisation_name_id}',
           jsonb_build_object('dete_name', p_name, 'organisation_name_ids', to_jsonb(v_ids)), jsonb_build_object('rows', v_rows, 'names_removed', to_jsonb(v_removed)), 'panel'
      from unnest(coalesce(v_orgs, array[null::bigint])) u;
  return jsonb_build_object('rowsUnlinked', v_rows, 'namesRemoved', v_removed, 'labelsChanged', v_labels,
    'organisationIds', (select coalesce(jsonb_agg(u::text order by u), '[]') from unnest(v_orgs) u));
end $$;

-- ===== 4. reject a suggestion
create function private.dete_reject(p_staff text, p_name text, p_org bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o organisation;
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer'], 'NOT_DETE_LINK_STAFF');
  o := private.dete_link_company(p_org);
  perform private.dete_link_rows(p_name);
  insert into dete_link_rejection(dete_name, organisation_id, rejected_by_staff_id) values (p_name, o.id, p_staff) on conflict do nothing;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, source)
    values ('admin_action', p_staff, 'organisation.dete_reject', 'organisation', o.id::text, jsonb_build_object('dete_name', p_name), 'panel');
  return jsonb_build_object('organisationId', o.id::text, 'rejected', true);
end $$;

revoke all on function private.dete_link_company(bigint), private.dete_link_rows(text), private.dete_link(text, text, bigint), private.dete_unlink(text, text),
  private.dete_reject(text, text, bigint) from public, anon, authenticated, service_role;
grant execute on function private.dete_link(text, text, bigint), private.dete_unlink(text, text), private.dete_reject(text, text, bigint) to app_admin;

reset role;
