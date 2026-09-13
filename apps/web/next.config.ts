import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@corridor/api",
    "@corridor/auth",
    "@corridor/db",
    "@corridor/domain",
    "@corridor/integrations",
    "@corridor/observability",
    "@corridor/pdf",
    "@corridor/ui",
  ],
  // react-pdf ships its own React reconciler; bundling it into the server
  // build breaks font/asset resolution, so it stays an external package.
  serverExternalPackages: ["postgres", "@react-pdf/renderer"],
  headers: () =>
    Promise.resolve([
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]),
};

export default withSentryConfig(nextConfig, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
