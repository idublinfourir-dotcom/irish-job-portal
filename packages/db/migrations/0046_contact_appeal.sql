-- Step 15 gap C3: the contact form takes the topic appeal, so a blocked portal login or a suspended candidate (neither can hold a session) can
-- write to us. The route takes an appeal only from a sender who is not signed in as an active login (packages/db/src/contact.ts); the staff
-- read says whether its email belongs to a held login (contact-inbox.ts, CONTACT_ITEM). The grants are unchanged.
set role portal_owner;

alter table contact_message drop constraint contact_message_topic_check;
alter table contact_message add constraint contact_message_topic_check check (topic in ('general','account','data_request','other','appeal'));

reset role;
