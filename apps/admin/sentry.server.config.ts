import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@portal/auth/sentry";

Sentry.init(sentryOptions(process.env.SENTRY_DSN, process.env));
