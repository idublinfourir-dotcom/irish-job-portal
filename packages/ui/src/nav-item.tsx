"use client";
// A sidebar link that marks the page you are on. A layout is not told the address, so this one small client part reads it.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { A } from "./link";

/** True when `path` is the link's page or a page under it ("/jobs/12" is under "/jobs"); "/" matches only itself. */
export const isCurrent = (path: string | null, href: string) => path !== null && (path === href || (href !== "/" && path.startsWith(`${href}/`)));

/** `among`: every link of the same menu, so a page under two of them ("/jobs/new" is under "/jobs") marks only the closest one. */
export const isClosest = (path: string | null, href: string, among: readonly string[] = []) => isCurrent(path, href) && !among.some((o) => o.length > href.length && isCurrent(path, o));

export function NavItem({ href, current, among, base, on, off, children }: { href: string; current?: string; among?: readonly string[]; base: string; on: string; off: string; children: ReactNode }) {
  const path = usePathname();
  const here = current !== undefined ? current === href : isClosest(path, href, among);
  return (
    <A href={href} aria-current={here ? "page" : undefined} className={cx(base, here ? on : off)}>
      {children}
    </A>
  );
}
