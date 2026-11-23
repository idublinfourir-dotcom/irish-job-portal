import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DM_Sans, Outfit } from "next/font/google";
import { CandidateShell } from "@portal/ui";
import "./globals.css";

// The two fonts, as the CSS variables packages/ui/src/tokens.css uses.
const outfit = Outfit({ subsets: ["latin"], weight: "600", variable: "--font-outfit", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Candidate site",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${dmSans.variable}`}>
      <body>
        <CandidateShell>{children}</CandidateShell>
      </body>
    </html>
  );
}
