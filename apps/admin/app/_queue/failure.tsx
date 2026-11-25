import { A, Notice } from "@portal/ui";
import { adminWords, needsSignIn } from "./words-adm";

/** A refused write or download as a notice. `reauth_required` carries the sign-in link back to this very page (an own path: the sign-in page checks it again). */
export function Failure({ code, status, back, detail }: { code: string; status: number; back: string; detail?: string }) {
  return (
    <Notice kind="error">
      {adminWords(code, status)}{detail ? ` (${detail})` : ""}
      {needsSignIn(code) && <> <A href={`/sign-in?again=1&next=${encodeURIComponent(back)}`} className="font-semibold underline">Sign in again</A></>}
    </Notice>
  );
}
