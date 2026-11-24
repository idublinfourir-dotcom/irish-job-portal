import type { Metadata } from "next";
import { Button } from "@portal/ui";

// Frame C28. Reads nothing (no database): the 404 status and noindex come from Next for a not-found page.
export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <div className="px-5 pt-6 sm:px-8 sm:pt-10">
      <section className="mx-auto flex max-w-[75rem] flex-col items-center rounded-[2.5rem] bg-ink px-6 py-16 text-center text-white sm:py-24">
        <p aria-hidden className="font-heading text-[6rem] font-semibold leading-none text-deep-green sm:text-[7.8rem]">404</p>
        <h1 className="mt-4 text-4xl text-white sm:text-5xl">
          We can&apos;t find <span className="text-deep-green">that page</span>
        </h1>
        <p className="mt-4 max-w-md text-white/75">The link may be old, or the job may have closed. Closed jobs are removed from search within 24 hours.</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button href="/jobs" variant="sun" size="lg">Find jobs</Button>
          <Button href="/" size="lg" className="bg-transparent text-white hover:bg-ink-hover">Go to the home page</Button>
        </div>
      </section>
    </div>
  );
}
