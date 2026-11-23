"use client";
// A sidebar link that marks the page you are on. A layout is not told the address, so this one small client part reads it.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { A } from "./link";

/** True when `path` is the link's page or a page under it ("/jobs/12" is under "/jobs"); "/" matches only itself. */
export const isCurrent = (path: string | null, href: string) => path !== null && (path === href || (href !== "/" && path.startsWith(`${href}/`)));

export function NavItem({ href, current, base, on, off, children }: { href: string; current?: string; base: string; on: string; off: string; children: ReactNode }) {
  const path = usePathname();
  const here = current !== undefined ? current === href : isCurrent(path, href);
  return (
    <A href={href} aria-current={here ? "page" : undefined} className={cx(base, here ? on : off)}>
      {children}
    </A>
  );
}
