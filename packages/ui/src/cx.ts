export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// The brand name. One constant for the three apps; packages/auth/src/email-layout.ts holds the same value (brand.test.ts keeps them equal).
export const SITE_NAME = "Irish Work Permit";
/** The wordmark the header and footer draw (frame N01): the domain form of the name. */
export const SITE_WORDMARK = "IrishWorkPermit.ie";
