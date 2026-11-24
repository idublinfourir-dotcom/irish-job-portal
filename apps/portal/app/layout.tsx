import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DM_Sans, Outfit } from "next/font/google";
import { PortalShell, SITE_NAME, type PortalRole } from "@portal/ui";
import { readShell } from "../lib/data";
import "./globals.css";

// The two fonts, as the CSS variables packages/ui/src/tokens.css uses.
const outfit = Outfit({ subsets: ["latin"], weight: "600", variable: "--font-outfit", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
  title: `${SITE_NAME} for employers`,
  robots: { index: false, follow: false },
};

const ROLE_LABEL: Record<PortalRole, string> = { viewer: "Viewer", poster: "Poster", recruiter: "Recruiter", account_owner: "Account owner" };
const isRole = (r: string): r is PortalRole => r in ROLE_LABEL;

/**
 * P3: a signed-in company member gets the sidebar with the company's name, their role and only the links the role can use. A visitor, or a login with no
 * company yet (the sign-up and sign-in pages share this layout), gets the bare page; a page that needs a login calls requireLogin() in lib/data.ts,
 * which sends a signed-out visitor to the sign-in page.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const shell = await readShell();
  return (
    <html lang="en" className={`${outfit.variable} ${dmSans.variable}`}>
      <body>
        {shell && isRole(shell.role) ? (
          <PortalShell companyName={shell.companyName} role={ROLE_LABEL[shell.role]} roleKey={shell.role}>
            {children}
          </PortalShell>
        ) : (
          <main id="main" className="mx-auto min-h-screen max-w-page p-4 md:p-8">
            {children}
          </main>
        )}
      </body>
    </html>
  );
}
