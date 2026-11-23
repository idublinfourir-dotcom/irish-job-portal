import type { ReactNode } from "react";

const P = (d: string) => <path d={d} />;

const PATHS = {
  check: P("M5 12.5l4.5 4.5L19 7.5"),
  arrow: P("M5 12h14M13 6l6 6-6 6"),
  shield: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  flag: P("M5 21V4M5 4h11l-2 4 2 4H5"),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  bookmark: P("M7 4h10v17l-5-4-5 4z"),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  right: P("M9 5l7 7-7 7"),
  left: P("M15 5l-7 7 7 7"),
  pin: (
    <>
      <path d="M12 21s-6-5.5-6-11a6 6 0 0112 0c0 5.5-6 11-6 11z" />
      <circle cx="12" cy="10" r="2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5h6v2M3 13h18" />
    </>
  ),
  bell: P("M6 16v-5a6 6 0 0112 0v5l2 2H4zM10 21h4"),
  pen: P("M4 20l1-4L16 5l3 3L8 19zM14 7l3 3"),
  menu: P("M4 7h16M4 12h16M4 17h16"),
  close: P("M6 6l12 12M18 6L6 18"),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Inline SVG icon. Decorative unless `title` is given. */
export function Icon({ name, size = 20, title, className }: { name: IconName; size?: number; title?: string; className?: string }) {
  return (
    <svg
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      {PATHS[name]}
    </svg>
  );
}
