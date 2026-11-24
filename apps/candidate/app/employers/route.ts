// /employers: the "For employers" link of the header, the phone menu and the footer. The employer portal is a separate app on its own address, so this is a temporary redirect (307, the address
// can change) to that one address, `employersHref()` (the portal's own origin from PORTAL_AUTH_URL), and the site's 404 when the portal's address is not set (production without it). Nothing from
// the request (no query, no header) is passed on, so the only place it can ever send a visitor is that one origin.
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { employersHref } from "../_home/meta";

export function GET() {
  const href = employersHref();
  if (!href) notFound();
  return NextResponse.redirect(href, 307);
}
