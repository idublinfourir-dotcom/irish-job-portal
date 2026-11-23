import Link from "next/link";
import type { ComponentProps } from "react";

/** Our own paths go through next/link (no full reload); anything else is a plain anchor. */
export function A({ href, ...rest }: Omit<ComponentProps<"a">, "href"> & { href: string }) {
  return href.startsWith("/") ? <Link href={href} {...rest} /> : <a href={href} {...rest} />;
}
