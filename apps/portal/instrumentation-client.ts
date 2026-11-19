// The browser part of Vercel BotID: every page runs it. A route missing from this list makes checkBotId() refuse it, so keep the list
// equal to the routes the server checks (packages/db/src/bot-check.ts, handleReport, and the contact route).
import { initBotId } from "botid/client/core";
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@portal/auth/sentry";

initBotId({
  protect: [
    "/api/auth/portal/sign-up/email", "/api/auth/portal/sign-in/email", "/api/auth/portal/request-password-reset",
    "/api/auth/portal/send-verification-email", "/api/portal/report", "/api/portal/contact",
  ].map((path) => ({ path, method: "POST" })),
});

// Sentry in the browser (decision #267). Only NEXT_PUBLIC_ values reach the browser: the DSN, and the environment Vercel exposes itself.
// The release comes from the build. Never put SENTRY_AUTH_TOKEN or any other Sentry value here.
Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, { VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV }));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
