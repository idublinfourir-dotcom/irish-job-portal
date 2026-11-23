import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DM_Sans, Outfit } from "next/font/google";
import { PortalShell } from "@portal/ui";
import "./globals.css";

// The two fonts, as the CSS variables packages/ui/src/tokens.css uses.
const outfit = Outfit({ subsets: ["latin"], weight: "600", variable: "--font-outfit", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Employer portal",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${dmSans.variable}`}>
      <body>
        {/* ponytail: placeholder company and role until the portal pages read the signed-in member */}
        <PortalShell companyName="Your company" role="Member">
          {children}
        </PortalShell>
      </body>
    </html>
  );
}
