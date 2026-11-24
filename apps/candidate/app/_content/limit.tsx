// The visitor limit inside a list of jobs (decision #85, BA52): blurred empty rows, then the dark box. The rows hold no real job, only shapes.
import { Button, Icon } from "@portal/ui";
import { loginHref } from "../jobs/format";

const ROW = "flex h-28 items-center gap-4 rounded-bento bg-sand p-5";

export function SignInMore({ shown, count, path }: { shown: number; count: { n: number; more: boolean } | null; path: string }) {
  const hidden = Math.min(2, Math.max(0, (count?.n ?? shown + 2) - shown)) || 2;
  return (
    <div data-sign-in-for-more className="flex flex-col">
      <ul aria-hidden="true" className="flex flex-col gap-3 opacity-60 blur-[5px]">
        {Array.from({ length: hidden }, (_, i) => (
          <li key={i} data-placeholder className={ROW}>
            <span className="size-12 shrink-0 rounded-pill bg-white" />
            <span className="flex flex-1 flex-col gap-2"><span className="h-5 w-1/2 rounded-pill bg-ink/15" /><span className="h-4 w-1/3 rounded-pill bg-ink/10" /></span>
            <span className="hidden h-6 w-24 rounded-pill bg-ink/15 sm:block" />
          </li>
        ))}
      </ul>
      <section aria-labelledby="more" className="relative z-[1] -mt-16 flex flex-col gap-4 rounded-bento bg-ink p-5 text-white shadow-pop sm:mx-5 sm:p-6 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="hidden size-12 shrink-0 place-items-center rounded-pill bg-deep-green sm:grid"><Icon name="lock" size={20} /></span>
          <div>
            <h2 id="more" className="text-[18px] leading-snug text-white">Want to see more jobs? Sign in or create a free account.</h2>
            <p className="text-small text-white/75">You can see {shown}{count ? ` of ${count.more ? `${count.n}+` : count.n}` : ""}. Free for candidates.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button href={loginHref(path)} variant="outline" size="lg" className="border-white text-white hover:bg-white/10 active:bg-white/20">Sign in</Button>
          <Button href="/signup" size="lg">Create free account</Button>
        </div>
      </section>
    </div>
  );
}
