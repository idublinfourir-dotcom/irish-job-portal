import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { securityHeaders } from "../../security-headers";

const config: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../../"),
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  headers: securityHeaders([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]),
};

// Source maps upload only when SENTRY_AUTH_TOKEN is set (build time only); a build without it passes and uploads nothing.
export default withSentryConfig(config, {
  org: "dublin4ir",
  project: "irish-job-portal-admin",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  telemetry: false,
  silent: true,
});
