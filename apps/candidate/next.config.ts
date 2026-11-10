import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaders } from "../../security-headers";

const config: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../../"),
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  headers: securityHeaders(),
};

export default config;
