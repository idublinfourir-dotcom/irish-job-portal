-- Slice 8.4 (#197, #203): the employer's answer to "ask for more", and the 24 hour cool-down after a rejected claim.
-- answer_review: the account owner of a needs_info company sends a short plain-text note. It is stored in the company's open account_review item (detail.answer,
-- never in the audit log, #182), the company goes back to pending_review, and one audit row of codes is written.
-- claim_organisation is its 0015 text (the newest; before it 0002) with one added check, the cool-down, after the ban checks.
set role portal_owner;

create or replace function private.claim_organisation(p_portal_user_id text, p_organisation_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; v_domain text; v_status text; v_mem bigint;
begin
  select * into u from portal_user where id = p_portal_user_id;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'claim refused: unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  if not u.email_verified then raise exception 'claim refused: email not verified' using errcode = 'P0001'; end if;
  v_domain := lower(split_part(u.email, '@', 2));
  if exists (select 1 from ban where email_domain = v_domain) then raise exception 'claim refused: email domain is banned' using errcode = 'P0001'; end if;
  if exists (select 1 from ban where email_address = lower(u.email)) then raise exception 'claim refused: email address is banned' using errcode = 'P0001'; end if;
  if exists (select 1 from ban b where b.cro_number in (select o.cro_number from organisation o where o.id = p_organisation_id
             union select n.cro_number from organisation_name n where n.organisation_id = p_organisation_id)) then
    raise exception 'claim refused: company number is banned' using errcode = 'P0001'; end if;
  -- 0016 (#203): the same login cannot claim the same company again within 24 hours of a rejection. The record is the login's removed owner membership
  -- (the organisation guard removes it when a reviewer rejects a claim) matched to that company's rejected account_review item by the instant they share:
  -- both are set with now() in the rejecting transaction. A claim that lapsed unanswered (outcome needs_info_expired) is not a rejection.
  if exists (select 1 from membership m join review_item r on r.organisation_id = m.organisation_id and r.queue = 'account_review' and r.outcome = 'rejected' and r.decided_at = m.removed_at
              where m.organisation_id = p_organisation_id and m.portal_user_id = p_portal_user_id and m.status = 'removed' and m.removed_at > now() - interval '24 hours') then
    raise exception 'claim refused: COOL_DOWN this login''s claim of this company was rejected within 24 hours' using errcode = 'P0001'; end if;
  v_status := case when exists (select 1 from organisation_domain d where d.organisation_id = p_organisation_id and d.domain = v_domain)
                    and not exists (select 1 from organisation_domain d where d.domain = v_domain and d.organisation_id <> p_organisation_id)
               then 'verified' else 'pending_review' end;
  update organisation set status = v_status, claimed_at = now(), signup_path = 'dete_claim', verified_at = case when v_status = 'verified' then now() end
   where id = p_organisation_id and status = 'unclaimed';
  if not found then raise exception 'claim refused: organisation is not unclaimed' using errcode = 'P0001'; end if;
  insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values (p_organisation_id, p_portal_user_id, 'account_owner', 'active', true, now()) returning id into v_mem;
  if v_status = 'pending_review' then insert into review_item(queue, organisation_id, reason) values ('account_review', p_organisation_id, 'claim') on conflict do nothing; end if;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, after, source)
    values ('security', p_portal_user_id, 'organisation.claim', 'organisation', p_organisation_id::text, jsonb_build_object('status', v_status), 'site');
  return jsonb_build_object('organisation_id', p_organisation_id, 'status', v_status, 'membership_id', v_mem);
end $$;

-- $2 is the note as typed. Refusals: REFUSED (unknown, blocked or deleted login; not the active account owner of a company), NOT_WAITING (the company is not
-- needs_info, or has no open item), BAD_REQUEST (empty, over 1,000 characters, or a control or format character such as a line break or a right-to-left override).
create function private.answer_review(p_portal_user_id text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; m membership; o organisation; v_note text := btrim(p_note); v_item bigint;
begin
  select * into u from portal_user where id = p_portal_user_id;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'answer refused: REFUSED unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  select * into m from membership where portal_user_id = p_portal_user_id and status = 'active';
  if m.id is null or m.role <> 'account_owner' then raise exception 'answer refused: REFUSED not the account owner of a company' using errcode = 'P0001'; end if;
  if v_note is null or char_length(v_note) not between 1 and 1000 or v_note ~ '[\u0001-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]' then
    raise exception 'answer refused: BAD_REQUEST note' using errcode = 'P0001'; end if;
  -- the item first, then the company: the same order a reviewer's decision locks them in, so the two cannot deadlock
  select id into v_item from review_item where queue = 'account_review' and organisation_id = m.organisation_id and status in ('open','claimed') for update;
  select * into o from organisation where id = m.organisation_id for update;
  if o.status <> 'needs_info' or v_item is null then raise exception 'answer refused: NOT_WAITING the company is not waiting for an answer' using errcode = 'P0001'; end if;
  update review_item set detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object('answer', v_note, 'answered_at', now()) where id = v_item;
  update organisation set status = 'pending_review' where id = o.id;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, before, after, source)
    values ('security', p_portal_user_id, 'organisation.answer_review', 'organisation', o.id::text, jsonb_build_object('status', 'needs_info'), jsonb_build_object('status', 'pending_review'), 'site');
  return jsonb_build_object('organisation_id', o.id, 'status', 'pending_review');
end $$;

grant execute on function private.answer_review(text, text) to app_portal;

reset role;
