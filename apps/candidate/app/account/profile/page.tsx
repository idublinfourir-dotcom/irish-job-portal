// /account/profile (frame NA3, content column only: the account layout comes from P17 part 1): the profile and the CV. Visibility and "who can find you"
// are Launch B and not drawn; nationality and country are not collected (CF7, CF12); one name field (#175); no completeness meter (#287); the notifications
// and data cards of the frame are on /account/settings.
import type { Metadata } from "next";
import { A, Notice } from "@portal/ui";
import { readCv, readMinimums, readOccupations, readProfile, readRegistrationBodies } from "../../../lib/data";
import { profilePath, settingsDeletePath } from "../../../lib/paths";
import { pageDescription, pageTitle } from "../../../lib/seo";
import { need } from "../guard";
import { monthLimits } from "./dates";
import { ProfileForm, type CvInfo, type Mins, type ProfileData } from "./profile-form";

export const generateMetadata = (): Metadata => ({
  title: pageTitle("Your profile"),
  description: pageDescription("Your profile and CV for permit-friendly jobs in Ireland: your occupation, degree, registration and where you are now. You choose what to add, and you can change it any time."),
  robots: { index: false, follow: false },
});

type Occ = { code: string; title: string; listStatus: string };
type Body = { id: string; name: string };

export default async function Page() {
  const p = need(await readProfile(), profilePath());
  if ("refused" in p) return <Notice kind="error" title="This account cannot use the profile">Use the Help page to contact us if you think this is a mistake.</Notice>;
  const [occ, bodies, mins, cv] = await Promise.all([readOccupations(), readRegistrationBodies(), readMinimums(), readCv()]);
  const occupations = occ.ok ? ((occ.data as { occupations: Occ[] }).occupations ?? []) : [];
  const profile = (p.data as { profile: ProfileData | null }).profile;
  const stamp4 = profile?.currentStamp?.startsWith("4") ?? false;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-[2rem] leading-tight sm:text-[2.5rem]">Your profile</h1>
      <p className="text-muted">Add what you want us to know. It helps us show jobs that fit and decide which minimum pay applies to you. Nothing here is shown to an employer.</p>
      {stamp4 && (
        <Notice kind="info" title="Your stamp means you no longer need a permit">
          We paused your job alerts. You can turn them back on in <A href="/account/alerts" className="font-semibold underline">Job alerts</A>, or <A href={settingsDeletePath()} className="font-semibold underline">delete your account</A> if you do not want to keep it.
        </Notice>
      )}
      <ProfileForm
        profile={profile}
        cv={cv.ok ? ((cv.data as { cv: CvInfo }).cv ?? null) : null}
        mins={mins.ok ? (mins.data as Mins) : null}
        bodies={bodies.ok ? ((bodies.data as { bodies: Body[] }).bodies ?? []) : []}
        limits={monthLimits()}
        occupationOptions={occupations.map((o) => <option key={o.code} value={o.code} data-status={o.listStatus}>{o.title} (SOC {o.code})</option>)}
      />
    </div>
  );
}
