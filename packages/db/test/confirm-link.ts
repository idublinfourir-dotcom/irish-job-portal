// SEC-3: the emailed verify, change-email and new-email links open our own /confirm-email page, which changes nothing; its button is a GET form
// to Better Auth's /verify-email with the same token and callbackURL. Tests that only need the address confirmed "press" that button here.
// Any other link (reset, invite) passes through unchanged.
type Row = { link: string };

export function pressConfirm(link: string, pool: "candidate" | "portal"): string {
  const u = new URL(link);
  return u.pathname === "/confirm-email" ? `${u.origin}/api/auth/${pool}/verify-email${u.search}` : link;
}
/** The app's outbox with each confirm-page link replaced by the button's target. */
export const pressed = <R extends Row>(outbox: () => R[], pool: "candidate" | "portal") => () => outbox().map((m) => ({ ...m, link: pressConfirm(m.link, pool) }));
