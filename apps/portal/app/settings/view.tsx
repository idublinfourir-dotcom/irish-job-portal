// BA30 (pattern of frame A09): the account settings page of a company login. Presentational: the email and the notice switch arrive as props from the login and GET /api/portal/notices/settings.
import { Notice } from "@portal/ui";
import { ChangeEmail, DeleteLogin, ExportData, Reminder, SignOutEverywhere } from "./forms";

export type Banner = "confirm" | "EMAIL_TAKEN" | null;
const card = "flex flex-col gap-1 rounded-bento bg-sand p-6 sm:p-8";

export function SettingsView({ email, reminder, banner }: { email: string; reminder: boolean | null; banner: Banner }) {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1>Settings</h1>
      {banner === "confirm" && <Notice kind="success" title="Link confirmed">If you changed your email, your new address is active once both links have been opened. Sign in again with it then.</Notice>}
      {banner === "EMAIL_TAKEN" && <Notice kind="error" title="The email was not changed">That address already has a login. Use another one.</Notice>}
      <section aria-labelledby="signin-h" className={card}>
        <h2 id="signin-h" className="mb-2 text-[22px]">Sign-in</h2>
        <ChangeEmail email={email} />
        <SignOutEverywhere />
      </section>
      <section aria-labelledby="notices-h" className={card}>
        <h2 id="notices-h" className="mb-2 text-[22px]">Notifications</h2>
        {reminder === null ? <p className="text-muted">We cannot show your notification settings now. Try again in a few minutes.</p> : <Reminder on={reminder} />}
      </section>
      <section aria-labelledby="data-h" className={card}>
        <h2 id="data-h" className="mb-2 text-[22px]">Your data</h2>
        <ExportData />
      </section>
      <DeleteLogin />
    </div>
  );
}
