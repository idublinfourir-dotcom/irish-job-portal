// BA22 (frames C21 and E18's "ask us to fix it"): the employer help page. The topics link to the pages that answer them; the contact form is the way to reach staff. No FAQ text is invented here:
// the questions and answers for candidates live on the candidate site's help page.
import { A, Icon, type IconName } from "@portal/ui";
import { ContactForm } from "./forms";

const TOPICS: { icon: IconName; title: string; text: string; href: string }[] = [
  { icon: "user", title: "Your account", text: "Email, sign-out, your data, delete", href: "/settings" },
  { icon: "shield", title: "Verification", text: "Where the review of your company stands", href: "/verification" },
  { icon: "flag", title: "Account status", text: "Strikes, cases and appeals", href: "/account-status" },
  { icon: "users", title: "Your team", text: "Invite people, roles, ownership", href: "/team" },
];

export function HelpView({ signedIn, member, topic, candidateHelp, signIn }: { signedIn: boolean; member: boolean; topic: string; candidateHelp: string | null; signIn: string }) {
  return (
    <div className="flex flex-col gap-8">
      <header className="rounded-bento bg-ink p-8 text-white sm:p-12">
        <h1 className="text-white">How can we <span className="text-mint-on-dark">help</span>?</h1>
        <p className="mt-2 max-w-xl text-white/80">Find the page that answers it, or write to our team.</p>
      </header>
      {member && (
        <ul aria-label="Topics" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TOPICS.map((t) => (
            <li key={t.href}>
              <A href={t.href} className="flex h-full flex-col gap-3 rounded-bento bg-sand p-6 hover:bg-hover-light">
                <span aria-hidden="true" className="grid size-11 place-items-center rounded-pill bg-white text-deep-green"><Icon name={t.icon} size={20} /></span>
                <span className="font-semibold">{t.title}</span>
                <span className="text-small text-muted">{t.text}</span>
              </A>
            </li>
          ))}
        </ul>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section id="contact" aria-labelledby="contact-h" className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
          <h2 id="contact-h" className="text-[22px]">Contact us</h2>
          <ContactForm signedIn={signedIn} topic={topic} />
        </section>
        <aside aria-label="More" className="flex flex-col gap-4">
          {!signedIn && <div className="rounded-bento bg-sand p-6"><p className="font-semibold">Have a login?</p><p className="mt-1 text-small text-muted">Sign in to ask about your account, your data or your company.</p><A href={signIn} className="mt-2 inline-flex min-h-11 items-center font-semibold text-deep-green underline-offset-2 hover:underline">Sign in</A></div>}
          {candidateHelp && <div className="rounded-bento bg-sand p-6"><p className="font-semibold">Looking for work?</p><p className="mt-1 text-small text-muted">Help for candidates is on the candidate site.</p><A href={candidateHelp} className="mt-2 inline-flex min-h-11 items-center font-semibold text-deep-green underline-offset-2 hover:underline">Open candidate help</A></div>}
        </aside>
      </div>
    </div>
  );
}
