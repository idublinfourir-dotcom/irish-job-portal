import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DM_Sans, Outfit } from "next/font/google";
import { ADMIN_ROLES, AdminShell, Motion, SITE_NAME, type AdminRole } from "@portal/ui";
import { readSidebar } from "../lib/data";
import "./globals.css";

// The two fonts, as the CSS variables packages/ui/src/tokens.css uses.
const outfit = Outfit({ subsets: ["latin"], weight: "600", variable: "--font-outfit", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
  title: `${SITE_NAME} admin`,
  robots: { index: false, follow: false },
};

const isRole = (r: string): r is AdminRole => (ADMIN_ROLES as readonly string[]).includes(r);

/**
 * P4: a signed-in staff member gets the sidebar with their name, their roles, their queue counts and only the links their roles may open. A visitor gets the
 * bare page (the staff sign-in and reset pages share this layout). The sidebar's search box is a plain GET form to /search (the page and its read come with B58).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const me = await readSidebar();
  return (
    <html lang="en" className={`${outfit.variable} ${dmSans.variable}`}>
      <body>
        {me ? (
          <AdminShell roles={me.roles.filter(isRole)} name={me.name} counts={me.counts}>
            {children}
          </AdminShell>
        ) : (
          <main id="main" className="mx-auto min-h-screen max-w-page p-4 md:p-8">
            {children}
          </main>
        )}
        <Motion />
      </body>
    </html>
  );
}
