import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { securityHeaders } from "../../security-headers";

const config: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../../"),
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  headers: securityHeaders(),
};

// Source maps upload only when SENTRY_AUTH_TOKEN is set (build time only); a build without it passes and uploads nothing. The release is the deployed
// commit (APP_VERSION, given to the build by deploy.yml), the same as the server's; unset, the plugin falls back to its own detection.
export default withSentryConfig(config, {
  org: "dublin4ir",
  project: "irish-job-portal-portal",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: { name: process.env.APP_VERSION },
  telemetry: false,
  silent: true,
});
