// The employer's answer to "ask for more" (#197): POST /api/portal/review-answer { note }. Same checks as the claim route, in the same order:
// Origin, body size, JSON, body, session, then the rate limit. The portal user id comes from the session; the database function does the real checks.
import { getPool } from "@portal/db";
import { isObject, no, only, readPost, withinLimit } from "./company";

export const NOTE_MAX = 1000; // characters; the database function holds the same cap

// A trimmed, non-empty note of at most NOTE_MAX characters with no control or format character (line breaks, zero-width and right-to-left overrides included).
export function checkAnswer(b: unknown): { note: string } | null {
  if (!isObject(b) || !only(b, ["note"]) || typeof b.note !== "string") return null;
  const note = b.note.trim();
  return note.length >= 1 && [...note].length <= NOTE_MAX && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(note) ? { note } : null;
}

export async function answerPost(request: Request): Promise<Response> {
  const read = await readPost(request, checkAnswer);
  if (read instanceof Response) return read;
  const { login, body } = read;
  if (!(await withinLimit(`answer:${login.userId}`))) return no(429, "TOO_MANY_REQUESTS");
  try {
    const r = (await getPool().query("select private.answer_review($1, $2) r", [login.userId, body.note])).rows[0].r as { organisation_id: number; status: string };
    return Response.json({ organisationId: Number(r.organisation_id), status: r.status });
  } catch (e) {
    const { code, message = "" } = (e ?? {}) as { code?: string; message?: string };
    if (code !== "P0001") throw e;
    if (message.includes("NOT_WAITING")) return no(409, "NOT_WAITING_FOR_ANSWER");
    if (message.includes("BAD_REQUEST")) return no(400, "BAD_REQUEST");
    return no(403, "REFUSED"); // not the owner, no company, blocked: one answer for all, nothing about the company leaks
  }
}
