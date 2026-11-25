"use client";
// The rules data forms (frames ND3, D05, D06): each proposes a whole new version of one kind to POST /api/rules (docs/openapi/admin.yaml). Nothing changes until a different
// administrator confirms it; the route checks the role (rules data editor), the Origin, a sign-in from the last 10 minutes and every value again. The forms take no value from the
// page but what the page read: the version in force is the starting point and only what the editor changes is changed. The views take their state as props so a test renders them.
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { BigName, Minimums, Occupation, PayDealEntry, PayDealList, PayScale } from "@portal/db";
import { A, Button, Checkbox, Dialog, Input, Notice, Select, Textarea } from "@portal/ui";
import { Failure } from "../_queue/failure";
import { postJson } from "../_queue/post";
import { bigEntry, employerKey, minimumsData, occupationEntry, payDealEntry, scaleEntry, withEntry, without, type Built } from "./build";
import { BODY_LABEL, dayText, EVIDENCE_LABEL, KIND_LABEL, MIN_FIELD, TEST_LABEL } from "./text";

export type Failed = { code: string; status: number; detail?: string } | null;
const SENT = "Proposed. A different administrator confirms it before anything changes.";

/** The state of one proposal: sending, the route's refusal, and whether it went. */
export function useProposal() {
  const router = useRouter();
  const [pending, setPending] = useState(false), [failed, setFailed] = useState<Failed>(null), [sent, setSent] = useState(false);
  async function send(body: object, after?: () => void): Promise<boolean> {
    setPending(true); setFailed(null); setSent(false);
    const r = await postJson("/api/rules", body);
    setPending(false);
    if (!r.ok) { setFailed({ code: r.error, status: r.status, detail: r.detail }); return false; }
    setSent(true); after?.(); router.refresh();
    return true;
  }
  return { pending, failed, sent, send, reset: () => { setFailed(null); setSent(false); } };
}

export function Outcome({ failed, sent, local, back }: { failed: Failed; sent: boolean; local?: string | null; back: string }) {
  return (
    <>
      {local && <Notice kind="error">{local}</Notice>}
      {failed && <Failure code={failed.code} status={failed.status} back={back} detail={failed.detail} />}
      {sent && <Notice kind="success">{SENT}</Notice>}
    </>
  );
}

export const DayField = ({ today }: { today: string }) => <Input label="Starts on" name="effectiveFrom" type="date" min={today} defaultValue={today} required help="Today or a later day." />;

/** A button that opens a dialog with a form; the form's own fields come as children and `build` makes the version from them. */
export function ProposeDialog({ label, title, today, back, variant = "primary", children, build, kind }: {
  label: string; title: string; today: string; back: string; variant?: "primary" | "chip" | "dark"; children: ReactNode; kind: string; build: (f: FormData) => Built<unknown>;
}) {
  const p = useProposal();
  const [open, setOpen] = useState(false), [local, setLocal] = useState<string | null>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), b = build(f);
    if (!b.ok) return setLocal(b.error);
    setLocal(null);
    await p.send({ action: "propose", kind, effectiveFrom: String(f.get("effectiveFrom")), data: b.value });
  }
  return (
    <>
      <Button type="button" variant={variant} size="md" onClick={() => { p.reset(); setLocal(null); setOpen(true); }}>{label}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title}>
        {p.sent ? (
          <div className="flex flex-col gap-4"><Outcome failed={null} sent back={back} /><Button type="button" variant="outline" onClick={() => setOpen(false)}>Close</Button></div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
            {children}
            <DayField today={today} />
            <Outcome failed={p.failed} sent={false} local={local} back={back} />
            <div className="flex gap-2">
              <Button type="submit" disabled={p.pending}>{p.pending ? "Sending" : "Propose this change"}</Button>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

// ===== salary minimums and quotas: the whole minimums version =====
const NUM: [keyof Minimums & string, number, number][] = [["criticalSkills", 1, 1_000_000], ["graduate", 1, 1_000_000], ["nonList", 1, 1_000_000], ["graduateMonths", 1, 120], ["minContractMonths", 1, 120], ["standardWeekHours", 1, 60]];
export function MinimumsFields({ m }: { m: Minimums }) {
  const lowerCodes = (m.generalLowerCodes ?? []).join(", "), fullCodes = (m.generalQuotaFullCodes ?? []).join(", ");
  return (
    <>
      <p className="text-small text-muted">The whole set of figures, as it is today. Change only what the source changed.</p>
      {NUM.map(([k, lo, hi]) => <Input key={k} label={MIN_FIELD[k]!} name={k} type="number" inputMode="numeric" min={lo} max={hi} step={1} defaultValue={m[k] as number} required />)}
      <Checkbox name="nonListRoute" label={MIN_FIELD.nonListRoute!} defaultChecked={m.nonListRoute} />
      <Input label={MIN_FIELD.checkedOn!} name="checkedOn" type="date" defaultValue={m.checkedOn} required />
      <Input label={`${MIN_FIELD.general} (leave all four General boxes empty for none)`} name="general" type="number" inputMode="numeric" min={1} step={1} defaultValue={m.general ?? ""} />
      <Input label={MIN_FIELD.generalLower!} name="generalLower" type="number" inputMode="numeric" min={1} step={1} defaultValue={m.generalLower ?? ""} />
      <Textarea label={MIN_FIELD.generalLowerCodes!} name="generalLowerCodes" rows={2} defaultValue={lowerCodes} help="Four-digit codes, separated by commas." />
      <Textarea label={MIN_FIELD.generalQuotaFullCodes!} name="generalQuotaFullCodes" rows={2} defaultValue={fullCodes} help="Four-digit codes whose quota is full: no new General jobs for them. May be empty." />
    </>
  );
}
export function MinimumsEditor({ m, today, label = "Add a future value" }: { m: Minimums; today: string; label?: string }) {
  return (
    <ProposeDialog label={label} title="New salary minimums" kind="minimums" today={today} back="/rules" build={minimumsData}>
      <MinimumsFields m={m} />
    </ProposeDialog>
  );
}

// ===== the lists: Critical Skills, Ineligible, pay scales, big companies =====
export type ListKind = "critical_skills_list" | "ineligible_list" | "pay_scales" | "big_company_names";
type Row = Occupation | PayScale | BigName;
const COLUMNS: Record<ListKind, string[]> = {
  critical_skills_list: ["Code", "Title"], ineligible_list: ["Code", "Title"], pay_scales: ["Grade", "Title", "First point", "Last point", "Source"],
  big_company_names: ["Brand", "Test", "Link", "Read on", "Next review"],
};
const eur = (n: number) => `€${n.toLocaleString("en-IE")}`;
export function cells(kind: ListKind, r: Row): ReactNode[] {
  if (kind === "pay_scales") { const p = r as PayScale; return [p.code, p.title, eur(p.firstEur), eur(p.lastEur), <A key="s" href={p.sourceUrl} rel="noopener noreferrer" className="underline">Page {p.sourcePage}</A>]; }
  if (kind === "big_company_names") { const b = r as BigName; return [b.name, TEST_LABEL[b.test] ?? b.test, b.link ? <A key="l" href={b.link} rel="noopener noreferrer" className="underline">Link</A> : "Not recorded", b.readOn ? dayText(b.readOn) : "Not recorded", b.reviewOn ? dayText(b.reviewOn) : "Not set"]; }
  const o = r as Occupation; return [o.code, o.title];
}

function EntryFields({ kind, row }: { kind: ListKind; row: Row | null }) {
  if (kind === "pay_scales") {
    const p = row as PayScale | null;
    return (
      <>
        <Input label="Grade code" name="code" required maxLength={12} defaultValue={p?.code} help="1 to 12 capital letters or digits." />
        <Input label="Title" name="title" required maxLength={200} defaultValue={p?.title} />
        <Input label="First point (euro a year)" name="firstEur" type="number" inputMode="numeric" min={1} step={1} required defaultValue={p?.firstEur} />
        <Input label="Last point (euro a year)" name="lastEur" type="number" inputMode="numeric" min={1} step={1} required defaultValue={p?.lastEur} />
        <Input label="Source address" name="sourceUrl" type="url" required maxLength={500} defaultValue={p?.sourceUrl} help="An https address." />
        <Input label="Source page" name="sourcePage" type="number" inputMode="numeric" min={1} step={1} required defaultValue={p?.sourcePage} />
        <Input label="Note (optional)" name="note" maxLength={500} defaultValue={p?.note} />
      </>
    );
  }
  if (kind === "big_company_names") {
    const b = row as BigName | null;
    return (
      <>
        <Input label="Brand name" name="name" required maxLength={100} defaultValue={b?.name} help="Lower-case letters and digits, as the company name is cleaned. Only when the brand's own legal entity is the employer." />
        <Select label="Why it is on the list" name="test" defaultValue={b?.test ?? "brand"}>{Object.entries(TEST_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>
        <Input label="Where the pay was read" name="link" type="url" required maxLength={500} defaultValue={b?.link ?? ""} help="An https address." />
        <Input label="Read on" name="readOn" type="date" required defaultValue={b?.readOn ?? ""} />
        <Input label="Next review" name="reviewOn" type="date" required defaultValue={b?.reviewOn ?? ""} />
      </>
    );
  }
  const o = row as Occupation | null;
  return (
    <>
      <Input label="Occupation code" name="code" required maxLength={4} pattern="[0-9]{4}" inputMode="numeric" defaultValue={o?.code} help="Four digits (SOC 2010)." />
      <Input label="Title" name="title" required maxLength={2000} defaultValue={o?.title} />
    </>
  );
}

function buildEntry(kind: ListKind, f: FormData, rows: Row[], at: number | null): Built<Row> {
  if (kind === "pay_scales") return scaleEntry(f);
  if (kind === "big_company_names") return bigEntry(f);
  return occupationEntry(f, kind === "critical_skills_list" ? "critical-skills" : "ineligible", at === null ? null : (rows[at] as Occupation), (rows as Occupation[]).map((r) => r.id));
}
const WORD: Record<ListKind, string> = { critical_skills_list: "occupation", ineligible_list: "occupation", pay_scales: "grade", big_company_names: "brand" };

export type ListEditorProps = { kind: ListKind; rows: Row[]; today: string; canEdit: boolean; back: string };
/** A list with its Add, Edit and Remove: each one proposes the whole list with that one change, as the list was read. */
export function ListEditor({ kind, rows, today, canEdit, back }: ListEditorProps) {
  const p = useProposal();
  const [at, setAt] = useState<number | null | "none">("none"), [removing, setRemoving] = useState<number | null>(null), [local, setLocal] = useState<string | null>(null);
  const [day, setDay] = useState(today);
  const open = (i: number | null) => { p.reset(); setLocal(null); setAt(i); };
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), b = buildEntry(kind, f, rows, at === "none" ? null : at);
    if (!b.ok) return setLocal(b.error);
    setLocal(null);
    await p.send({ action: "propose", kind, effectiveFrom: String(f.get("effectiveFrom")), data: withEntry(rows, at === "none" ? null : at, b.value) });
  }
  async function remove() {
    if (removing === null) return;
    await p.send({ action: "propose", kind, effectiveFrom: day, data: without(rows, removing) });
  }
  const head = COLUMNS[kind];
  return (
    <div className="flex flex-col gap-3">
      {canEdit && <div><Button type="button" size="md" onClick={() => open(null)}>{`Add ${WORD[kind]}`}</Button></div>}
      {p.sent && at === "none" && removing === null && <Notice kind="success">{SENT}</Notice>}
      <div className="overflow-x-auto rounded-card border border-line bg-white">
        <table className="w-full min-w-[34rem] text-left text-small">
          <caption className="sr-only">{KIND_LABEL[kind]} in force today</caption>
          <thead><tr className="border-b border-line bg-lilac-soft">{head.map((h) => <th key={h} scope="col" className="px-3 py-3 font-semibold">{h}</th>)}{canEdit && <th scope="col" className="px-3 py-3"><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line align-top last:border-b-0 odd:bg-sand/60">
                {cells(kind, r).map((c, j) => <td key={j} className="px-3 py-2.5 [overflow-wrap:anywhere]">{c}</td>)}
                {canEdit && (
                  <td className="whitespace-nowrap px-3 py-2">
                    <Button type="button" variant="chip" onClick={() => open(i)}>Edit<span className="sr-only"> {String(cells(kind, r)[0])}</span></Button>{" "}
                    <Button type="button" variant="chip" onClick={() => { p.reset(); setRemoving(i); }}>Remove<span className="sr-only"> {String(cells(kind, r)[0])}</span></Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-small text-muted">Nothing is in force for this list yet.</p>}
      {canEdit && (
        <>
      <Dialog open={at !== "none"} onClose={() => setAt("none")} title={at === "none" || at === null ? `Add ${WORD[kind]}` : `Change ${WORD[kind]}`}>
        {p.sent ? (
          <div className="flex flex-col gap-4"><Outcome failed={null} sent back={back} /><Button type="button" variant="outline" onClick={() => setAt("none")}>Close</Button></div>
        ) : (
          <form onSubmit={(e) => void save(e)} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
            <EntryFields kind={kind} row={at === "none" || at === null ? null : rows[at]!} />
            <DayField today={today} />
            <Outcome failed={p.failed} sent={false} local={local} back={back} />
            <div className="flex gap-2"><Button type="submit" disabled={p.pending}>{p.pending ? "Sending" : "Propose this change"}</Button><Button type="button" variant="outline" onClick={() => setAt("none")}>Cancel</Button></div>
          </form>
        )}
      </Dialog>
      <Dialog open={removing !== null} onClose={() => setRemoving(null)} title={`Remove this ${WORD[kind]}?`}>
        {p.sent ? (
          <div className="flex flex-col gap-4"><Outcome failed={null} sent back={back} /><Button type="button" variant="outline" onClick={() => setRemoving(null)}>Close</Button></div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="[overflow-wrap:anywhere]">{removing === null ? "" : String(cells(kind, rows[removing]!)[0])} is taken off the list from the day below, once a different administrator confirms.</p>
            <Input label="Starts on" name="effectiveFrom" type="date" min={today} value={day} onChange={(e) => setDay(e.target.value)} required />
            <Outcome failed={p.failed} sent={false} back={back} />
            <div className="flex gap-2"><Button type="button" variant="danger" disabled={p.pending} onClick={() => void remove()}>Propose removing it</Button><Button type="button" variant="outline" onClick={() => setRemoving(null)}>Cancel</Button></div>
          </div>
        )}
      </Dialog>
        </>
      )}
    </div>
  );
}

// ===== the big-company flag on one company (DD21) =====
export function FlagForm({ back }: { back: string }) {
  const p = useProposal();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await p.send({ action: "propose_flag", organisationId: String(new FormData(e.currentTarget).get("organisationId") ?? "").trim() });
  }
  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3 rounded-bento bg-sand p-5">
      <h2 className="text-[22px]">Flag one company as big</h2>
      <p className="text-small text-muted">A company is flagged only when one of its names matches a brand on the list above. A different administrator confirms the flag.</p>
      <Input label="Company number" name="organisationId" required inputMode="numeric" pattern="[0-9]{1,18}" maxLength={18} autoComplete="off" />
      <Outcome failed={p.failed} sent={p.sent} back={back} />
      <Button type="submit" size="md" disabled={p.pending} className="self-start">{p.pending ? "Sending" : "Propose the flag"}</Button>
    </form>
  );
}

// ===== pay-deal employers (frame D05) =====
async function uploadEvidence(file: File): Promise<{ ok: true; file: { id: string; name: string } } | { ok: false; code: string; status: number }> {
  try {
    const body = new FormData();
    body.set("file", file);
    const res = await fetch("/api/rules/evidence", { method: "POST", body, credentials: "same-origin" });
    const j = (await res.json().catch(() => null)) as { file?: { id: string; name: string }; error?: string } | null;
    return res.ok && j?.file ? { ok: true, file: j.file } : { ok: false, code: j?.error ?? "", status: res.status };
  } catch {
    return { ok: false, code: "", status: 0 };
  }
}

export function PayDealFields({ name, e }: { name: string | null; e: PayDealEntry | null }) {
  return (
    <>
      {name === null && <Input label="Employer name" name="name" required maxLength={200} autoComplete="off" help="As the company is named on the site. It is matched exactly, in lower case." />}
      <Select label="Body type" name="bodyType" defaultValue={e?.bodyType ?? "public_body"}>{Object.entries(BODY_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>
      <Select label="Evidence that pay follows a public sector pay deal" name="evidenceKind" defaultValue={e?.evidence?.kind ?? "service_arrangement"}>{Object.entries(EVIDENCE_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>
      <Input label="Evidence link" name="link" type="url" maxLength={500} defaultValue={e?.evidence?.link ?? ""} help="An https address. A link, a file or both." />
      <Input label={e?.evidence?.file ? `Replace the file (now ${e.evidence.file.name})` : "Evidence file"} name="evidenceFile" type="file" accept="application/pdf,image/jpeg,image/png" help="PDF, JPEG or PNG, up to 4 MB." />
      <Textarea label="Note" name="note" rows={3} maxLength={500} defaultValue={e?.note ?? ""} />
      <Checkbox name="on" label="On: a job at this employer passes the salary check" defaultChecked={e ? e.on !== false : true} />
    </>
  );
}

/** Add an employer, or save the selected one: the whole list goes up with that one entry changed. */
export function PayDealForm({ data, selected, today, back }: { data: PayDealList; selected: string | null; today: string; back: string }) {
  const p = useProposal();
  const [local, setLocal] = useState<string | null>(null), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const existing = selected === null ? null : (data[selected] ?? null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), name = selected ?? employerKey(String(f.get("name") ?? ""));
    if (name === "") return setLocal("Give the employer name.");
    if (selected === null && data[name]) return setLocal("That employer is on the list already. Select it to change it.");
    setLocal(null); setBusy(true);
    let file: { id: string; name: string } | null = null;
    const picked = f.get("evidenceFile");
    if (picked instanceof File && picked.size > 0) {
      const u = await uploadEvidence(picked);
      if (!u.ok) { setBusy(false); return setLocal(`The file did not upload (${u.code || "no answer"}). Nothing was proposed.`); }
      file = u.file;
    }
    setBusy(false);
    const b = payDealEntry(f, existing, file);
    if (!b.ok) return setLocal(b.error);
    await p.send({ action: "propose", kind: "public_pay_employers", effectiveFrom: String(f.get("effectiveFrom")), data: { ...data, [name]: b.value } });
  }
  const form = (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
      <PayDealFields name={selected} e={existing} />
      <DayField today={today} />
      <Outcome failed={p.failed} sent={p.sent} local={local} back={back} />
      <div className="flex gap-2"><Button type="submit" disabled={p.pending || busy}>{busy || p.pending ? "Sending" : selected === null ? "Propose adding it" : "Save"}</Button></div>
    </form>
  );
  if (selected !== null) return form;
  return (
    <>
      <Button type="button" size="md" onClick={() => { p.reset(); setLocal(null); setOpen(true); }}>Add employer</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add a pay-deal employer">{form}</Dialog>
    </>
  );
}
