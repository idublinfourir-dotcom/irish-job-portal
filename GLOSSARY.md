# Irish job portal

A job site for non-EEA people who need an Irish employment permit, with a portal for employers and agencies and an admin panel for staff.

## People

**Visitor**:
Someone using the candidate site without signing in. A visitor has no account and no record of their own.
_Avoid_: Guest, anonymous user

**Candidate**:
A person with an account on the candidate site who needs, or will soon need, an employment permit.
_Avoid_: Applicant (except for someone who has applied on our site), jobseeker, user

**Member**:
A person with a portal login who belongs to one Organisation.
_Avoid_: Employer user, recruiter (a Recruiter is one role), account

**Account owner**:
The one Member who manages an Organisation's team and answers its strike cases.
_Avoid_: Admin, owner (the platform has an owner too)

**Staff**:
A person with an admin panel login. The services team and admin are both Staff, with different roles.
_Avoid_: Admin (a role, not everyone), team member

**Signer**:
A Member allowed to sign a Sponsorship statement or a Pay floor.
_Avoid_: Named person

## Logins

**Pool**:
One of three separate sets of logins: candidate, portal and staff. The same email can exist once in each, and they share nothing.
_Avoid_: Tenant, user type, employer pool

## Companies

**Organisation**:
One company page and one team. It can exist before anyone claims it. An employer, an agency and a public body are all Organisations.
_Avoid_: Company, employer account, brand, tenant

**Organisation name**:
A legal name or a job-site name listed under an Organisation. Admin confirms each link, and nothing merges by itself.
_Avoid_: Legal entity, alias, DETE employer

**Claim**:
When a verified person takes over an existing Organisation and becomes its Account owner.
_Avoid_: Sign-up, register

**Permit employer**:
The company named on a job's employment permit. On agency jobs it is either the agency or its client.
_Avoid_: Client, hiring company, sponsor

**Agency**:
An Organisation holding an Employment Agency licence. A client of an agency is not an account type.
_Avoid_: Recruiter, staffing firm

## Jobs

**Job**:
One advert on the site, whatever its source.
_Avoid_: Listing, posting, vacancy

**Advert text**:
The full wording of a job. It is kept until the job closes, so drafts and jobs in review or hidden keep it.
_Avoid_: Description, body

**Live**:
A job that lists and search may show.
_Avoid_: Active, open, published

**Fetched job**:
A job we collected from another site, never posted to us by the employer.
_Avoid_: Scraped job, imported job

**Route**:
How a candidate applies to a job: on the employer's own page, or on our site from Launch B.
_Avoid_: Apply method

**Sponsorship statement**:
The declaration a Signer makes per job that the employer will sponsor the permit.
_Avoid_: Sponsor confirmation, attestation

**Pay floor**:
A minimum pay figure a big-company Signer declares for a role family.
_Avoid_: Salary guarantee, minimum salary

## Candidate records

**Tracker entry**:
A candidate's own record of a job they applied to, and its stage.
_Avoid_: Application (a different thing), bookmark

**Application**:
An application made on our site, at Launch B only.
_Avoid_: Tracker entry, submission

**Contact request**:
An employer's request to contact a visible candidate, at Launch B only. Contact details are released only if the candidate accepts.
_Avoid_: Message, connection

## Trust and safety

**Report**:
A complaint about a job, an Organisation, or at Launch B a message or profile.
_Avoid_: Flag, complaint, ticket

**Strike**:
A confirmed false claim recorded against an Organisation, at level 1, 2 or 3. The `strike` table also holds open cases and instant-ban cases, and only a decided case with the outcome strike is a Strike.
_Avoid_: Warning, penalty

**Ban**:
A block on a company, recorded by its CRO number and email domain.
_Avoid_: Blacklist, suspension (a temporary hold)

## Services

**Case**:
One permit services request, handled by the services team.
_Avoid_: Ticket, service request

## Launch phases

**Launch A**:
The first release, with no candidate search, contact requests or applications on our site.
_Avoid_: MVP, phase 1

**Launch B**:
The release that adds those features, once the Employment Agency licence is in place.
_Avoid_: Phase 2
