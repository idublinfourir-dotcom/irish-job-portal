// One-off command (S-Q5 A): puts the PLACEHOLDER wording a requester agrees to for a permit services request and for letting our team contact
// the employer's HR (S-Q2 A) in the database, so requests work before the real wording exists. Like posting-texts-cli.ts: these purposes need no
// two-person approval (only sign-up and privacy texts do, migration 0012), so app_admin inserts them. Run once on live from the repo root:
//   DATABASE_URL=... node packages/db/src/services-texts-cli.ts
// Safe to run twice: a purpose that already has any text is left alone. One transaction: all or nothing.
import type pg from "pg";
import { runSeed, saveTexts } from "./posting-texts-cli.ts";

export const SERVICES_TEXT_VERSION = "placeholder-2026-11-20";
export const SERVICES_TEXTS = {
  services_request: "PLACEHOLDER TEXT. The permit services request wording is not written yet; this text stands in for it until the real wording replaces it. Do not rely on it.",
  employer_contact: "PLACEHOLDER TEXT. The wording for letting our team contact the employer about this job is not written yet; this text stands in for it until the real wording replaces it. Do not rely on it.",
} as const;

export const saveServicesTexts = (client: pg.ClientBase) => saveTexts(client, SERVICES_TEXTS, SERVICES_TEXT_VERSION);
export const main = (argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void) => runSeed("services-texts-cli.ts", saveServicesTexts, SERVICES_TEXT_VERSION, argv, env, log);

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, console.log);
