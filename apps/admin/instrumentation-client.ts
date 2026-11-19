// Sentry in the browser (decision #267). Only NEXT_PUBLIC_ values reach the browser: the DSN, and the environment Vercel exposes itself.
// The release comes from the build. Never put SENTRY_AUTH_TOKEN or any other Sentry value here.
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@portal/auth/sentry";

Sentry.init(sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, { VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV }));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
