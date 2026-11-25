// The words of the accounts page, pure so a test covers them. A login id is an opaque text from the auth library: it is shown as text, never as a link or markup.
export const HOLD_REASONS: readonly (readonly [string, string])[] = [
  ["fake_documents", "Fake documents"], ["scam", "Scam or fraud"], ["abuse", "Abuse of other users"], ["ban_evasion", "Ban evasion"], ["other", "Another reason"],
];
export const LIFT_REASONS: readonly (readonly [string, string])[] = [
  ["appeal_upheld", "Appeal upheld"], ["held_by_mistake", "Held by mistake"], ["other", "Another reason"],
];
/** The four hold and lift forms: the route's action, the heading, what the button says and what the confirm dialog warns of. */
export const HOLDS = [
  { pool: "candidate", action: "suspend_candidate", label: "Suspend a candidate login", confirm: "Suspend this candidate login? Every open session ends now and the person cannot sign in until you lift it.", reasons: HOLD_REASONS, danger: true },
  { pool: "candidate", action: "lift_candidate", label: "Lift a candidate suspension", confirm: "Lift the suspension? The person can sign in again.", reasons: LIFT_REASONS, danger: false },
  { pool: "portal", action: "block_portal", label: "Block an employer or agency login", confirm: "Block this employer or agency login? Every open session ends now and the person cannot sign in until you lift it.", reasons: HOLD_REASONS, danger: true },
  { pool: "portal", action: "lift_portal", label: "Lift an employer or agency block", confirm: "Lift the block? The person can sign in again.", reasons: LIFT_REASONS, danger: false },
] as const;
