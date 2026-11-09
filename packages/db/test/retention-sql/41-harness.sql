-- C3 test harness, run as postgres in database c3 (and c3 only)
create schema if not exists c3t;
create table if not exists c3t.result(n serial primary key, grp text, name text, ok boolean, detail text);
create or replace function c3t.res(g text, nm text, ok boolean, d text default '') returns void language sql as
$$ insert into c3t.result(grp,name,ok,detail) values (g,nm,coalesce(ok,false),d) $$;
-- drain: calls run_retention until rule is null. Reports the call list; flags STUCK if a rule returns done=0 with left>0 twice in a row, or more than max calls.
create or replace function c3t.drain(maxcalls int default 80, batch int default 1000) returns jsonb language plpgsql as $$
declare r jsonb; calls jsonb := '[]'; i int := 0; stuck int := 0; prev text := ''; cur text; skipped jsonb := '[]'; keys jsonb := '[]';
begin
  loop
    i := i + 1;
    r := private.run_retention(batch);
    skipped := skipped || coalesce(r->'skipped','[]'::jsonb); keys := keys || coalesce(r->'storage_keys','[]'::jsonb);
    exit when r->>'rule' is null;
    calls := calls || jsonb_build_array(jsonb_build_object('rule', r->>'rule', 'target', r->>'target', 'done', r->'done', 'left', r->'left'));
    cur := (r->>'rule') || coalesce(r->>'target','') || ':' || (r->>'left');
    if (r->>'done')::int = 0 then stuck := stuck + 1; else stuck := 0; end if;
    if stuck >= 2 then return jsonb_build_object('stuck', true, 'at', cur, 'calls', calls, 'skipped', skipped); end if;
    if i >= maxcalls then return jsonb_build_object('stuck', true, 'at', 'maxcalls', 'calls', calls, 'skipped', skipped); end if;
  end loop;
  return jsonb_build_object('stuck', false, 'ncalls', i, 'calls', calls, 'skipped', (select coalesce(jsonb_agg(distinct x),'[]') from jsonb_array_elements(skipped) x), 'keys', keys);
end $$;
grant usage on schema c3t to app_admin;
grant execute on function c3t.drain(int,int) to app_admin;

-- orphans(): counts, per foreign key, child rows that point at no parent. Used after replica-mode fixtures and after each run.
create or replace function c3t.orphans() returns table(fk text, orphans bigint) language plpgsql as $$
declare c record; q text; cc text; jc text; n bigint;
begin
  for c in select conname, conrelid::regclass as child, confrelid::regclass as parent, conkey, confkey, conrelid, confrelid from pg_constraint where contype='f' and connamespace='public'::regnamespace loop
    select string_agg(format('c.%I is not null', a.attname), ' and ') into cc from pg_attribute a where a.attrelid=c.conrelid and a.attnum = any(c.conkey);
    select string_agg(format('p.%I = c.%I', pa.attname, ca.attname), ' and ') into jc
      from unnest(c.conkey, c.confkey) as k(ck, pk) join pg_attribute ca on ca.attrelid=c.conrelid and ca.attnum=k.ck join pg_attribute pa on pa.attrelid=c.confrelid and pa.attnum=k.pk;
    q := format('select count(*) from %s c where %s and not exists (select 1 from %s p where %s)', c.child, cc, c.parent, jc);
    execute q into n;
    if n > 0 then fk := c.conname || ' ' || c.child; orphans := n; return next; end if;
  end loop;
end $$;

-- fixseq(): after fixtures with explicit ids, move every identity sequence past its table's max id (a fixture artifact, not a design fault)
create or replace function c3t.fixseq() returns void language plpgsql as $$
declare r record; m bigint;
begin
  for r in select c.relname as t, a.attname as col, pg_get_serial_sequence(format('public.%I', c.relname), a.attname) as sq
           from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attidentity <> '' where c.relnamespace='public'::regnamespace and c.relkind='r' loop
    execute format('select coalesce(max(%I),0) from public.%I', r.col, r.t) into m;
    if m > 0 then perform setval(r.sq, m); end if;
  end loop;
end $$;

create or replace function c3t.chk(g text, nm text, expr text) returns void language plpgsql as $$
declare ok boolean; begin execute 'select coalesce((' || expr || '), false)' into ok; insert into c3t.result(grp,name,ok,detail) values (g,nm,ok,left(expr,300)); exception when others then insert into c3t.result(grp,name,ok,detail) values (g,nm,false,'ERROR '||sqlerrm||' in '||left(expr,200)); end $$;
