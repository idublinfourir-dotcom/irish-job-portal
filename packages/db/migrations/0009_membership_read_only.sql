-- The portal login can read membership but not write it. 0003 gave app_portal insert and update on every column, so an employer login could add itself
-- to any company (even as account_owner), move a row to another company, take over another company's pending invite, or put its own removed row back
-- to active. Every membership write now goes through a security definer function (claim_organisation and register_organisation today; invite, accept,
-- remove, transfer and signer change come with the employer login slice). app_admin keeps its rights. Select stays for the portal (permissions.test.ts).
set role portal_owner;

revoke insert, update on membership from app_portal;

reset role;
