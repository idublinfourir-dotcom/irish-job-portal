"use client";

// Frame C28, the "Something went wrong" state. A render error inside the site frame: report it (decision #267), show nothing from the error.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button } from "@portal/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <div className="px-5 pt-6 sm:px-8 sm:pt-10">
      <section className="mx-auto flex max-w-[75rem] flex-col items-center rounded-[2.5rem] bg-ink px-6 py-16 text-center text-white sm:py-24">
        <h1 className="text-4xl text-white sm:text-5xl">
          Something <span className="text-deep-green">went wrong</span>
        </h1>
        <p className="mt-4 max-w-md text-white/75">We could not load this page. Try again.</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button variant="sun" size="lg" onClick={reset}>Try again</Button>
          <Button href="/" size="lg" className="bg-transparent text-white hover:bg-ink-hover">Go to the home page</Button>
        </div>
      </section>
    </div>
  );
}
