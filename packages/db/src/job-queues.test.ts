// Unit tests for the pure parts of the held-job queues: the queue names and the role that decides each (#244 b), and the refusals that come before
// any database call. No database: the fake pool throws if it is ever used.
import { describe, expect, it } from "vitest";
import { approveJobItem, claimJobItem, getJobQueueItem, isJobQueue, JOB_QUEUES, listJobQueue, mayAct, QueueRefused, rejectJobItem } from ".";

const never = { query: () => { throw new Error("the database was called"); }, connect: () => { throw new Error("the database was called"); } } as never;
const why = async (p: Promise<unknown>) => p.then(() => "accepted", (e) => (e instanceof QueueRefused ? e.why : String(e)));

describe("queues and roles", () => {
  it("names exactly the three held-job queues", () => {
    expect(Object.keys(JOB_QUEUES).sort()).toEqual(["agency_client_check", "post_strike_job_review", "scam_flag"]);
    for (const q of ["fetched_job", "account_review", "", "toString", "__proto__", "SCAM_FLAG", null, 5]) expect(isJobQueue(q), String(q)).toBe(false);
  });
  it("scam_flag is trust_and_safety's, the other two account_reviewer's, an administrator may act on all three, no other role on any", () => {
    expect(mayAct(["trust_and_safety"], "scam_flag")).toBe(true);
    expect(mayAct(["trust_and_safety"], "post_strike_job_review")).toBe(false);
    expect(mayAct(["trust_and_safety"], "agency_client_check")).toBe(false);
    expect(mayAct(["account_reviewer"], "scam_flag")).toBe(false);
    expect(mayAct(["account_reviewer"], "post_strike_job_review")).toBe(true);
    expect(mayAct(["account_reviewer"], "agency_client_check")).toBe(true);
    for (const q of Object.keys(JOB_QUEUES)) {
      expect(mayAct(["administrator"], q as never)).toBe(true);
      for (const r of ["fetched_job_reviewer", "rules_data_editor", "services_case_handler", "content_editor"]) expect(mayAct([r], q as never)).toBe(false);
      expect(mayAct([], q as never)).toBe(false);
    }
  });
});

describe("refused before the database", () => {
  it("an unknown queue, a bad cursor, a bad staff id, a bad item id and a bad reason", async () => {
    expect(await why(listJobQueue(never, "s1", "fetched_job"))).toBe("bad_queue");
    expect(await why(listJobQueue(never, "s1", "scam_flag", { after: "!!" }))).toBe("bad_cursor");
    for (const s of ["", "x".repeat(201), 5 as never]) expect(await why(claimJobItem(never, s, "1"))).toBe("not_active_staff");
    for (const id of ["0", "-1", "1 or 1=1", "99999999999999999999", "1.5"]) expect(await why(approveJobItem(never, "s1", id))).toBe("not_found");
    for (const r of ["", "Bad", "a b", "a".repeat(64), 5 as never]) expect(await why(rejectJobItem(never, "s1", "1", r))).toBe("bad_reason");
    expect(await why(getJobQueueItem(never, "", "1"))).toBe("not_active_staff");
  });
});
