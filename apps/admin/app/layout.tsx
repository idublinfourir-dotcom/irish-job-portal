import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DM_Sans, Outfit } from "next/font/google";
import { AdminShell } from "@portal/ui";
import "./globals.css";

// The two fonts, as the CSS variables packages/ui/src/tokens.css uses.
const outfit = Outfit({ subsets: ["latin"], weight: "600", variable: "--font-outfit", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${dmSans.variable}`}>
      <body>
        {/* ponytail: no roles until the admin pages read the signed-in staff member; only the links every staff member may open show */}
        <AdminShell roles={[]} name="Staff">
          {children}
        </AdminShell>
      </body>
    </html>
  );
}
