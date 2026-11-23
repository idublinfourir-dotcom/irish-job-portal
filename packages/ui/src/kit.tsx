import type { ReactNode } from "react";
import { Button, BUTTON_VARIANTS } from "./button";
import { CookieBanner } from "./candidate-shell";
import { CriticalSkillsBadge, Card, EmptyState, JobCard, Notice, Pill, Skeleton, SponsorBadge, type NoticeKind } from "./display";
import { Checkbox, Input, Radio, Select, Textarea, Toggle } from "./fields";
import { ICON_NAMES, Icon } from "./icons";
import { KitDialog } from "./kit-dialog";
import { Breadcrumb, Pager, Tabs } from "./nav";

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-3">
    <h2 className="text-2xl">{title}</h2>
    {children}
  </section>
);

/** Every component and state on one page, for looking at in a browser. Each app shows it at /kit, and not in production. */
export function Kit() {
  return (
    <div className="mx-auto max-w-page space-y-10 px-4 py-8">
      <h1 className="text-3xl">Component kit</h1>
      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          {BUTTON_VARIANTS.map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button disabled>Disabled</Button>
          <Button href="/kit">As a link</Button>
          <Button href="https://www.geonames.org/" target="_blank">External link</Button>
          <Button aria-disabled="true" href="/kit">Disabled link</Button>
        </div>
      </Section>
      <Section title="Pills and permit badges">
        <div className="flex flex-wrap gap-2">
          <Pill>Neutral</Pill>
          <Pill tone="green">Green</Pill>
          <Pill tone="peach">Peach</Pill>
          <Pill tone="outline">Outline</Pill>
          <CriticalSkillsBadge />
          <SponsorBadge />
        </div>
      </Section>
      <Section title="Cards">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <p>A plain card.</p>
          </Card>
          <JobCard title="Staff Nurse" href="/kit" employer="Harbourline Hospital" place="Cork" salary="€42,000 a year" badges={<CriticalSkillsBadge />} saved={false} />
          <JobCard title="Sous Chef" employer="Quayside Hotel" place="Galway" salary="€38,500 a year" badges={<SponsorBadge />} saved />
        </div>
      </Section>
      <Section title="Form controls">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Default" placeholder="Job title" help="Help text is linked to the field." />
          <Input label="Passed check" defaultValue="Registered nurse" status="passed" note="On the Critical Skills list" />
          <Input label="Blocked" defaultValue="€ 36,000" status="blocked" note="Below the minimum" />
          <Input label="Error" defaultValue="abc" error="Enter a number" />
          <Input label="Disabled" disabled defaultValue="Locked" />
          <Select label="Select" defaultValue="cork">
            <option value="cork">Cork</option>
            <option value="dublin">Dublin</option>
          </Select>
          <Textarea label="Textarea" help="Up to 500 characters." />
          <div>
            <Checkbox label="Checkbox" defaultChecked />
            <Checkbox label="Checkbox with error" error="Tick to continue" />
            <Radio label="Radio one" name="kit-r" defaultChecked />
            <Radio label="Radio two" name="kit-r" />
            <Toggle label="Toggle on" defaultChecked />
            <Toggle label="Toggle off" help="Email me new jobs." />
          </div>
        </div>
        <p className="text-small text-muted">Press Tab to see the focus ring on every control.</p>
      </Section>
      <Section title="Navigation">
        <Tabs label="Kit tabs" items={[{ label: "Jobs", active: true }, { label: "Applicants" }, { label: "Team" }]} />
        <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Companies", href: "/kit" }, { label: "Harbourline Hotels" }]} />
        <Pager prevHref="/kit" nextHref="/kit" />
        <Pager nextHref="/kit" />
      </Section>
      <Section title="Notices">
        <div className="grid gap-3">
          {(["info", "success", "warning", "error", "closed"] as NoticeKind[]).map((k) => (
            <Notice key={k} kind={k} title={`${k[0]!.toUpperCase()}${k.slice(1)}`}>
              Placeholder text for this notice.
            </Notice>
          ))}
        </div>
      </Section>
      <Section title="Empty state, skeleton, dialog">
        <EmptyState title="No jobs match" action={<Button variant="outline">Clear filters</Button>}>
          Try fewer filters.
        </EmptyState>
        <div className="space-y-2">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton />
          <Skeleton className="h-4 w-3/4" />
        </div>
        <KitDialog />
      </Section>
      <Section title="Icons">
        <ul className="flex flex-wrap gap-4">
          {ICON_NAMES.map((n) => (
            <li key={n} className="flex w-20 flex-col items-center gap-1 text-small">
              <Icon name={n} size={28} />
              {n}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Cookie banner (not mounted on the site while K11 is open)">
        <div className="relative h-48 overflow-hidden rounded-card border border-line [&>section]:absolute">
          <CookieBanner />
        </div>
      </Section>
    </div>
  );
}
