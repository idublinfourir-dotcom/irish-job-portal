import * as Sentry from "@sentry/nextjs";

// No route runs on the edge runtime, so there is no edge config. Add sentry.edge.config.ts when one does.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
}

export const onRequestError = Sentry.captureRequestError;
