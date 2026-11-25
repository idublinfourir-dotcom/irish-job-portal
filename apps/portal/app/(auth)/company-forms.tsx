"use client";
// The company step of sign-up (frames E03, E04, E05), the answer to "we need one more thing" (E06) and the team invitation (the emailed link). Each calls the documented
// portal routes from the browser (docs/openapi/portal.yaml) and shows the words of messages.ts for every answer. The View parts take their state as props.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { A, Button, Checkbox, Icon, Input, Notice, Textarea } from "@portal/ui";
import { api, fields } from "./api";
import { asMatches, croFound, type Found, type Match } from "./cro";
import { acceptMessage, answerMessage, companyMessage, NOTE_MAX, searchMessage } from "./messages";

type Submit = (e: FormEvent<HTMLFormElement>) => void;
const detail = (m: Match) => [m.county, m.croNumber && `CRO ${m.croNumber}`].filter(Boolean).join(" · ");
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
export const firstTimeHref = (m?: Pick<Match, "croNumber" | "name">) => (m?.croNumber ? `/sign-up/first-time?cro=${encodeURIComponent(m.croNumber)}&name=${encodeURIComponent(m.name)}` : "/sign-up/first-time");

/** Where a login goes once the company exists: a verified company to the dashboard (P18), a company waiting for staff to the verification page. */
const placed = (status: unknown) => (status === "verified" ? "/dashboard" : "/verification");

const rowBase = "flex min-h-14 items-center gap-3 rounded-card border-[1.5px] p-3";

/** The search box, its results and the claim button (frame E03). A result with an organisation id is claimed; a CRO register row with none goes to the first-time form (DD8). */
export function ClaimView({ q, onQ, status, results, picked, onPick, email, error, pending, onSubmit }: {
  q: string; onQ?: (v: string) => void; status: "idle" | "loading" | "error" | "done"; results: Match[]; picked?: string; onPick?: (id: string) => void; email: string; error?: string; pending?: boolean; onSubmit?: Submit;
}) {
  const claimable = results.filter((r) => r.organisationId);
  const register = results.filter((r) => !r.organisationId);
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <div>
        <Input label="Company name or CRO number" name="q" value={q} onChange={(e) => onQ?.(e.target.value)} autoComplete="off" maxLength={160} />
        <p className="sr-only" role="status">{status === "loading" ? "Searching" : status === "done" ? `${results.length} matches` : ""}</p>
      </div>
      {status === "loading" && <p className="text-small text-muted">Searching</p>}
      {status === "error" && error && <Notice kind="error">{error}</Notice>}
      {claimable.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Companies you can claim</legend>
          {claimable.map((r) => (
            <label key={r.organisationId} className={`${rowBase} cursor-pointer ${picked === r.organisationId ? "border-deep-green bg-sand" : "border-transparent bg-sand hover:border-line"}`}>
              <input type="radio" name="organisationId" value={r.organisationId!} checked={picked === r.organisationId} onChange={() => onPick?.(r.organisationId!)} className="size-5 accent-deep-green" />
              <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-pill bg-lilac text-small font-semibold">{initials(r.name)}</span>
              <span className="min-w-0"><span className="block font-semibold">{r.name}</span><span className="block text-small text-muted">{detail(r) || "On the site"}</span></span>
            </label>
          ))}
        </fieldset>
      )}
      {register.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-small text-muted">In the company register, not yet on this site:</p>
          {register.map((r) => (
            <A key={r.croNumber ?? r.name} href={firstTimeHref(r)} className={`${rowBase} border-transparent bg-sand hover:border-line`}>
              <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-pill bg-lilac text-small font-semibold">{initials(r.name)}</span>
              <span className="min-w-0 flex-1"><span className="block font-semibold">{r.name}</span><span className="block text-small text-muted">{detail(r)}</span></span>
              <span className="text-small font-semibold text-deep-green">Register as a first-time sponsor</span>
            </A>
          ))}
        </div>
      )}
      {status === "done" && results.length === 0 && (
        <Notice kind="info" title="We did not find that company">Check the spelling, or try its CRO number. If it has not sponsored a permit since 2019, it is not in the permit records: register it as a first-time sponsor.</Notice>
      )}
      <A href="/sign-up/first-time" className={`${rowBase} justify-between bg-lilac font-medium`}>
        My company is not listed: I am a first-time sponsor <Icon name="arrow" size={18} />
      </A>
      <Input label="Your work email" name="email" value={email} readOnly help="This is the email you signed up with. If it is on the company's own domain, the account can go live as soon as you claim. Otherwise our team checks it first." />
      {error && status !== "error" && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="dark" size="lg" disabled={pending || !picked} className="w-full">{pending ? "Claiming" : "Claim this company"}</Button>
    </form>
  );
}

export function ClaimForm({ email, initialQ }: { email: string; initialQ: string }) {
  const router = useRouter(), [q, setQ] = useState(initialQ), [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [results, setResults] = useState<Match[]>([]), [picked, setPicked] = useState<string>(), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  const run = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) return;
    const id = ++run.current, ctl = new AbortController();
    const t = setTimeout(async () => {
      setStatus("loading"); setError(undefined);
      try {
        const a = await api(`/api/portal/claim/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal });
        if (id !== run.current) return;
        if (a.status === 200) { setResults(asMatches(a.body)); setStatus("done"); setPicked(undefined); } else { setResults([]); setError(searchMessage(a)); setStatus("error"); }
      } catch { /* aborted by the next keystroke */ }
    }, 350);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!picked) return;
    setPending(true); setError(undefined);
    const a = await api("/api/portal/claim", { method: "POST", body: { organisationId: picked } });
    if (a.status === 200) return void (router.replace(placed(a.body.status)), router.refresh());
    if (a.code === "ALREADY_IN_A_COMPANY") return void (router.replace("/"), router.refresh());
    setError(companyMessage(a)); setPending(false);
  }
  const searching = q.trim().length >= 3; // a shorter box shows no results and no message
  return <ClaimView q={q} onQ={setQ} status={searching ? status : "idle"} results={searching ? results : []} picked={picked} onPick={setPicked} email={email} error={error} pending={pending} onSubmit={onSubmit} />;
}

/** The first-time sponsor form (frame E04): CRO number with a look-up, company name, the sign-in email and what the label means. */
export function FirstTimeView({ cro, onCro, found, name, onName, email, free, error, pending, onSubmit, onBlurCro }: {
  cro: string; onCro?: (v: string) => void; onBlurCro?: () => void; found?: Found;
  name: string; onName?: (v: string) => void; email: string; free?: boolean; error?: string; pending?: boolean; onSubmit?: Submit;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <Input label="Company registration number (CRO)" name="croNumber" value={cro} onChange={(e) => onCro?.(e.target.value)} onBlur={onBlurCro} inputMode="numeric" autoComplete="off" required maxLength={20}
        status={found?.kind === "found" ? "passed" : undefined}
        note={found?.kind === "found" ? `Found: ${found.name}${found.county ? ` · ${found.county}` : ""}` : found?.kind === "none" ? "We did not find this number in the CRO data. You can still send it: our team checks it by hand." : undefined}
        error={found?.kind === "error" ? found.text : undefined} />
      {found?.kind === "onsite" && (
        <Notice kind="info" title="This number is already on the site">Search for the company and claim it. <A href={`/sign-up/claim?q=${encodeURIComponent(cro.trim())}`} className="font-semibold underline underline-offset-2">Go to the claim step</A></Notice>
      )}
      <Input label="Company name" name="displayName" value={name} onChange={(e) => onName?.(e.target.value)} autoComplete="organization" required minLength={2} maxLength={160} />
      <Input label="Your work email" name="email" value={email} readOnly note={free ? "This is a free email provider. Accounts on free or lookalike domains always go to review, and it can take longer." : undefined} />
      <Notice kind="warning" title={'Your jobs will carry the "First-time sponsor" label'}>It tells candidates you are confirmed but have no DETE permit history since 2019. It can drop off once your first permit is in the records and our team has linked it to your company.</Notice>
      {error && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Sending" : "Send for review"}</Button>
      <p className="text-small text-muted">Banned CRO numbers and email domains cannot sign up again.</p>
    </form>
  );
}

export function FirstTimeForm({ email, free, initialCro, initialName, initialFound }: { email: string; free: boolean; initialCro: string; initialName: string; initialFound?: Found }) {
  const router = useRouter(), [cro, setCro] = useState(initialCro), [name, setName] = useState(initialName);
  const [found, setFound] = useState<Found | undefined>(initialFound), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function look() {
    const digits = cro.replace(/\s+/g, "").replace(/^ie/i, "");
    if (!/^\d{3,8}$/.test(digits)) return;
    const a = await api(`/api/portal/claim/search?q=${encodeURIComponent(digits)}`);
    if (a.status !== 200) return void setFound({ kind: "error", text: searchMessage(a) });
    const f = croFound(a.body, digits);
    setFound(f);
    if (f?.kind === "found") setName((n) => n || f.name);
  }
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true); setError(undefined);
    const a = await api("/api/portal/register", { method: "POST", body: { kind: "employer", displayName: name.trim(), croNumber: cro.trim() } });
    if (a.status === 200) return void (router.replace("/verification"), router.refresh());
    if (a.code === "ALREADY_IN_A_COMPANY") return void (router.replace("/"), router.refresh());
    if (a.code === "NUMBER_ALREADY_REGISTERED") return void router.replace(`/sign-up/claim?q=${encodeURIComponent(cro.trim())}`);
    setError(companyMessage(a)); setPending(false);
  }
  return <FirstTimeView cro={cro} onCro={(v) => { setCro(v); setFound(undefined); }} onBlurCro={look} found={found} name={name} onName={setName} email={email} free={free} error={error} pending={pending} onSubmit={onSubmit} />;
}

/** The agency form (frame E05). The licence is checked by staff against the WRC register: nothing of that register is shown here (D212, CF123). */
export function AgencyView({ error, pending, onSubmit }: { error?: string; pending?: boolean; onSubmit?: Submit }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <Input label="Employment Agency licence number" name="wrcLicenceNumber" required maxLength={30} autoComplete="off" help="We will check it." />
      <Input label="Agency name" name="displayName" autoComplete="organization" required minLength={2} maxLength={160} />
      <Input label="Company registration number (CRO), if you have one" name="croNumber" inputMode="numeric" autoComplete="off" maxLength={20} />
      <Notice kind="info" title="On each job you will tell us who the permit employer is">The agency itself, or the client. We check that employer against the DETE records.</Notice>
      <Checkbox name="noFee" required label="I confirm we never charge candidates a fee." />
      {error && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Sending" : "Send for review"}</Button>
      <p className="text-small text-muted">A licence that lapses stops new postings. Jobs already live go to staff review.</p>
    </form>
  );
}
export function AgencyForm() {
  const router = useRouter(), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = fields(e);
    setPending(true); setError(undefined);
    const a = await api("/api/portal/register", { method: "POST", body: { kind: "agency", displayName: f.displayName!.trim(), wrcLicenceNumber: f.wrcLicenceNumber!.trim(), ...(f.croNumber!.trim() ? { croNumber: f.croNumber!.trim() } : {}) } });
    if (a.status === 200) return void (router.replace("/verification"), router.refresh());
    if (a.code === "ALREADY_IN_A_COMPANY") return void (router.replace("/"), router.refresh());
    setError(a.code === "NUMBER_ALREADY_REGISTERED" ? "This licence or company number is already on the site. Contact support if it is yours." : companyMessage(a)); setPending(false);
  }
  return <AgencyView error={error} pending={pending} onSubmit={onSubmit} />;
}

/** "We need one more thing": the owner answers with one plain note (decision #197, #219: no letter upload). */
export function AnswerView({ error, pending, onSubmit }: { error?: string; pending?: boolean; onSubmit?: Submit }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-busy={pending || undefined}>
      <Textarea label="Your answer" name="note" required maxLength={NOTE_MAX} help={`One line, up to ${NOTE_MAX} characters.`} error={error} />
      <Button type="submit" variant="dark" disabled={pending} className="self-start">{pending ? "Sending" : "Send answer"}</Button>
    </form>
  );
}
export function AnswerForm() {
  const router = useRouter(), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = fields(e).note!.trim().replace(/\s*[\r\n]+\s*/g, " "); // the route takes one line
    setPending(true); setError(undefined);
    const a = await api("/api/portal/review-answer", { method: "POST", body: { note } });
    if (a.status === 200 || a.code === "NOT_WAITING_FOR_ANSWER") return void router.refresh();
    setError(answerMessage(a)); setPending(false);
  }
  return <AnswerView error={error} pending={pending} onSubmit={onSubmit} />;
}

/** The team invitation (the emailed link `/team/accept?token=`): one button, the token comes from the server component. */
export function AcceptView({ error, pending, onAccept }: { error?: string; pending?: boolean; onAccept?: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      {error && <Notice kind="error">{error}</Notice>}
      <Button variant="dark" size="lg" disabled={pending} onClick={onAccept} className="w-full">{pending ? "Joining" : "Accept the invitation"}</Button>
    </div>
  );
}
export function AcceptForm({ token }: { token: string }) {
  const router = useRouter(), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function accept() {
    setPending(true); setError(undefined);
    const a = await api("/api/portal/team", { method: "POST", body: { action: "accept", token } });
    if (a.status === 200) return void (router.replace("/"), router.refresh()); // "/" sends the login to its company's page
    setError(acceptMessage(a)); setPending(false);
  }
  return <AcceptView error={error} pending={pending} onAccept={accept} />;
}
