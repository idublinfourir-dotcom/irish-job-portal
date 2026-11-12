// A refusal as a short code and status for the trust and safety routes; anything unknown is a plain 500 with the reason kept in the server log only.
import { StaffRefused } from "@portal/auth";
import { QueueRefused } from "@portal/db";
import { BadRequest } from "./account-review";
import { statusFor } from "./trust-safety";

export function refusal(e: unknown, route: string): Response {
  const why = e instanceof QueueRefused || e instanceof BadRequest ? e.message.split(":")[0]! : e instanceof StaffRefused ? e.message : null;
  const status = why === null ? null : statusFor(why);
  if (why === null || status === null) {
    console.error(`trust-safety ${route} failed:`, e instanceof Error ? e.message : "unknown");
    return Response.json({ error: "server_error" }, { status: 500 });
  }
  return Response.json({ error: why }, { status });
}
