export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// The brand name. One constant for the three apps; packages/auth/src/email-layout.ts holds the same value (brand.test.ts keeps them equal).
export const SITE_NAME = "irishworkpermit.ie";
