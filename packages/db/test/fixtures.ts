/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Ported from schema-trial-2/common.mjs: the fixture builders (F.cand, F.org, ...), written as postgres so app rights do not limit
// them but every CHECK, foreign key and trigger still fires. Used by the permissions and Launch B tests. Fake data only.
export const in30 = () => new Date(Date.now() + 864e5 * 29);
export const daysAgo = (d) => new Date(Date.now() - 864e5 * d);
export function fixtures(db) {
  const P = new Proxy({}, { get: (_, role) => db.pool(role) });
  const su = (s, a) => P.postgres.query(s, a);
  let n = 0;
  const id = (p) => `${p}-${++n}-${Date.now().toString(36)}`;
  const ins = async (pool, table, obj, ret = "id") => {
    const k = Object.keys(obj),
      v = k.map((x) => (obj[x] !== null && typeof obj[x] === "object" && !(obj[x] instanceof Date) && !Array.isArray(obj[x]) ? JSON.stringify(obj[x]) : obj[x]));
    const r = await (typeof pool === "string" ? P[pool] : pool).query(`insert into ${table}(${k.join(",")}) values(${k.map((_, i) => `$${i + 1}`).join(",")})${ret ? ` returning ${ret}` : ""}`, v);
    return ret ? r.rows[0]?.[ret] : r;
  };
  const F = {};
  F.cand = async (o = {}) => { const i = id("c"); await su("insert into candidate_user(id,name,email,email_verified,created_at,updated_at,suspended_at,deleted_at) values($1,'Fake Candidate',$2,$3,coalesce($4,now()),now(),$5,$6)", [i, `${i}@example.test`, o.verified ?? true, o.created ?? null, o.suspended ?? null, o.deleted ?? null]); return i; };
  F.portal = async (o = {}) => { const i = id("p"); await su("insert into portal_user(id,name,email,email_verified,created_at,updated_at) values($1,'Fake Member',$2,$3,coalesce($4,now()),now())", [i, o.email || `${i}@example.test`, o.verified ?? true, o.created ?? null]); return i; };
  F.staff = async () => { const i = id("s"); await su("insert into staff_user(id,name,email,email_verified,created_at,updated_at) values($1,'Fake Staff',$2,true,now(),now())", [i, `${i}@example.test`]); return i; };
  F.org = async (o = {}) => ins(P.postgres, "organisation", { slug: id("org"), display_name: o.name || "Fake Org", kind: o.kind || "employer", status: o.status || "verified", wrc_licence_number: o.wrc ?? null, cro_number: o.cro ?? null });
  F.member = async (org, user, o = {}) => ins(P.postgres, "membership", { organisation_id: org, portal_user_id: user, role: o.role || "recruiter", status: o.status || "active", invited_email: o.email ?? null, is_signer: o.signer ?? false });
  F.text = async (purpose = "application") => ins(P.postgres, "consent_text", { purpose, version: id("v"), body: "Fake wording" });
  F.approval = async (kind, table, target, o = {}) => ins(P.postgres, "approval_request", { kind, target_table: table, target_id: String(target), proposed_by_staff_user_id: o.by, confirmed_by_staff_user_id: o.status === "pending" ? null : (o.confirmer ?? null), status: o.status || "confirmed", decided_at: o.status === "pending" ? null : new Date() });
  return { P, su, id, ins, F };
}
