import { A } from "./link";
import type { ComponentProps } from "react";
import { cx } from "./cx";

export const BUTTON_VARIANTS = ["primary", "dark", "sun", "outline", "danger", "chip", "active", "filter-on"] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonSize = "sm" | "md" | "lg";

// Theme colours only: the two permit badge colours (critical-skills, sponsor) are never used here (frame NS2 rule).
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-deep-green text-white hover:bg-hover-dark",
  dark: "bg-ink text-cream hover:bg-deep-green",
  sun: "bg-peach text-ink hover:brightness-95",
  outline: "border-2 border-ink bg-transparent text-ink hover:bg-hover-light",
  danger: "bg-error text-white hover:brightness-90",
  chip: "bg-sand text-ink hover:bg-hover-light",
  active: "border-2 border-deep-green bg-green-tint text-ink",
  "filter-on": "bg-deep-green text-white",
};
const SIZE: Record<ButtonSize, string> = { sm: "min-h-9 px-3 text-small", md: "min-h-11 px-5 text-body", lg: "min-h-12 px-6 text-lg" };
const BASE = "inline-flex items-center justify-center gap-2 rounded-control font-semibold no-underline transition-colors";
const OFF = "pointer-events-none bg-disabled text-disabled-ink border-0";

type Own = { variant?: ButtonVariant; size?: ButtonSize };
type Props = Own & ({ href: string } & Omit<ComponentProps<"a">, "href"> | ({ href?: undefined } & ComponentProps<"button">));

/** A button, or a link that looks like one when `href` is given. A disabled link has no href and says so with aria-disabled. */
export function Button({ variant = "primary", size = "md", className, ...rest }: Props) {
  const classes = (off: boolean) => cx(BASE, SIZE[size], off ? OFF : VARIANT[variant], className);
  if (rest.href !== undefined) {
    const { href, ...a } = rest as ComponentProps<"a"> & { href: string };
    const off = a["aria-disabled"] === true || a["aria-disabled"] === "true";
    // An external link gets rel="noopener noreferrer" by default (target _blank always).
    const rel = a.target === "_blank" ? "noopener noreferrer" : a.rel;
    return off ? <a {...a} className={classes(true)} tabIndex={-1} /> : <A {...a} href={href} rel={rel} className={classes(false)} />;
  }
  const b = rest as ComponentProps<"button">;
  return <button type="button" {...b} className={classes(!!b.disabled)} />;
}
