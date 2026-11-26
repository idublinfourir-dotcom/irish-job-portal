import { A } from "./link";
import type { ComponentProps } from "react";
import { cx } from "./cx";

export const BUTTON_VARIANTS = ["primary", "dark", "sun", "outline", "danger", "chip", "active", "filter-on"] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonSize = "sm" | "md" | "lg";

// Frame NS4, every variant and state. Theme colours only: the two permit badge colours (critical-skills, sponsor) are never used here (frame NS2 rule).
const VARIANT: Record<ButtonVariant, string> = {
  primary: "relative isolate bg-deep-green text-white hover:bg-hover-dark active:bg-pressed-dark",
  dark: "bg-ink text-white hover:bg-ink-hover active:bg-ink-pressed",
  sun: "bg-peach text-ink hover:bg-peach-hover active:bg-peach-pressed",
  outline: "border-[1.5px] border-ink bg-transparent text-ink hover:bg-hover-light active:bg-lilac-soft",
  danger: "border-[1.5px] border-error bg-transparent text-error hover:bg-error-hover active:bg-error-pressed",
  chip: "border border-line bg-hover-light text-ink hover:border-line-strong active:bg-lilac-soft",
  active: "bg-ink text-white hover:bg-ink-hover active:bg-ink-pressed",
  "filter-on": "bg-lilac text-ink hover:bg-lilac-hover active:bg-lilac-pressed",
};
// lg 52 high, 15 semibold; md 42, 13.5 semibold; sm the chips' 34, 13.5 medium.
const SIZE: Record<ButtonSize, string> = { sm: "min-h-[34px] px-3.5 text-small font-medium", md: "min-h-[42px] px-5 text-small font-semibold", lg: "min-h-[52px] px-7 text-ui font-semibold" };
const CHIP = new Set<ButtonVariant>(["chip", "active", "filter-on"]);
const BASE = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill no-underline transition-[background-color,border-color,transform] duration-[120ms] ease-[cubic-bezier(.23,1,.32,1)]";
const OFF = "pointer-events-none bg-disabled text-disabled-ink border-0";
const OFF_OUTLINE = "pointer-events-none border-[1.5px] border-line bg-transparent text-disabled-ink";

type Own = { variant?: ButtonVariant; size?: ButtonSize };
type Props = Own & ({ href: string } & Omit<ComponentProps<"a">, "href"> | ({ href?: undefined } & ComponentProps<"button">));

/** A button, or a link that looks like one when `href` is given. A disabled link has no href and says so with aria-disabled. */
export function Button({ variant = "primary", size = CHIP.has(variant) ? "sm" : "md", className, ...rest }: Props) {
  // The travelling ring of the primary button (tokens.css [data-ring-btn]); decoration only.
  const ring = variant === "primary" ? <span aria-hidden="true" data-btn-ring /> : null;
  const classes = (off: boolean) => cx(BASE, SIZE[size], off ? (variant === "outline" || variant === "danger" ? OFF_OUTLINE : OFF) : VARIANT[variant], className);
  if (rest.href !== undefined) {
    const { href, ...a } = rest as ComponentProps<"a"> & { href: string };
    const off = a["aria-disabled"] === true || a["aria-disabled"] === "true";
    // An external link gets rel="noopener noreferrer" by default (target _blank always).
    const rel = a.target === "_blank" ? "noopener noreferrer" : a.rel;
    return off ? <a {...a} className={classes(true)} tabIndex={-1} /> : <A {...a} data-press href={href} rel={rel} className={classes(false)}>{ring}{a.children}</A>;
  }
  const b = rest as ComponentProps<"button">;
  return <button type="button" data-press {...b} className={classes(!!b.disabled)}>{!b.disabled && ring}{b.children}</button>;
}
