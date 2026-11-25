// Frame NE1: the employer landing a visitor sees at "/". Plain server markup, no data: the figures and sector tiles of the frame are dropped (decision #287, Q93: no stored
// DETE figures), the photo is a neutral block (frame NS6), and the claim search is the signed-in one (decision #287: account first, then the company), so the claim section explains it.
import { A, Button, Icon, SponsorBadge, Wordmark, type IconName } from "@portal/ui";
import { PublicHeader } from "../_site/chrome";

const SIGN_UP = "/sign-up";
const kinds = (kind: "employer" | "agency") => `/sign-up/account?kind=${kind}`;

const PATHS: { title: string; text: string; pill: string; icon: IconName; href: string; tone: string; pillTone: string }[] = [
  { title: "Already sponsored a permit", text: "Claim your company from the DETE records and confirm your work email.", pill: "Can go live at once with a company email", icon: "building", href: kinds("employer"), tone: "bg-ink text-white", pillTone: "bg-lilac text-ink" },
  { title: "First-time sponsor", text: "Enter your CRO number and your work email. Your jobs carry the \"First-time sponsor\" label.", pill: "We aim to review within 1 working day", icon: "plus", href: kinds("employer"), tone: "bg-peach text-ink", pillTone: "bg-white/60 text-ink" },
  { title: "Recruitment agency", text: "Enter your Employment Agency licence number. We will check it.", pill: "We aim to review within 1 working day", icon: "users", href: kinds("agency"), tone: "bg-lilac text-ink", pillTone: "bg-white text-ink" },
];

const STEPS: [string, string][] = [
  ["Create your login", "Your name, work email and a password. We send a link to confirm the address."],
  ["Find your company", "Search the permit records by name or CRO number and claim it. Not in them? Register as a first-time sponsor."],
  ["Go live", "With an email on your company's own domain, an existing sponsor can go live at once. Otherwise we aim to review within 1 working day."],
];

const FEATURES: { title: string; text: string; icon: IconName }[] = [
  { title: "Live rule checks", text: "Pay and eligibility are checked before a job goes live.", icon: "shield" },
  { title: "Job stats", text: "Views and apply clicks for each job.", icon: "pulse" },
  { title: "Permit services", text: "Our team handles the permit application after a hire.", icon: "file" },
];

const mark = "inline-block rounded-2xl px-4 pb-2 pt-1 sm:px-6 lg:whitespace-nowrap"; // the candidate home page's hero shape
const hl = "inline-block rounded-[0.28em] px-[0.22em] pb-[0.08em]"; // and its section-title shape

export function Landing({ candidates, rules, help }: { candidates: string | null; rules: string | null; help: string | null }) {
  return (
    <>
      <A href="#content" className="sr-only focus:not-sr-only focus:p-3">Skip to content</A>
      <PublicHeader candidates={candidates} />
      <div id="content" className="flex flex-col gap-16 pb-8 pt-8 lg:gap-24 lg:pt-12">
        <section aria-labelledby="hero" className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-10">
          <div className="flex flex-col gap-6">
            <h1 id="hero" className="font-heading text-[40px] font-semibold leading-[1.2] tracking-tight sm:text-[52px] lg:text-[48px] xl:text-[64px]">
              <span className="inline-flex items-center gap-3">Hire people <span aria-hidden="true" className="grid size-9 place-items-center rounded-pill bg-deep-green text-white lg:size-12"><Icon name="arrow" size={22} className="-rotate-45" /></span></span>
              <br />
              <span className={`${mark} my-1 bg-deep-green text-white`}>who need a permit</span>
              <br />
              <span className={`${mark} my-1 bg-peach`}>without the guesswork</span>
            </h1>
            <p className="max-w-xl text-lead text-muted">Post sponsored jobs for free. Confirm sponsorship once, reach candidates who qualify, and let our team handle the permit after a hire.</p>
            <div className="flex flex-wrap gap-3">
              <Button href={kinds("employer")} variant="dark" size="lg">I&apos;m an employer</Button>
              <Button href={kinds("agency")} variant="outline" size="lg">I&apos;m a recruitment agency</Button>
            </div>
            <ul className="flex flex-wrap gap-2">
              {["Free to post", "Renew in one click", "Live rule checks"].map((t) => <li key={t} className="rounded-pill border border-line bg-sand px-3.5 py-1.5 text-small font-medium">{t}</li>)}
            </ul>
          </div>
          <div aria-hidden="true" className="relative min-h-[300px] rounded-bento bg-lilac lg:min-h-[400px]" data-photo-block>
            <div className="absolute -top-3 right-4 flex max-w-[15rem] items-start gap-3 rounded-card bg-white p-4 shadow-pop sm:right-6">
              <Icon name="shield" className="mt-0.5 shrink-0 text-deep-green" />
              <p className="text-small"><strong className="block">Live rule checks</strong>Pay and eligibility are checked before a job goes live.</p>
            </div>
            <div className="absolute -bottom-4 left-4 flex flex-col gap-2 rounded-card bg-white p-4 shadow-pop sm:left-6">
              <SponsorBadge />
              <p className="text-small text-muted">A named person signs it.</p>
            </div>
          </div>
        </section>

        <section id="paths" aria-labelledby="paths-h" className="flex scroll-mt-6 flex-col gap-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 id="paths-h" className="font-heading text-[32px] font-semibold leading-tight lg:text-[44px]">
              Verified <span className={`${hl} bg-lilac`}>once</span><br />then post in <span className={`${hl} bg-deep-green text-white`}>minutes</span>
            </h2>
            <p className="max-w-xs text-small text-muted">Three sign-up paths. Your permit history decides which one you take.</p>
          </div>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-3">
            {PATHS.map((p) => (
              <li key={p.title} className={`relative flex min-h-[290px] flex-col justify-end gap-3 rounded-bento p-7 ${p.tone}`}>
                <span aria-hidden="true" className="mb-auto grid size-11 place-items-center rounded-pill bg-white text-ink"><Icon name={p.icon} size={20} /></span>
                <h3><A href={p.href} className="underline-offset-4 after:absolute after:inset-0 hover:underline">{p.title}</A></h3>
                <p className="text-small opacity-80">{p.text}</p>
                <span className={`w-fit rounded-pill px-3 py-1.5 text-small font-medium ${p.pillTone}`}>{p.pill}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="claim" aria-labelledby="claim-h" className="grid scroll-mt-6 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,472px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-5 rounded-bento bg-ink p-8 text-white lg:p-10">
            <h2 id="claim-h" className="font-heading text-[36px] font-semibold leading-tight lg:text-[44px]">Claim your <span className={`${hl} bg-deep-green`}>company</span></h2>
            <p className="text-white/75">Search the DETE permit records. If your company has sponsored a permit since 2019, it is in them.</p>
            <ol className="flex flex-col gap-3">
              {["Account type", "Your account", "Company", "Live"].map((s, i) => (
                <li key={s} className="flex items-center gap-3 font-medium"><span aria-hidden="true" className="grid size-10 place-items-center rounded-pill bg-ink-hover text-small font-semibold">{i + 1}</span>{s}</li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col justify-between gap-6 rounded-bento bg-sand p-8 lg:p-10">
            <ol className="flex flex-col gap-5">
              {STEPS.map(([t, d], i) => (
                <li key={t} className="flex gap-4">
                  <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-pill bg-deep-green text-small font-semibold text-white">{i + 1}</span>
                  <p><strong className="block text-lead">{t}</strong><span className="text-muted">{d}</span></p>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-4">
              <Button href={kinds("employer")} size="lg">Create employer account <Icon name="arrow" size={16} /></Button>
              <p className="text-small text-muted">Banned CRO numbers and domains cannot sign up again.</p>
            </div>
          </div>
        </section>

        <section aria-label="What you get" className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex flex-col gap-3 rounded-bento bg-sand p-7">
              <span aria-hidden="true" className="grid size-11 place-items-center rounded-pill bg-green-tint text-deep-green"><Icon name={f.icon} size={20} /></span>
              <h3 className="text-xl">{f.title}</h3>
              <p className="text-small text-muted">{f.text}</p>
            </div>
          ))}
        </section>

        <section aria-label="The rules" className="flex flex-wrap items-center gap-4 rounded-bento bg-ink p-5 pr-6 text-white">
          <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-pill bg-deep-green"><Icon name="warning" size={20} /></span>
          <p className="min-w-0 flex-1 font-semibold">Asking candidates for money is an instant ban. False sponsorship claims follow three strikes.</p>
          {rules && <Button href={rules} variant="outline" className="border-white text-white hover:bg-ink-hover">Read the rules</Button>}
        </section>
      </div>

      <section data-join aria-labelledby="join-h" className="relative left-1/2 -mb-4 w-screen -translate-x-1/2 rounded-t-[2.5rem] bg-ink text-white md:-mb-8">
       <div className="mx-auto max-w-page px-5 pt-14 sm:px-8 lg:pt-20">
        <div className="flex flex-wrap items-center justify-between gap-8">
          <h2 id="join-h" className="font-heading text-[40px] font-semibold leading-[1.45] tracking-tight lg:text-[56px]">
            Create a <span className={`${hl} bg-deep-green`}>free</span> account<br />and post <span className={`${hl} bg-peach text-ink`}>your first job</span>
          </h2>
          <Button href={SIGN_UP} size="lg">Create free account <Icon name="arrow" size={16} /></Button>
        </div>
        <footer className="mt-14 grid gap-10 border-t border-white/15 py-10 text-white/75 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-3">
            <Wordmark dark />
            <p className="max-w-xs text-small">Jobs in Ireland where an employment permit is realistic. Free for candidates and employers.</p>
            <p className="max-w-xs text-small text-peach">No genuine employer asks a candidate to pay for a job offer.</p>
          </div>
          <FooterGroup title="Employers" links={[["Sign in", "/sign-in"], ["Create account", SIGN_UP], ["Claim your company", "/#claim"]]} />
          <FooterGroup title="Candidates" links={candidates ? [["For candidates", candidates]] : []} />
          <FooterGroup title="Irish Work Permit" links={[["Terms", "/terms"], ["Privacy", "/privacy"], ...(help ? [["Help", help] as [string, string]] : [])]} />
        </footer>
       </div>
      </section>
    </>
  );
}

function FooterGroup({ title, links }: { title: string; links: [string, string][] }) {
  if (!links.length) return null;
  return (
    <nav aria-label={title}>
      <h2 className="mb-2 text-base text-white">{title}</h2>
      <ul className="flex flex-col">
        {links.map(([label, href]) => <li key={href}><A href={href} className="inline-flex min-h-9 items-center text-small underline-offset-2 hover:text-white hover:underline">{label}</A></li>)}
      </ul>
    </nav>
  );
}
