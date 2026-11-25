"use client";
// The manual posting form (frame D10) and the upload of the employer's written confirmation. The form finds the employer through GET /api/manual-jobs/companies, runs the checks with
// POST /api/manual-jobs/dry-run and posts with POST /api/manual-jobs (an account reviewer: the routes check the role, the Origin and every field again). Staff never create a company here and
// never post "Sponsor confirmed" at once: that is a second step on a live post, with the employer's own written confirmation and a different administrator (#232, #287).
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Input, Notice, Select, Textarea } from "@portal/ui";
import { Failure } from "../_queue/failure";
import { postJson } from "../_queue/post";
import { CheckRow } from "../_queue/tabs";
import { CHECK_TITLE, checkText, COUNTIES, manualBody, verdict, type DryRun } from "./text";

type Failed = { code: string; status: number } | null;
export type Company = { id: string; displayName: string; kind: string; croNumber: string | null; status: string; county: string | null };
export type Occ = { code: string; title: string };

export function ChecksPanel({ result, failed, back }: { result: DryRun | null; failed: Failed; back: string }) {
  return (
    <section aria-label="Checks" aria-live="polite" className="flex flex-col gap-3 rounded-bento bg-sand p-5">
      <h2 className="text-[22px]">Checks</h2>
      {failed && <Failure code={failed.code} status={failed.status} back={back} />}
      {!result && !failed && <p className="text-small text-muted">Run the checks to see what this post would do. The same rule checks run as in the employer form.</p>}
      {result && (
        <>
          <p className="font-semibold">{verdict(result)}</p>
          <ul className="divide-y divide-line">
            {result.checks.map((c) => <CheckRow key={c.id} ok={c.state === "pass"} title={CHECK_TITLE[c.id] ?? c.id}>{checkText(c)}</CheckRow>)}
          </ul>
          <p className="text-small text-muted">The rules can change before you post, so the answer is checked again when you do.</p>
        </>
      )}
    </section>
  );
}

export function CompanyList({ items, more, onPick }: { items: Company[]; more: boolean; onPick: (c: Company) => void }) {
  if (items.length === 0) return <p className="text-small text-muted">No employer or agency matches. Staff do not create companies here: the employer signs up or is imported first.</p>;
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
      {items.map((c) => (
        <li key={c.id}>
          <button type="button" onClick={() => onPick(c)} className="flex min-h-11 w-full flex-col items-start px-4 py-2 text-left hover:bg-hover-light">
            <span className="font-semibold [overflow-wrap:anywhere]">{c.displayName}</span>
            <span className="text-small text-muted">{c.kind === "agency" ? "Agency" : "Employer"}{c.county ? ` · ${c.county}` : ""}{c.croNumber ? ` · CRO ${c.croNumber}` : ""}</span>
          </button>
        </li>
      ))}
      {more && <li className="px-4 py-2 text-small text-muted">There are more matches. Type more of the name.</li>}
    </ul>
  );
}

export function ManualForm({ occupations, hours, today, last }: { occupations: Occ[]; hours: number; today: string; last: string }) {
  const router = useRouter();
  const back = "/manual-posting";
  const [company, setCompany] = useState<Company | null>(null), [text, setText] = useState("");
  const [found, setFound] = useState<{ items: Company[]; more: boolean } | null>(null), [searchFailed, setSearchFailed] = useState<Failed>(null);
  const [dry, setDry] = useState<DryRun | null>(null), [dryFailed, setDryFailed] = useState<Failed>(null), [local, setLocal] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failed>(null), [pending, setPending] = useState(false), [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const q = text.trim();
    if (company || q.length < 3) return;
    const t = setTimeout(() => {
      void fetch(`/api/manual-jobs/companies?q=${encodeURIComponent(q)}`, { credentials: "same-origin" }).then(async (res) => {
        const j = (await res.json().catch(() => null)) as { items?: Company[]; more?: boolean; error?: string } | null;
        if (res.ok && j?.items) { setSearchFailed(null); setFound({ items: j.items, more: !!j.more }); } else setSearchFailed({ code: j?.error ?? "", status: res.status });
      }).catch(() => setSearchFailed({ code: "", status: 0 }));
    }, 300);
    return () => clearTimeout(t);
  }, [text, company]);

  const bodyOf = (form: HTMLFormElement) => manualBody(new FormData(form), company?.id ?? null);
  async function check(form: HTMLFormElement) {
    const b = bodyOf(form);
    if (!b.ok) return setLocal(b.error);
    setLocal(null); setDryFailed(null); setPending(true);
    const r = await postJson("/api/manual-jobs/dry-run", b.body);
    setPending(false);
    if (!r.ok) { setDry(null); return setDryFailed({ code: r.error, status: r.status }); }
    setDry(r.body as unknown as DryRun);
  }
  async function publish(form: HTMLFormElement) {
    const b = bodyOf(form);
    if (!b.ok) return setLocal(b.error);
    setLocal(null); setFailed(null); setDone(null); setPending(true);
    const r = await postJson("/api/manual-jobs", { action: "create", ...b.body });
    setPending(false);
    if (!r.ok) return setFailed({ code: r.error, status: r.status });
    setDone(r.body.status === "live" ? "Posted. It is live with the Critical Skills eligible badge." : `Saved as a draft, not listed (${String((r.body.reason as { code?: string } | null)?.code ?? "a check failed")}). Run the checks to see which one.`);
    form.reset(); setCompany(null); setText(""); setDry(null);
    router.refresh();
  }
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <form onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void publish(e.currentTarget); }} className="flex flex-col gap-4 rounded-bento bg-sand p-5">
        <div className="flex flex-col gap-2">
          <Input label="Employer" name="employerSearch" icon="search" value={company ? company.displayName : text} onChange={(e) => { setCompany(null); setText(e.target.value); }} autoComplete="off" maxLength={100}
            help="Type at least 3 letters of the name, or the start of the CRO number." note={company ? `Selected: ${company.displayName} (company ${company.id})` : undefined} status={company ? "passed" : undefined} />
          {searchFailed && <Failure code={searchFailed.code} status={searchFailed.status} back={back} />}
          {found && !company && text.trim().length >= 3 && <CompanyList items={found.items} more={found.more} onPick={(c) => { setCompany(c); setFound(null); }} />}
        </div>
        <Input label="Job title" name="title" required minLength={2} maxLength={200} />
        <Select label="Occupation (Critical Skills list)" name="occupationCode" required defaultValue="">
          <option value="" disabled>Choose the occupation</option>
          {occupations.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.title}</option>)}
        </Select>
        <p className="text-small text-muted">Permit type: Critical Skills Employment Permit. Staff post Critical Skills jobs only.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Pay from (euro a year)" name="salaryLow" type="number" inputMode="numeric" min={1} max={1_000_000} step={1} />
          <Input label="Pay to (optional)" name="salaryHigh" type="number" inputMode="numeric" min={1} max={1_000_000} step={1} />
          <Input label="Public pay grade (optional)" name="payGrade" maxLength={100} help="A grade code of the public pay scales, for a public pay employer." />
          <Input label="Health insurance, euro a year (optional)" name="healthInsuranceEur" type="number" inputMode="numeric" min={0} max={50000} step={1} />
          <Input label="Hours a week" name="weeklyHours" type="number" inputMode="numeric" min={1} max={60} step={1} defaultValue={hours} required />
          <Input label="Contract months (empty for permanent)" name="contractMonths" type="number" inputMode="numeric" min={1} max={600} step={1} />
          <Select label="County" name="county" required defaultValue="">
            <option value="" disabled>Choose the county</option>
            {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Input label="Closes on" name="closesOn" type="date" min={today} max={last} required help="At most 90 days ahead." />
        </div>
        <Textarea label="Description" name="description" rows={8} required minLength={20} maxLength={10000} help="Pasted from the employer's advert. 20 to 10,000 characters." />
        <Input label="Application link" name="applyUrl" type="url" icon="external" required minLength={10} maxLength={500} help="The employer's own https address." />
        <Notice kind="info" title="Sponsor confirmed">It cannot be set here. After the post is live, add the employer&apos;s written confirmation on its row below; a different administrator confirms it.</Notice>
        {local && <Notice kind="error">{local}</Notice>}
        {failed && <Failure code={failed.code} status={failed.status} back={back} />}
        {done && <Notice kind="success">{done}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>{pending ? "Working" : "Publish"}</Button>
          <Button type="button" variant="chip" size="md" disabled={pending} onClick={(e) => { const f = e.currentTarget.form; if (f) void check(f); }}>Run the checks</Button>
        </div>
      </form>
      <ChecksPanel result={dry} failed={dryFailed} back={back} />
    </div>
  );
}

/** Upload the employer's written confirmation of one live post: a PDF, JPEG or PNG up to 4 MB. It waits for a different administrator. */
export function SponsorUpload({ jobId, back }: { jobId: string; back: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState<Failed>(null), [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = new FormData(e.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) return setFailed({ code: "empty_file", status: 400 });
    setPending(true); setFailed(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/api/manual-jobs/sponsor-confirmation?jobId=${encodeURIComponent(jobId)}`, { method: "POST", body, credentials: "same-origin" });
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setFailed({ code: j?.error ?? "", status: res.status });
      else router.refresh();
    } catch {
      setFailed({ code: "", status: 0 });
    }
    setPending(false);
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-2">
      <Input label="Employer's written confirmation" name="file" type="file" accept="application/pdf,image/jpeg,image/png" required help="Email or signed letter as a PDF, JPEG or PNG, up to 4 MB." />
      {failed && <Failure code={failed.code} status={failed.status} back={back} />}
      <Button type="submit" variant="chip" size="md" disabled={pending} className="self-start">{pending ? "Uploading" : "Upload"}</Button>
    </form>
  );
}
