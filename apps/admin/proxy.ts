import type { NextRequest } from "next/server";
import { nonceProxy } from "../../security-headers";

export function proxy(request: NextRequest) {
  return nonceProxy(request);
}

// Pages only: not static files, images or prefetches (they carry no inline scripts), as in Next's CSP guide.
export const config = {
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
