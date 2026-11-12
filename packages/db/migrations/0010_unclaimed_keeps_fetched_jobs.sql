-- Back to unclaimed closes only the company's own draft and in_review jobs (source employer or agency), not fetched or staff-made ones.
-- 0002 closed every draft and in_review job of the company. A fetched job waits in the admin queue as in_review, so a rejected false claim
-- on a real sponsor (staff approval, step 7 slice 3) or the 30-day claim_needs_info retention rule would have closed that sponsor's fetched
-- jobs as 'removed'. On 12 November 2026 all 155 in_review jobs live were fetched jobs of unclaimed companies. The rest of the function is unchanged.
set role portal_owner;

create or replace function private.organisation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r approval_request; ban_stands boolean;
begin
  if tg_op = 'INSERT' then new.status_changed_at := now(); return new; end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    select exists (select 1 from ban b join strike s on s.id = b.strike_id where s.organisation_id = new.id) into ban_stands;
    if new.status = 'banned' and not ban_stands then raise exception 'organisation: banned only while a ban row stands for this organisation' using errcode = 'P0001'; end if;
    if old.status = 'banned' and ban_stands then raise exception 'organisation: out of banned only once no ban row stands' using errcode = 'P0001'; end if;
    if new.status = 'verified_restricted' and not coalesce(new.restricted_until > now(), false) then
      raise exception 'organisation: verified_restricted only while restricted_until is in the future' using errcode = 'P0001'; end if;
    if old.status = 'verified_restricted' and new.status = 'verified' and coalesce(new.restricted_until > now(), false) then
      raise exception 'organisation: restricted_until has not passed' using errcode = 'P0001'; end if;
    if new.status in ('unclaimed','rejected') then
      update membership set status = 'removed', removed_at = coalesce(removed_at, now()), invited_email = null, invite_token_hash = null
       where organisation_id = new.id and status <> 'removed';
    end if;
    if new.status = 'unclaimed' then
      new.claimed_at := null; new.verified_at := null; new.signup_path := null;
      -- only the company's own posts: fetched and staff-made jobs are not the claimant's (a fetched one waits in the admin queue as in_review)
      update job set status = 'closed', closed_at = now(), close_reason = 'removed'
       where organisation_id = new.id and status in ('draft','in_review') and source in ('employer','agency');
    end if;
  end if;
  if new.restricted_until is distinct from old.restricted_until then
    if new.restricted_until is null then
      if not exists (select 1 from strike s join approval_request a on a.id = s.approval_request_id
                     where s.organisation_id = new.id and s.level = 2 and s.stage = 'overturned' and a.applied_at + interval '90 days' = old.restricted_until) then
        raise exception 'organisation: restricted_until is cleared only when its strike 2 case is overturned' using errcode = 'P0001'; end if;
    else
      if old.restricted_until > now() then raise exception 'organisation: restricted_until never changes once set while it runs' using errcode = 'P0001'; end if;
      select a.* into r from approval_request a join strike s on s.approval_request_id = a.id
       where a.kind = 'strike_2' and a.target_table = 'strike' and a.target_id = s.id::text and s.organisation_id = new.id and s.outcome = 'strike' and s.level = 2
         and a.applied_at = now() limit 1;
      if r.id is null or new.restricted_until <> r.applied_at + interval '90 days' then
        raise exception 'organisation: restricted_until is set only in the transaction that applies a strike_2 request, to applied_at plus 90 days' using errcode = 'P0001'; end if;
      update job set badge = null where organisation_id = new.id and badge = 'sponsor_confirmed'; -- strike 2 removes the badge from all the organisation's jobs
    end if;
  end if;
  if new.claims_removed_at is distinct from old.claims_removed_at then
    if new.claims_removed_at is null then
      if not exists (select 1 from strike s join approval_request a on a.id = s.approval_request_id
                     where s.organisation_id = new.id and s.level = 3 and (s.stage = 'overturned' or s.ban_lifted_at is not null) and a.applied_at = old.claims_removed_at) then
        raise exception 'organisation: claims_removed_at is cleared only when its strike 3 case is overturned or its ban lifted' using errcode = 'P0001'; end if;
    else
      if old.claims_removed_at is not null then raise exception 'organisation: claims_removed_at never changes once set' using errcode = 'P0001'; end if;
      select a.* into r from approval_request a join strike s on s.approval_request_id = a.id
       where a.kind = 'strike_3' and a.target_table = 'strike' and a.target_id = s.id::text and s.organisation_id = new.id and s.outcome = 'strike' and s.level = 3
         and a.applied_at = now() limit 1;
      if r.id is null or new.claims_removed_at <> r.applied_at then
        raise exception 'organisation: claims_removed_at is set only in the transaction that applies a strike_3 request, to applied_at' using errcode = 'P0001'; end if;
    end if;
  end if;
  return new;
end $function$;

reset role;
