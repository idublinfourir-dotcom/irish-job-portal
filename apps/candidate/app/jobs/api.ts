// The writes the job pages make, as plain fetch calls to the documented routes (docs/openapi/candidate.yaml), and the words for every error code
// a route can answer. Client side; `fetchFn` is a parameter so a test gives a fake and no test reaches the network.

export type Sent = { ok: true; body: Record<string, unknown> } | { ok: false; code: string; message: string };
type Fetch = (input: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

const GENERIC = "Something went wrong. Please try again.";
const BY_CODE: Record<string, string> = {
  NO_SESSION: "Your session has ended. Log in again to do this.",
  REFUSED: "This account cannot do that.",
  BAD_ORIGIN: GENERIC,
  BOT_SUSPECTED: "We could not tell you are a person. Reload the page and try again.",
  BAD_REQUEST: "That was not accepted. Check what you entered and try again.",
  BODY_TOO_LARGE: "That is too long. Shorten it and try again.",
  TOO_MANY_REQUESTS: "You are doing that too often. Wait a little and try again.",
  JOB_NOT_FOUND: "This job is no longer available.",
  CLICK_NOT_FOUND: "That question was already answered.",
  SAVED_LIMIT: "You have saved 200 jobs, the most we keep. Remove one first.",
  ALREADY_REPORTED: "You already have an open report on this job. We are looking at it.",
  EMAIL_NOT_VERIFIED: "Confirm your email address first. We sent you a link when you signed up.",
  ALERT_LIMIT: "You already have 10 alerts, the most we allow. Delete one first.",
  STAMP_4: "Alerts are paused for accounts with a Stamp 4.",
  NETWORK: "We could not reach the site. Check your connection and try again.",
};
export const messageFor = (code: string) => BY_CODE[code] ?? GENERIC;

/** One JSON request to one of our own routes. Never throws: a refusal or a lost connection comes back as `{ ok: false, code, message }`. */
export async function send(method: "POST" | "PUT" | "DELETE", path: string, body: unknown, fetchFn: Fetch = (i, o) => fetch(i, o)): Promise<Sent> {
  try {
    const res = await fetchFn(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", keepalive: true });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, body: json ?? {} };
    const code = typeof json?.code === "string" ? json.code : "ERROR";
    return { ok: false, code, message: messageFor(code) };
  } catch {
    return { ok: false, code: "NETWORK", message: BY_CODE.NETWORK! };
  }
}

export const saveJob = (jobId: string, on: boolean, f?: Fetch) => send(on ? "POST" : "DELETE", "/api/candidate/saved", { jobId }, f);
export const markApplied = (jobId: string, f?: Fetch) => send("POST", "/api/candidate/tracker", { jobId }, f);
export const logApplyClick = (jobId: string, f?: Fetch) => send("POST", "/api/candidate/apply-click", { jobId }, f);
export const answerPrompt = (clickId: string, answer: "yes" | "not_yet" | "no", f?: Fetch) => send("POST", "/api/candidate/did-you-apply", { clickId, answer }, f);
export const reportJob = (jobId: string, reason: string, evidence: string, f?: Fetch) =>
  send("POST", "/api/report", { jobId, reason, ...(evidence.trim() ? { evidence: evidence.trim() } : {}) }, f);
export const createAlert = (filters: Record<string, string | number>, frequency: "daily" | "weekly", f?: Fetch) => send("POST", "/api/candidate/alerts", { ...filters, frequency }, f);

/** The job report reasons, in the order of frame C11 (codes are the route's). */
export const REPORT_REASONS = [
  ["asks_for_money", "It asks me to pay money"],
  ["no_sponsorship", "It says no sponsorship"],
  ["job_closed", "The job has closed"],
  ["wrong_details", "The details are wrong"],
  ["other", "Something else"],
] as const;
export const EVIDENCE_MAX = 2000;
