// No database and no network: the set-up's statements in order against a recording fake, and what never reaches SQL text or a log line.
// pg_cron, pg_net and the Vault cannot run on the test database (pg_cron lives in one fixed database, and pg_net would call the real GitHub),
// so those statements are checked here as text; the outbox condition inside the job is run for real in packages/db/test/outbox.test.ts.
import { describe, expect, it } from "vitest";
import { DAILY_CAP, DUE, SENT_TODAY } from "./outbox-cli.ts";
import { JOBS, OUTBOX_WHEN, REPO, SECRET_NAME, TOKEN_SHAPE, dispatchSql, main, type Deps } from "./scheduler-setup-cli.ts";

const TOKEN = `github_pat_${"A1b2_".repeat(10)}`;
const ENV = { SCHEDULER_DATABASE_URL: "postgres://nobody@db.invalid/postgres" };

type Call = { text: string; values?: unknown[] };
function fake(opts: { token?: string; answer?: Record<string, unknown> | null; canDecrypt?: boolean; secretExists?: boolean; queueReadable?: boolean; fail?: RegExp } = {}) {
  const calls: Call[] = [], lines: string[] = [];
  let ended = 0, asked = 0;
  const deps: Deps = {
    connect: async () => ({
      query: async (text, values) => {
        calls.push({ text, values });
        if (opts.fail?.test(text)) throw new Error(`boom near ${opts.token ?? TOKEN}`); // a database error that repeats the value it was given
        if (text.startsWith("select id from vault.secrets")) return { rows: opts.secretExists ? [{ id: "7095d222-efe5-4cd5-b5c6-5755b451e223" }] : [] };
        if (text.includes("_crypto_aead_det_decrypt")) return { rows: [{ can: opts.canDecrypt ?? false }] };
        if (text.includes("net.http_request_queue")) return { rows: [{ can: opts.queueReadable ?? false }] };
        if (text.startsWith("select net.http_post")) return { rows: [{ http_post: "41" }] };
        if (text.includes("from net._http_response where id")) return { rows: opts.answer === null ? [] : [opts.answer ?? { status_code: 204, timed_out: false, error: "" }] };
        if (text.includes("from cron.job_run_details")) return { rows: [{ jobname: "portal-outbox", at: "2026-11-27 07:00", status: "succeeded", message: "1 row" }, { jobname: "portal-backup", at: "2026-11-27 06:47", status: "failed", message: "relation \"net.http_post\" does not exist" }] };
        if (text.includes("from cron.job")) return { rows: JOBS.map((j) => ({ jobname: j.name, schedule: j.schedule, active: true })) };
        if (text.includes("from net._http_response order by")) return { rows: [{ at: "2026-11-27 06:47", status_code: 204, timed_out: false, error: "" }] };
        return { rows: [] };
      },
      end: async () => { ended++; },
    }),
    readToken: async () => { asked++; return opts.token ?? TOKEN; },
    sleep: async () => {},
  };
  return { deps, calls, lines, log: (l: string) => lines.push(l), ended: () => ended, asked: () => asked };
}

describe("the job statements", () => {
  it("call only this repository's two workflows on main, and read the token from the Vault by name", () => {
    expect(JOBS.map((j) => [j.name, j.schedule])).toEqual([["portal-backup", "47 */6 * * *"], ["portal-outbox", "*/15 * * * *"], ["portal-cron-log", "23 3 * * *"]]);
    expect(JOBS[0].command).toBe(dispatchSql("backup.yml", "true"));
    expect(JOBS[1].command).toBe(dispatchSql("outbox.yml", OUTBOX_WHEN));
    for (const [sql, workflow] of [[JOBS[0].command, "backup.yml"], [JOBS[1].command, "outbox.yml"]] as const) {
      expect(sql).toContain(`url := 'https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches'`);
      expect(sql).toContain(`body := '{"ref":"main"}'::jsonb`);
      expect(sql).toContain(`(select decrypted_secret from vault.decrypted_secrets where name = '${SECRET_NAME}')`);
      expect(sql.match(/https?:\/\//g)).toHaveLength(1);
    }
    for (const j of JOBS) expect(j.command, j.name).not.toMatch(/github_pat_|ghp_|\$\d/); // no token and no parameter: the text is stored in cron.job as it is
  });
  it("the outbox job asks the sender's own questions: a row is due, and the day's limit has room", () => {
    expect(OUTBOX_WHEN).toBe(`exists (select 1 from email_outbox where ${DUE}) and (${SENT_TODAY}) < ${DAILY_CAP}`);
  });
  it("the third job only trims pg_cron's own run log to a week, and calls nothing", () => {
    expect(JOBS[2].command).toBe("delete from cron.job_run_details where end_time < now() - interval '7 days'");
  });
});

describe("the set-up", () => {
  it("stores the token as a parameter, schedules both jobs, checks no app login can decrypt, commits, then proves it with one call", async () => {
    const f = fake();
    expect(await main([], ENV, f.log, f.deps)).toBe(0);
    const texts = f.calls.map((c) => c.text);
    expect(texts.slice(0, 3)).toEqual(["begin", "create extension if not exists pg_cron", "create extension if not exists pg_net"]);
    expect(f.calls.find((c) => c.text.startsWith("select vault.create_secret"))!.values).toEqual([TOKEN, SECRET_NAME, expect.any(String)]);
    const scheduled = f.calls.filter((c) => c.text === "select cron.schedule($1, $2, $3)").map((c) => c.values);
    expect(scheduled).toEqual(JOBS.map((j) => [j.name, j.schedule, j.command]));
    expect(texts.indexOf("commit")).toBeGreaterThan(texts.findIndex((t) => t.includes("_crypto_aead_det_decrypt")));
    // after the commit (pg_net sends only then): the outbox job's own statement once, then the test call that starts one backup
    expect(texts.slice(texts.indexOf("commit") + 1).filter((t) => t.startsWith("select net.http_post"))).toEqual([JOBS[1].command, JOBS[0].command]);
    expect(f.lines.at(-1)).toBe("GitHub accepted the test call (204): one backup run has started, and the trigger works");
    expect(f.ended()).toBe(1);
  });
  it("a second run replaces the stored token and does not add a second secret", async () => {
    const f = fake({ secretExists: true });
    expect(await main([], ENV, f.log, f.deps)).toBe(0);
    expect(f.calls.find((c) => c.text.startsWith("select vault.update_secret"))!.values).toEqual(["7095d222-efe5-4cd5-b5c6-5755b451e223", TOKEN]);
    expect(f.calls.some((c) => c.text.startsWith("select vault.create_secret"))).toBe(false);
  });
  it("security: the token is in no SQL text and no log line, even when a statement fails with it in the message", async () => {
    for (const f of [fake(), fake({ fail: /update_secret|create_secret/ }), fake({ answer: { status_code: 401, timed_out: false, error: "" } })]) {
      await main([], ENV, f.log, f.deps);
      for (const c of f.calls) expect(c.text).not.toContain(TOKEN);
      for (const l of f.lines) expect(l).not.toContain(TOKEN);
      for (const l of f.lines) expect(l).not.toContain("db.invalid"); // nor the database address
    }
  });
  it("security: rolls back and stores nothing when an app login could decrypt the Vault", async () => {
    const f = fake({ canDecrypt: true });
    expect(await main([], ENV, f.log, f.deps)).toBe(1);
    const texts = f.calls.map((c) => c.text);
    expect(texts).toContain("rollback");
    expect(texts).not.toContain("commit");
    expect(texts.some((t) => t.startsWith("select net.http_post"))).toBe(false);
    expect(f.lines.at(-1)).toBe("refused: an app login can decrypt Vault secrets; nothing was changed");
  });
  it("security: refuses a classic token, an empty one and hostile text before it connects", async () => {
    expect(TOKEN_SHAPE.test(TOKEN)).toBe(true);
    for (const bad of ["", "ghp_" + "a".repeat(36), "github_pat_short", `${TOKEN}'; drop table job; --`, `${TOKEN}\n${TOKEN}`]) {
      const f = fake({ token: bad });
      expect(await main([], ENV, f.log, f.deps), bad.slice(0, 12)).toBe(2);
      expect(f.calls).toHaveLength(0);
    }
  });
  it("security: never takes the token as an argument, and needs the database address", async () => {
    for (const argv of [[TOKEN], ["--token", TOKEN], ["--status", "x"]]) {
      const f = fake();
      expect(await main(argv, ENV, f.log, f.deps)).toBe(2);
      expect(f.asked()).toBe(0);
      expect(f.calls).toHaveLength(0);
      for (const l of f.lines) expect(l).not.toContain(TOKEN);
    }
    const f = fake();
    expect(await main([], {}, f.log, f.deps)).toBe(2);
    expect(f.asked()).toBe(0);
  });
  it("a mistake in the outbox job's statement is reported at set-up, not left as a job that fails every 15 minutes", async () => {
    const f = fake({ fail: /outbox\.yml/ });
    expect(await main([], ENV, f.log, f.deps)).toBe(1);
    expect(f.lines.at(-1)).toBe("refused: boom near [token]");
  });
  it("says what to check when GitHub refuses, and when no answer comes", async () => {
    const refused = fake({ answer: { status_code: 403, timed_out: false, error: "" } });
    expect(await main([], ENV, refused.log, refused.deps)).toBe(1);
    expect(refused.lines.at(-1)).toMatch(/^GitHub refused the test call: 403\. 401 or 403: the token lacks "Actions: read and write"/);
    const silent = fake({ answer: null });
    expect(await main([], ENV, silent.log, silent.deps)).toBe(1);
    expect(silent.lines.at(-1)).toBe("no answer from GitHub within 20 seconds; run again with --status in a minute");
    expect(silent.calls.filter((c) => c.text.includes("from net._http_response where id"))).toHaveLength(20);
  });
  it("notes when the read-only login can see pg_net's waiting calls", async () => {
    const f = fake({ queueReadable: true });
    await main([], ENV, f.log, f.deps);
    expect(f.lines.some((l) => l.startsWith("note: the read-only backup login can read pg_net's request queue"))).toBe(true);
  });
  it("--status asks for no token, changes nothing, and prints the jobs and GitHub's last answers", async () => {
    const f = fake();
    expect(await main(["--status"], ENV, f.log, f.deps)).toBe(0);
    expect(f.asked()).toBe(0);
    expect(f.calls.map((c) => c.text).every((t) => t.startsWith("select ") && !/vault|cron\.schedule|http_post|create extension/.test(t))).toBe(true);
    expect(f.lines).toEqual([
      "job portal-backup: 47 */6 * * *, on", "job portal-outbox: */15 * * * *, on", "job portal-cron-log: 23 3 * * *, on",
      "run 2026-11-27 07:00 UTC portal-outbox: succeeded", 'run 2026-11-27 06:47 UTC portal-backup: failed (relation "net.http_post" does not exist)',
      "answer 2026-11-27 06:47 UTC: 204",
    ]);
  });
});
