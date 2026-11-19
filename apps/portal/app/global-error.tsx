"use client";

// Reports a React render error that reached the root to Sentry (decision #267), as Sentry's Next.js guide gives it, and shows a plain page.
// Placeholder text until the design step; it shows nothing from the error.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <h1>Something went wrong</h1>
        <p>Please reload the page or try again later.</p>
      </body>
    </html>
  );
}
