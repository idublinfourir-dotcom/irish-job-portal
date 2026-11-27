"use client";
import Link, { useLinkStatus } from "next/link";
import type { ComponentProps } from "react";

// Marks the link being followed: CSS (motion.css) dims `a:has(> .lk-pending[data-on])`. Must be a child of the Link.
function Pending() {
  const { pending } = useLinkStatus();
  return pending ? <span className="lk-pending" aria-hidden="true" data-on="" /> : null; // nothing in the markup until a click, so server HTML is unchanged
}

/** Our own paths go through next/link (no full reload); anything else is a plain anchor.
 * Prefetch is off (PERF-5): the pages are dynamic, so each prefetch runs a function and brings back almost nothing. Pass `prefetch` to turn it on for a cached route. */
export function A({ href, children, prefetch = false, ...rest }: Omit<ComponentProps<"a">, "href"> & { href: string; prefetch?: boolean }) {
  return href.startsWith("/") ? (
    <Link href={href} prefetch={prefetch} {...rest}>{children}<Pending /></Link>
  ) : (
    <a href={href} {...rest}>{children}</a>
  );
}
