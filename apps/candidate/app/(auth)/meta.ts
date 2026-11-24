// The title and description of the five sign-in pages (frame 01's SEO spec: title 60 or fewer plus the site name, description 120 to 160 characters). All are
// noindex whatever the site's indexing switch says: a sign-in page is not a search result.
import type { Metadata } from "next";
import { pageDescription, pageTitle } from "../../lib/seo";

export const authMeta = (title: string, description: string, extra: Metadata = {}): Metadata => ({ title: pageTitle(title), description: pageDescription(description), robots: { index: false, follow: false }, ...extra });

export const SIGNUP_META = ["Create your free account", "Create a free account to see every job, save jobs, set alerts and track your applications. Jobs here are for people who need an Irish employment permit."] as const;
export const LOGIN_META = ["Sign in", "Sign in to see every job, your saved jobs, your alerts and your applications tracker, and to follow your permit requests with our team in Ireland."] as const;
export const VERIFY_META = ["Verify your email", "Check your email for the link that verifies your address and finishes sign-up. You can ask for a new link here, or change an address you typed wrongly."] as const;
export const RESET_META = ["Reset your password", "Ask for a link to choose a new password, or choose one with the link we emailed you. A new password ends every other sign-in of your account on this site."] as const;
