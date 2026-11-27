import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DM_Sans, Outfit } from "next/font/google";
import { CandidateShell, Motion, PreCover, SITE_NAME } from "@portal/ui";
import { readSiteFrame, siteOrigin } from "../lib/data";
import { HINT_SCRIPT } from "../lib/hint";
import { jsonLd, organizationLd, siteRobots, websiteLd } from "../lib/seo";
import "./globals.css";

// The two fonts, as the CSS variables packages/ui/src/tokens.css uses.
const outfit = Outfit({ subsets: ["latin"], weight: "600", variable: "--font-outfit", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-dm-sans", display: "swap" });

// Site-wide default: noindex until SITE_INDEXABLE=1 (lib/seo.ts); a page's generateMetadata (pageMetadata) overrides title, description and robots.
// metadataBase makes the address of the share image (opengraph-image.png) a full one.
export const generateMetadata = (): Metadata => ({ title: SITE_NAME, robots: siteRobots(), metadataBase: (() => { try { return new URL(siteOrigin()); } catch { return null; } })() });

/** P1: the footer carries the standing line with the rules date, read through lib/data.ts. Stage 3 step 4: the header shows both variants and the hint
 *  cookie picks one (HINT_SCRIPT, first in <body>), so the frame reads nothing of the visitor and a page can be cached. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { standingLine, origin } = await readSiteFrame();
  return (
    <html lang="en" suppressHydrationWarning className={`${outfit.variable} ${dmSans.variable}`}>
      <body>
        <script>{HINT_SCRIPT}</script>
        <PreCover />
        {origin && (
          <>
            <script type="application/ld+json">{jsonLd(organizationLd(origin))}</script>
            <script type="application/ld+json">{jsonLd(websiteLd(origin))}</script>
          </>
        )}
        <CandidateShell standingLine={standingLine ?? undefined}>
          {children}
        </CandidateShell>
        <Motion />
      </body>
    </html>
  );
}
