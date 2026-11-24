import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DM_Sans, Outfit } from "next/font/google";
import { CandidateShell, SITE_NAME } from "@portal/ui";
import { readSiteFrame, siteOrigin } from "../lib/data";
import { jsonLd, organizationLd, siteRobots, websiteLd } from "../lib/seo";
import "./globals.css";

// The two fonts, as the CSS variables packages/ui/src/tokens.css uses.
const outfit = Outfit({ subsets: ["latin"], weight: "600", variable: "--font-outfit", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-dm-sans", display: "swap" });

// Site-wide default: noindex until SITE_INDEXABLE=1 (lib/seo.ts); a page's generateMetadata (pageMetadata) overrides title, description and robots.
// metadataBase makes the address of the share image (opengraph-image.png) a full one.
export const generateMetadata = (): Metadata => ({ title: SITE_NAME, robots: siteRobots(), metadataBase: (() => { try { return new URL(siteOrigin()); } catch { return null; } })() });

/** P1: the header knows whether a candidate is signed in, the footer carries the standing line with the rules date, both read through lib/data.ts. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { signedIn, standingLine, origin } = await readSiteFrame();
  return (
    <html lang="en" className={`${outfit.variable} ${dmSans.variable}`}>
      <body>
        {origin && (
          <>
            <script type="application/ld+json">{jsonLd(organizationLd(origin))}</script>
            <script type="application/ld+json">{jsonLd(websiteLd(origin))}</script>
          </>
        )}
        <CandidateShell signedIn={signedIn} standingLine={standingLine ?? undefined}>
          {children}
        </CandidateShell>
      </body>
    </html>
  );
}
