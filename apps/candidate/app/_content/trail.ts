// Previous and Next for a list read by cursor (#125: no page numbers). The read gives a `next` cursor only, so the address carries the cursors of the pages
// already passed (`back`, comma separated, newest last): Previous is the last of them, Next adds this page's own cursor. The trail is only ever used to build
// links and the read is only ever given `after`, which the read checks; a bad trail is dropped, never trusted, and is cut to the last TRAIL_MAX pages.
export const TRAIL_MAX = 8;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

export const parseTrail = (raw: string | string[] | undefined): string[] => {
  const v = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return v.split(",").filter((c) => CURSOR.test(c)).slice(-TRAIL_MAX);
};
export const cursorOf = (raw: string | string[] | undefined): string | undefined => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && CURSOR.test(v) ? v : undefined;
};

/** `href(params)` makes the address of the page with those query parameters. */
export function pagerLinks(opts: { base: string; keep?: Record<string, string>; after?: string; back: string[]; next: string | null }): { prevHref?: string; nextHref?: string } {
  const href = (after: string | undefined, back: string[]) => {
    const q = new URLSearchParams(opts.keep);
    if (after) q.set("after", after);
    if (back.length) q.set("back", back.slice(-TRAIL_MAX).join(","));
    const s = q.toString();
    return s ? `${opts.base}?${s}` : opts.base;
  };
  if (opts.after === undefined) return { nextHref: opts.next ? href(opts.next, []) : undefined };
  // On a later page: Previous is the page we came from (the last of the trail, or the first page when the trail is empty), Next goes on and remembers this page.
  const prev = opts.back.at(-1);
  return {
    prevHref: prev ? href(prev, opts.back.slice(0, -1)) : href(undefined, []),
    nextHref: opts.next ? href(opts.next, [...opts.back, opts.after]) : undefined,
  };
}
