// "My data" (staff own data export, R1): who is signed in and the one download. Parts that take their data as props.
import { Pill } from "@portal/ui";
import { roleLabel } from "../_tools/text";
import { Download } from "./download";

export function Me({ name, roles }: { name: string; roles: string[] }) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">My data</h1>
        <p className="text-muted">What is kept about your staff login, as one file.</p>
      </header>
      <section aria-label="Signed in as" className="flex flex-col gap-3 rounded-bento bg-sand p-5">
        <p className="text-[22px] font-semibold [overflow-wrap:anywhere]">{name}</p>
        <p className="flex flex-wrap gap-2">
          {roles.length === 0 ? <span className="text-muted">No role yet.</span> : roles.map((r) => <Pill key={r} tone="white">{roleLabel(r)}</Pill>)}
        </p>
      </section>
      <section aria-label="Download" className="flex flex-col gap-3 rounded-bento bg-sand p-5">
        <h2 className="text-[22px]">Download my data</h2>
        <p>The file holds your account, your roles, the actions you took (kind, object and time), and the review items, approvals, reports, strikes, messages, cases and case notes you handled, as ids and codes only. It never holds case evidence, note or message text, or another staff member&apos;s id. Downloading it adds one row to the audit log.</p>
        <Download />
        <p className="text-small text-muted">You need to have signed in within the last 10 minutes. Staff do not delete their own login: an administrator disables it.</p>
      </section>
    </div>
  );
}
