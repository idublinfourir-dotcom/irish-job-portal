/* eslint-disable */
// @ts-nocheck
// Lets the trial scripts (clash, retest, two-person) run close to as written. The trial's `rule` and
// `line` ran an attempt and printed PASS or FAIL. Here they run the attempt at once (so the order of
// fixtures and checks is the trial's order) and register one `it` named like the trial line, which
// fails with the same message. `known` maps "[table] name" to a hand-over entry for checks that
// really differ from the proven SQL: those become `it.fails`.
import { it } from "vitest";

const text = (e) => `${e.code || ""} ${e.message}`;
export const in30 = () => new Date(Date.now() + 864e5 * 29);
export const daysAgo = (d) => new Date(Date.now() - 864e5 * d);

export function setup(db, known0 = {}) {
  const known = process.env.NOKNOWN ? {} : known0; // NOKNOWN=1 shows the real errors of the it.fails checks
  const P = new Proxy({}, { get: (_, role) => db.pool(role) });
  const su = (s, a) => P.postgres.query(s, a);
  let n = 0;
  const id = (p) => `${p}-${++n}-${Date.now().toString(36)}`;
  const R = [];
  // known value "S-..." = replaced by a later proven test (skipped); any other value = a real difference (it.fails)
  const pick = (title) => (!known[title] ? it : known[title].startsWith("S-") ? it.skip : it.fails);
  const line = (table, name, refused, allowed, detail = "") => {
    R.push({ table, rule: name, refused, allowed });
    const title = `[${table}] ${name}`;
    if (refused === null && allowed === null) return it.skip(title, () => {});
    const ok = refused !== false && allowed !== false;
    const body = () => {
      if (!ok) throw new Error(`refused=${refused} allowed=${allowed} ${detail}`.slice(0, 600));
    };
    pick(title)(title, body);
  };
  async function rule(table, name, spec) {
    let refused = null, allowed = null, detail = "";
    for (const step of Object.keys(spec)) {
      if (step === "refuse") {
        try { await spec.refuse(); refused = false; detail += "bad action was accepted. "; }
        catch (e) {
          const m = text(e);
          refused = spec.expect ? m.toLowerCase().includes(spec.expect.toLowerCase()) : true;
          detail += `refused: ${m}`.slice(0, 200) + ". ";
          if (!refused) detail += `(expected "${spec.expect}") `;
        }
      } else if (step === "ok") {
        try { await spec.ok(); allowed = true; }
        catch (e) { allowed = false; detail += `good action failed: ${text(e)}`.slice(0, 300); }
      }
    }
    line(table, name, refused, allowed, detail);
  }
  const ins = async (pool, table, obj, ret = "id") => {
    const k = Object.keys(obj), v = k.map((x) => (obj[x] !== null && typeof obj[x] === "object" && !(obj[x] instanceof Date) && !Array.isArray(obj[x])) ? JSON.stringify(obj[x]) : obj[x]);
    const r = await (typeof pool === "string" ? P[pool] : pool).query(`insert into ${table}(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")})${ret ? ` returning ${ret}` : ""}`, v);
    return ret ? r.rows[0]?.[ret] : r;
  };
  const race = async (count, fn) => { const r = await Promise.allSettled(Array.from({ length: count }, (_, i) => fn(i))); return { ok: r.filter((x) => x.status === "fulfilled"), bad: r.filter((x) => x.status === "rejected"), values: r.map((x) => x.value), errors: r.filter((x) => x.status === "rejected").map((x) => x.reason?.message) }; };
  const tx = async (pool, fn) => { const cl = await (typeof pool === "string" ? P[pool] : pool).connect(); try { await cl.query("begin"); const r = await fn(cl); await cl.query("commit"); return r; } catch (e) { await cl.query("rollback").catch(() => {}); throw e; } finally { cl.release(); } };
  const F = {};
  F.cand = async (o = {}) => { const i = id("c"); await su("insert into candidate_user(id,name,email,email_verified,created_at,updated_at,suspended_at,deleted_at) values($1,'Fake Candidate',$2,$3,coalesce($4,now()),now(),$5,$6)", [i, `${i}@example.test`, o.verified ?? true, o.created ?? null, o.suspended ?? null, o.deleted ?? null]); return i; };
  F.portal = async (o = {}) => { const i = id("p"); await su("insert into portal_user(id,name,email,email_verified,created_at,updated_at) values($1,'Fake Member',$2,$3,coalesce($4,now()),now())", [i, o.email || `${i}@example.test`, o.verified ?? true, o.created ?? null]); return i; };
  F.staff = async () => { const i = id("s"); await su("insert into staff_user(id,name,email,email_verified,created_at,updated_at) values($1,'Fake Staff',$2,true,now(),now())", [i, `${i}@example.test`]); return i; };
  F.org = async (o = {}) => ins(P.postgres, "organisation", { slug: id("org"), display_name: o.name || "Fake Org", kind: o.kind || "employer", status: o.status || "verified", wrc_licence_number: o.wrc ?? null, cro_number: o.cro ?? null });
  F.member = async (org, user, o = {}) => ins(P.postgres, "membership", { organisation_id: org, portal_user_id: user, role: o.role || "recruiter", status: o.status || "active", invited_email: o.email ?? null, is_signer: o.signer ?? false });
  F.text = async (purpose = "application") => ins(P.postgres, "consent_text", { purpose, version: id("v"), body: "Fake wording" });
  // Adapted: the migrations stamp proposer and confirmer from `set local app.staff_user_id` and need each to hold a role,
  // so a request is built the real way (proposer inserts, confirmer updates) instead of one insert with every column set.
  const giveRole = (s) => su("insert into staff_role(staff_user_id,role,seeded_by_owner) select $1,'administrator',true where not exists (select 1 from staff_role where staff_user_id=$1 and role='administrator')", [s]);
  F.approval = async (kind, table, target, o = {}) => {
    const st = o.status || "confirmed";
    await giveRole(o.by); if (st !== "pending") await giveRole(o.confirmer);
    return tx(P.postgres, async (c) => {
      // ported change: only one pending request per (kind, table, target) now; park an earlier pending one while the new row is made
      const parked = st === "pending" ? [] : (await c.query("update approval_request set target_id = target_id || '~parked' where kind=$1 and target_table=$2 and target_id=$3 and status='pending' returning id", [kind, table, String(target)])).rows;
      await c.query("select set_config('app.staff_user_id',$1,true)", [o.by]);
      const rid = (await c.query("insert into approval_request(kind,target_table,target_id) values($1,$2,$3) returning id", [kind, table, String(target)])).rows[0].id;
      if (st !== "pending") {
        await c.query("select set_config('app.staff_user_id',$1,true)", [o.confirmer]);
        await c.query("update approval_request set status=$2 where id=$1", [rid, st]);
      }
      for (const r of parked) await c.query("update approval_request set target_id = $2 where id=$1", [r.id, String(target)]);
      return rid;
    });
  };
  // A fixture block that crashes (a column or function the migrations changed) shows up as one failing `it`, and the file goes on.
  const blk = async (label, fn) => {
    try { await fn(); } catch (e) { if (process.env.TRIAL_STACK) console.log("STACK", label.slice(0,40), e.stack);
      const title = `[fixture] block ${label}`;
      const at = (String(e.stack || "").match(/test\.ts:\d+/) || [""])[0];
      pick(title)(title, () => { throw new Error(`${text(e).slice(0, 500)} (at ${at})`); });
    }
  };
  return { P, su, id, R, line, rule, ins, race, tx, F, blk };
}
