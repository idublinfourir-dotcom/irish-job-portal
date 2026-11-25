"use client";
// The account links: one list, drawn three ways (the card of frame NA1 from 1024 px, a row you scroll sideways on a phone, and the phone's bottom bar of frame M07).
// A layout is not told the address, so the one small client part reads it.
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { A, cx } from "@portal/ui";

/** The page you are on: the home link only on its own address, every other link on its page and the pages under it. */
export const isHere = (path: string | null, href: string) => path !== null && (path === href || (href !== "/account" && path.startsWith(`${href}/`)));

export function NavLink({ href, base, on, off, children }: { href: string; base: string; on: string; off: string; children: ReactNode }) {
  const here = isHere(usePathname(), href);
  return <A href={href} aria-current={here ? "page" : undefined} className={cx(base, here ? on : off)}>{children}</A>;
}
