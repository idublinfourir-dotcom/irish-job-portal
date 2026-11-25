"use client";
// Frame E18 and BA31: the profile form (website, county, description, logo) and "close my company". Each calls a documented route from the browser (docs/openapi/portal.yaml)
// and shows the words of _account/messages.ts. Only the account owner gets the buttons; the routes refuse anyone else too.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Icon, Input, Notice, Select, Textarea } from "@portal/ui";
import { send } from "../_account/client";
import { COUNTIES, initials, LOGO_MAX_BYTES, say } from "../_account/messages";

export type Profile = { isOwner?: boolean; name: string; description: string | null; website: string | null; county: string | null; descriptionMax: number; logoSrc: string | null };
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** The logo, and (owner) the button that uploads a new one the moment a file is chosen. */
export function LogoBlock({ name, logoSrc, canEdit, error, pending, saved, onFile }: { name: string; logoSrc: string | null; canEdit: boolean; error?: string; pending?: boolean; saved?: boolean; onFile?: (f: File) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span data-logo className="grid size-[84px] shrink-0 place-items-center overflow-hidden rounded-card bg-white text-[28px] font-semibold text-sponsor-ink">
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- the company's own logo from the portal's public store
          <img src={logoSrc} alt={`Logo of ${name}`} className="size-full object-contain p-2" />
        ) : initials(name)}
      </span>
      <div className="flex flex-col gap-1.5">
        {canEdit && (
          <label className={`inline-flex min-h-[42px] w-fit cursor-pointer items-center gap-2 rounded-pill border border-line bg-hover-light px-5 text-small font-semibold text-deep-green hover:border-line-strong ${pending ? "pointer-events-none opacity-60" : ""}`}>
            <Icon name="upload" size={18} />
            {pending ? "Uploading" : logoSrc ? "Replace logo" : "Upload logo"}
            <input type="file" name="logo" accept={LOGO_TYPES.join(",")} className="sr-only" disabled={pending} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f && onFile) onFile(f); e.currentTarget.value = ""; }} />
          </label>
        )}
        <p className="text-small text-muted">PNG, JPEG or WebP, up to 1 MB.</p>
        {saved && <p role="status" className="text-small font-semibold text-pressed-dark">Logo saved.</p>}
        {error && <p role="alert" className="text-small font-semibold text-error">{error}</p>}
      </div>
    </div>
  );
}

export function ProfileView({ p, canEdit, error, saved, pending, logo, onSubmit, onFile }: {
  p: Profile; canEdit: boolean; error?: string; saved?: boolean; pending?: boolean; logo?: { error?: string; pending?: boolean; saved?: boolean }; onSubmit?: (e: FormEvent<HTMLFormElement>) => void; onFile?: (f: File) => void;
}) {
  const [text, setText] = useState(p.description ?? "");
  const ro = !canEdit;
  return (
    <form id="profile-form" onSubmit={onSubmit} className="flex flex-col gap-6 rounded-bento bg-sand p-6 sm:p-8" aria-busy={pending || undefined}>
      <h2 className="text-[22px]">Basics</h2>
      <LogoBlock name={p.name} logoSrc={p.logoSrc} canEdit={canEdit} onFile={onFile} {...logo} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Input label="Display name" value={p.name} readOnly help="Ask us if it is wrong: we change names by hand." />
        <Input label="Website" name="website" defaultValue={p.website ?? ""} readOnly={ro} icon="globe" maxLength={500} placeholder="https://" inputMode="url" autoComplete="url" help="Start with https://" />
      </div>
      <Select label="County" name="county" defaultValue={p.county ?? ""} disabled={ro}>
        <option value="">Not set</option>
        {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
      <div>
        <Textarea label="Short description" name="description" value={text} onChange={(e) => setText(e.target.value)} readOnly={ro} maxLength={p.descriptionMax} rows={6} placeholder="What the company does, in a few lines." />
        <p className="mt-1.5 text-small text-muted" data-count>{[...text].length} of {p.descriptionMax} characters</p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {saved && <Notice kind="success">Saved. This is what candidates see now.</Notice>}
      {canEdit ? <Button type="submit" size="lg" disabled={pending} className="self-start lg:hidden">{pending ? "Saving" : "Save"}</Button> : !p.isOwner && <p className="text-small text-muted">Only the account owner can change the profile.</p>}
    </form>
  );
}

export function ProfileForm({ p, canEdit }: { p: Profile; canEdit: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string>(), [saved, setSaved] = useState(false), [pending, setPending] = useState(false);
  const [logo, setLogo] = useState<{ error?: string; pending?: boolean; saved?: boolean }>({});
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const website = (f.website ?? "").trim();
    if (website && !/^https:\/\//i.test(website)) return void setError("The website address must start with https://");
    setPending(true); setError(undefined); setSaved(false);
    const a = await send("/api/portal/company", "POST", { description: (f.description ?? "").trim() || null, website: website || null, county: f.county || null });
    setPending(false);
    if (a.status === 200) { setSaved(true); return void router.refresh(); }
    setError(say(a));
  }
  async function onFile(file: File) {
    if (!LOGO_TYPES.includes(file.type)) return void setLogo({ error: say({ status: 415, code: "WRONG_FILE_TYPE" }) });
    if (file.size > LOGO_MAX_BYTES) return void setLogo({ error: say({ status: 413, code: "FILE_TOO_LARGE" }) });
    setLogo({ pending: true });
    const body = new FormData();
    body.set("file", file);
    const a = await send("/api/portal/company/logo", "PUT", body);
    if (a.status === 200) { setLogo({ saved: true }); return void router.refresh(); }
    setLogo({ error: say(a) });
  }
  return <ProfileView p={p} canEdit={canEdit} error={error} saved={saved} pending={pending} logo={logo} onSubmit={onSubmit} onFile={onFile} />;
}

/** BA31, pattern of A10: type the company's exact name, see what closing ends, close. Final. */
export function CloseView({ name, members, invites, open, onOpen, onClose, error, pending, done, onSubmit }: {
  name: string; members: number | null; invites: number | null; open?: boolean; onOpen?: () => void; onClose?: () => void; error?: string; pending?: boolean;
  done?: { jobsClosed: number; membershipsEnded: number; invitesCancelled: number }; onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section aria-labelledby="close-h" className="flex flex-col gap-3 rounded-bento bg-sand p-6 sm:p-8">
      <h2 id="close-h" className="text-[22px] text-error">Close my company</h2>
      <p className="text-muted">Closes all your jobs, ends every membership and cancels open invitations. This cannot be undone.</p>
      <Button variant="danger" onClick={onOpen} className="self-start"><Icon name="trash" size={18} />Close my company</Button>
      <Dialog open={!!open} onClose={onClose ?? (() => {})} title="Close your company?">
        {done ? (
          <div className="flex flex-col gap-4">
            <Notice kind="success" title="Your company is closed">{done.jobsClosed} jobs closed, {done.membershipsEnded} memberships ended, {done.invitesCancelled} invitations cancelled.</Notice>
            <Button href="/" variant="dark">Continue</Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending || undefined}>
            <Notice kind="error" title="This cannot be undone">
              All your jobs close and leave the site.{members !== null && ` ${members} ${members === 1 ? "membership ends" : "memberships end"}.`}{invites !== null && ` ${invites} open ${invites === 1 ? "invitation is" : "invitations are"} cancelled.`} Every member is told.
            </Notice>
            <Input label={`Type ${name} to confirm`} name="confirmName" autoComplete="off" required maxLength={160} />
            {error && <Notice kind="error">{error}</Notice>}
            <div className="flex flex-wrap gap-3">
              <Button variant="chip" onClick={onClose}>Keep my company</Button>
              <Button type="submit" variant="danger" disabled={pending}>{pending ? "Closing" : "Close my company"}</Button>
            </div>
          </form>
        )}
      </Dialog>
    </section>
  );
}

export function CloseCompany({ name, members, invites }: { name: string; members: number | null; invites: number | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  const [done, setDone] = useState<{ jobsClosed: number; membershipsEnded: number; invitesCancelled: number }>();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true); setError(undefined);
    const a = await send("/api/portal/company/close", "POST", { confirmName: String(new FormData(e.currentTarget).get("confirmName") ?? "").trim() });
    setPending(false);
    if (a.status === 200) return void setDone({ jobsClosed: Number(a.body.jobsClosed), membershipsEnded: Number(a.body.membershipsEnded), invitesCancelled: Number(a.body.invitesCancelled) });
    setError(say(a));
  }
  return <CloseView name={name} members={members} invites={invites} open={open} onOpen={() => setOpen(true)} onClose={() => { setOpen(false); if (done) router.replace("/"); }} error={error} pending={pending} done={done} onSubmit={onSubmit} />;
}
