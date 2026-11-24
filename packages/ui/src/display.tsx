import { A } from "./link";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";

const TONES = { neutral: "bg-sand text-ink", green: "bg-green-tint text-ink", peach: "bg-peach text-ink", lilac: "bg-lilac text-ink", white: "bg-white text-ink", outline: "border border-line bg-white text-ink" } as const;
export type PillTone = keyof typeof TONES;

/** A pill holds the key word only (frame NS2 rule). */
export function Pill({ tone = "neutral", children, className }: { tone?: PillTone; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex min-h-[34px] items-center rounded-pill px-3.5 text-small font-medium", TONES[tone], className)}>{children}</span>;
}

// The two permit badges keep their own colours and icons and never reuse the theme mint (NS2).
export function CriticalSkillsBadge() {
  return (
    <span data-badge="critical-skills" className="inline-flex items-center gap-1.5 rounded-pill border-[1.5px] border-line-strong bg-critical-skills px-3 py-[5px] text-[13px] font-semibold text-critical-skills-ink">
      <Icon name="shield" size={15} />
      Critical Skills eligible
    </span>
  );
}
export function SponsorBadge() {
  return (
    <span data-badge="sponsor" className="inline-flex items-center gap-1.5 rounded-pill bg-sponsor px-3 py-1.5 text-[13px] font-semibold text-sponsor-ink">
      <Icon name="pen" size={15} />
      Sponsor confirmed
    </span>
  );
}

export function Card({ as: Tag = "div", className, ...rest }: { as?: "div" | "section" | "article" } & ComponentProps<"div">) {
  return <Tag {...rest} className={cx("rounded-card border border-line bg-white p-5 shadow-card", className)} />;
}

export type JobCardProps = {
  title: string;
  href?: string;
  employer: string;
  place: string;
  salary?: string;
  /** The permit badges, as given by the page. */
  badges?: ReactNode;
  /** Undefined hides the save button. */
  saved?: boolean;
  onSave?: () => void;
};

/** Layout only: every value is a prop. */
export function JobCard({ title, href, employer, place, salary, badges, saved, onSave }: JobCardProps) {
  return (
    <Card as="article" className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xl">{href ? <A href={href} className="underline-offset-2 hover:underline">{title}</A> : title}</h3>
        {saved !== undefined && (
          <button type="button" aria-pressed={saved} aria-label={saved ? `Saved: ${title}` : `Save ${title}`} onClick={onSave} className={cx("grid size-11 shrink-0 place-items-center rounded-control", saved ? "bg-green-tint text-deep-green" : "bg-sand text-ink hover:bg-hover-light")}>
            <Icon name="bookmark" className={saved ? "fill-current" : undefined} />
          </button>
        )}
      </div>
      <p className="text-muted">{employer}</p>
      <p className="flex items-center gap-1.5 text-small text-muted">
        <Icon name="pin" size={16} />
        {place}
      </p>
      {salary && <p className="font-semibold">{salary}</p>}
      {badges && <div className="flex flex-wrap gap-2">{badges}</div>}
    </Card>
  );
}

const NOTICE = {
  info: { box: "border-line bg-sand", icon: "flag", role: "status" },
  success: { box: "border-deep-green bg-green-tint", icon: "check", role: "status" },
  warning: { box: "border-ink bg-peach", icon: "clock", role: "alert" },
  error: { box: "border-error bg-error-tint", icon: "flag", role: "alert" },
  // #291: the permit pages show this when DETE's portal is closed; the page passes the text.
  closed: { box: "border-line bg-peach", icon: "clock", role: "status" },
} as const satisfies Record<string, { box: string; icon: IconName; role: string }>;
export type NoticeKind = keyof typeof NOTICE;

export function Notice({ kind = "info", title, children }: { kind?: NoticeKind; title?: string; children?: ReactNode }) {
  const n = NOTICE[kind];
  return (
    <div role={n.role} data-notice={kind} className={cx("flex gap-3 rounded-card border-2 p-4", n.box)}>
      <Icon name={n.icon} className="mt-0.5 shrink-0" />
      <div>
        {title && <p className="font-semibold">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon = "search", title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line px-6 py-12 text-center">
      <span className="grid size-14 place-items-center rounded-pill bg-green-tint text-deep-green">
        <Icon name={icon} size={28} />
      </span>
      <h2 className="text-xl">{title}</h2>
      {children && <p className="max-w-prose text-muted">{children}</p>}
      {action}
    </div>
  );
}

/** A grey placeholder block; decorative, so screen readers skip it. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" data-skeleton className={cx("animate-pulse rounded-control bg-sand", className ?? "h-4 w-full")} />;
}
