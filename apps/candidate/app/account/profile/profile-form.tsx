"use client";
// The profile and CV forms (frame NA3). Uncontrolled fields read with FormData; the saves are PUT /api/candidate/profile and PUT, DELETE /api/candidate/cv
// (docs/openapi/candidate.yaml). The CV download is the route's own link (a 302 to a link that works for 60 seconds), never stored in the page.
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Icon, Input, Notice, Radio, Select } from "@portal/ui";
import { shortDate, eur } from "../../_home/format";
import { send } from "../send";
import { sayAccount } from "../settings-messages";
import { ReauthNotice } from "../reauth";
import { settingsDeletePath } from "../../../lib/paths";

export type ProfileData = {
  fullName: string | null; phone: string | null; occupationCode: string | null; yearsExperience: number | null; hasRelevantDegree: boolean | null; degreeField: string | null;
  degreeAwardedMonth: string | null; registrationBody: string | null; registrationNumber: string | null; registrationStatus: string | null; locationKind: string | null;
  currentStamp: string | null; degreeBox: "relevant" | "last_12_months" | "none";
};
export type CvInfo = { fileName: string; contentType: string; sizeBytes: number; uploadedAt: string };
export type Mins = { criticalSkills: number; graduate: number; graduateMonths: number };
// The stamps the profile accepts (the Profile schema in docs/openapi/candidate.yaml; a test compares the two).
export const STAMPS = ["0", "1", "1A", "1G", "1H", "2", "2A", "3", "4", "4EUFAM", "4D", "4S", "5", "6"] as const;
export const MAX_CV_BYTES = 4194304;

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const orNull = (v: FormDataEntryValue | null) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** The degree card's three choices (DD14: the second one asks for a month). */
export function DegreeCard({ box, month, field, mins, limits, onBox }: { box: ProfileData["degreeBox"]; month: string; field: string; mins: Mins | null; limits: { min: string; max: string }; onBox?: (b: ProfileData["degreeBox"]) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Your degree" className="flex flex-col gap-2">
        <Radio label="I have a relevant degree" name="degree" value="relevant" checked={box === "relevant"} onChange={() => onBox?.("relevant")} />
        <Radio label="I got my degree in the last 12 months" name="degree" value="last_12_months" checked={box === "last_12_months"} onChange={() => onBox?.("last_12_months")} />
        <Radio label="I do not have a relevant degree" name="degree" value="none" checked={box === "none"} onChange={() => onBox?.("none")} />
      </div>
      {box === "last_12_months" && <Input label="Month you got your degree" name="degreeMonth" type="month" required min={limits.min} max={limits.max} defaultValue={month} help="Pick the month of your award. It must be in the last 12 months." />}
      {box !== "none" && <Input label="Degree subject (optional)" name="degreeField" maxLength={120} defaultValue={field} />}
      {mins && (
        <p className="flex gap-3 rounded-card bg-lilac p-4">
          <Icon name="euro" size={20} className="mt-0.5 shrink-0" />
          <span>
            {box === "none" ? "Without a relevant degree a Critical Skills role needs a higher minimum, shown on each job page." : box === "last_12_months"
              ? <>As a recent graduate your Critical Skills minimum is <strong>{eur(mins.graduate)}</strong> a year, for {mins.graduateMonths} months after your award. After that it is <strong>{eur(mins.criticalSkills)}</strong>.</>
              : <>Your Critical Skills minimum is <strong>{eur(mins.criticalSkills)}</strong> a year. We pre-fill it on every job page.</>}
          </span>
        </p>
      )}
    </div>
  );
}

export function CvCard({ cv, error, busy, onUpload, onRemove, saved }: { cv: CvInfo | null; error?: string; busy?: boolean; onUpload?: (f: File | null) => void; onRemove?: () => void; saved?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-3">
      {cv ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card bg-lilac p-4">
          <Icon name="file" size={22} className="shrink-0" />
          <p className="min-w-0 flex-1 break-words"><span className="block font-semibold">{cv.fileName}</span><span className="text-small text-muted">{kb(cv.sizeBytes)} · uploaded {shortDate(cv.uploadedAt.slice(0, 10))}</span></p>
          <Button href="/api/candidate/cv/download" variant="outline" size="sm" rel="noreferrer">Download</Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>Replace</Button>
          <Button type="button" variant="danger" size="sm" disabled={busy} onClick={onRemove}>Remove</Button>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-card border border-dashed border-line-strong p-5">
          <p className="text-muted">No CV yet. A PDF or Word file up to 4 MB. You can add it any time.</p>
          <Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()}>Upload a CV</Button>
        </div>
      )}
      <input ref={input} type="file" name="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" tabIndex={-1} aria-label="Choose a CV file"
        onChange={(e) => { onUpload?.(e.target.files?.[0] ?? null); e.target.value = ""; }} />
      {saved && <p role="status" className="text-small font-semibold text-pressed-dark">{saved}</p>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

export function ProfileForm({ profile, cv: first, mins, bodies, limits, occupationOptions }: { profile: ProfileData | null; cv: CvInfo | null; mins: Mins | null; bodies: { id: string; name: string }[]; limits: { min: string; max: string }; occupationOptions: ReactNode }) {
  const [box, setBox] = useState<ProfileData["degreeBox"]>(profile?.hasRelevantDegree ? profile.degreeBox : "none");
  const [where, setWhere] = useState(profile?.locationKind ?? "abroad");
  const [occStatus, setOccStatus] = useState<string | undefined>(undefined);
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text?: string; reauth?: boolean; stamp4?: boolean }>({ kind: "idle" });
  const [cv, setCv] = useState(first), [cvState, setCvState] = useState<{ error?: string; busy?: boolean; saved?: string }>({});

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const degree = f.get("degree");
    const body = {
      fullName: orNull(f.get("fullName")), phone: orNull(f.get("phone")), occupationCode: orNull(f.get("occupationCode")),
      yearsExperience: orNull(f.get("yearsExperience")) === null ? null : Number(f.get("yearsExperience")),
      hasRelevantDegree: degree === "none" ? false : true,
      degreeField: degree === "none" ? null : orNull(f.get("degreeField")),
      // "last 12 months" needs the month; "relevant" keeps whatever month was stored (the box derives from it, so an old one stays "relevant").
      degreeAwardedMonth: degree === "last_12_months" ? (orNull(f.get("degreeMonth")) ? `${orNull(f.get("degreeMonth"))}-01` : null) : degree === "relevant" ? profile?.degreeAwardedMonth ?? null : null,
      registrationBody: orNull(f.get("registrationBody")), registrationNumber: orNull(f.get("registrationNumber")), registrationStatus: orNull(f.get("registrationStatus")),
      locationKind: where, currentStamp: where === "ireland" ? orNull(f.get("currentStamp")) : null,
    };
    setState({ kind: "saving" });
    const r = await send("PUT", "/api/candidate/profile", body);
    if (r.ok) return void setState({ kind: "saved", stamp4: r.json?.deletionOffered === true });
    const s = sayAccount(r);
    setState({ kind: "error", text: s.text, reauth: s.reauth });
  }
  async function upload(file: File | null) {
    if (!file) return;
    if (file.size > MAX_CV_BYTES) return void setCvState({ error: sayAccount({ ok: false, status: 413, code: "FILE_TOO_LARGE" }).text });
    setCvState({ busy: true });
    const form = new FormData(); form.set("file", file);
    const r = await send("PUT", "/api/candidate/cv", form);
    if (!r.ok) return void setCvState({ error: sayAccount(r).text });
    setCv((r.json as { cv: CvInfo }).cv); setCvState({ saved: "CV saved." });
  }
  async function remove() {
    setCvState({ busy: true });
    const r = await send("DELETE", "/api/candidate/cv");
    if (!r.ok && r.code !== "CV_NOT_FOUND") return void setCvState({ error: sayAccount(r).text });
    setCv(null); setCvState({ saved: "CV removed." });
  }
  const stamp = profile?.currentStamp ?? "";
  return (
    <>
      <form onSubmit={save} aria-busy={state.kind === "saving" || undefined} className="flex flex-col gap-6">
        <Section1 profile={profile} occupationOptions={occupationOptions} status={occStatus} onOcc={setOccStatus} />
        <Card num={2} title="Degree"><DegreeCard box={box} month={profile?.degreeAwardedMonth?.slice(0, 7) ?? ""} field={profile?.degreeField ?? ""} mins={mins} limits={limits} onBox={setBox} /></Card>
        <Card num={3} title="Registration and location">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Registration body" name="registrationBody" defaultValue={profile?.registrationBody ?? ""}>
              <option value="">None</option>
              {bodies.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Select label="Status" name="registrationStatus" defaultValue={profile?.registrationStatus ?? "none"}>
              <option value="none">Not started</option><option value="in_progress">In progress</option><option value="registered">Registered</option>
            </Select>
            <Input label="Registration number (optional)" name="registrationNumber" maxLength={60} defaultValue={profile?.registrationNumber ?? ""} />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-small font-semibold">Where are you now?</legend>
            <div className="flex flex-wrap gap-4">
              <Radio label="Abroad" name="locationKind" value="abroad" checked={where === "abroad"} onChange={() => setWhere("abroad")} />
              <Radio label="In Ireland" name="locationKind" value="ireland" checked={where === "ireland"} onChange={() => setWhere("ireland")} />
            </div>
          </fieldset>
          {where === "ireland" && (
            <Select label="Current immigration stamp" name="currentStamp" defaultValue={stamp}>
              <option value="">Not sure</option>
              {STAMPS.map((s) => <option key={s} value={s}>Stamp {s}</option>)}
            </Select>
          )}
        </Card>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="dark" size="lg" disabled={state.kind === "saving"}>{state.kind === "saving" ? "Saving" : "Save changes"}</Button>
          {state.kind === "saved" && <span role="status" className="inline-flex items-center gap-1.5 rounded-pill bg-critical-skills px-3 py-1.5 text-small font-semibold text-pressed-dark"><Icon name="check" size={16} />Saved</span>}
        </div>
        {state.kind === "saved" && state.stamp4 && (
          <Notice kind="info" title="Your stamp means you no longer need a permit">We paused your job alerts. You can <a className="font-semibold underline" href={settingsDeletePath()}>delete your account</a> if you do not want to keep it.</Notice>
        )}
        {state.kind === "error" && (state.reauth ? <ReauthNotice text={state.text!} back="/account/profile" /> : <Notice kind="error">{state.text}</Notice>)}
      </form>
      <Card num={4} title="CV"><CvCard cv={cv} error={cvState.error} busy={cvState.busy} saved={cvState.saved} onUpload={upload} onRemove={remove} /></Card>
    </>
  );
}

function Card({ num, title, children }: { num: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
      <h2 className="flex items-center gap-3 text-[1.375rem]"><span aria-hidden="true" className="grid size-8 place-items-center rounded-pill bg-ink text-small font-semibold text-white">{num}</span>{title}</h2>
      {children}
    </section>
  );
}

function Section1({ profile, occupationOptions, status, onOcc }: { profile: ProfileData | null; occupationOptions: ReactNode; status?: string; onOcc: (s: string | undefined) => void }) {
  const listed = status === "critical-skills";
  return (
    <Card num={1} title="About you">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Your name" name="fullName" autoComplete="name" maxLength={120} defaultValue={profile?.fullName ?? ""} />
        <Input label="Phone (optional)" name="phone" type="tel" autoComplete="tel" maxLength={30} pattern="\+?[0-9 ()\-]{5,30}" defaultValue={profile?.phone ?? ""} />
      </div>
      <Select label="Occupation" name="occupationCode" defaultValue={profile?.occupationCode ?? ""}
        onChange={(e) => onOcc(e.currentTarget.selectedOptions[0]?.dataset.status)}
        note={status === undefined ? undefined : listed ? "On the Critical Skills list" : undefined} {...(listed ? { status: "passed" as const } : {})}>
        <option value="">Choose an occupation</option>
        {occupationOptions}
      </Select>
      <Input label="Years of experience" name="yearsExperience" type="number" min={0} max={60} inputMode="numeric" defaultValue={profile?.yearsExperience ?? ""} />
    </Card>
  );
}
