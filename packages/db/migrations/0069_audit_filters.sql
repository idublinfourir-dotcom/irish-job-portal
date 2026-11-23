-- Step 16 B59: the audit log viewer also filters by kind (the personal data views are kind data_access) and by case (related_case). Each filter reads newest first,
-- so an index on (kind, at, id) and one on (related_case, at, id) keep a rare kind or one case from scanning the whole log, as audit_event_action_idx does for an action (0023).
-- The kind index leaves out admin_action, nearly every row: a filter on it is the log itself, which the (at, id) index already serves.
set role portal_owner;

create index audit_event_kind_idx on audit_event(kind, at, id) where kind <> 'admin_action';
create index audit_event_case_idx on audit_event(related_case, at, id) where related_case is not null;

reset role;
