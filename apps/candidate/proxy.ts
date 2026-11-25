// Hands the account layout the address it was opened on (a layout is not told it), so a signed-out visitor goes to /login?next=<that address>.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-own-path", request.nextUrl.pathname + request.nextUrl.search); // always set here, so a client cannot send its own
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/account", "/account/:path*"] };
