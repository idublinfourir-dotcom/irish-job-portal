// Shared types of the fetcher. Design: step5/L8-DESIGN.md section 2.
import type pg from "pg";
import type { ChainData } from "@portal/rules";
import type { BoardFetch } from "@portal/sources";
import type { OccupationMatch } from "@portal/matcher";

export type Db = Pick<pg.Pool, "query" | "connect">; // connected as app_fetcher by the caller
export type MatchResult = {
  match: OccupationMatch;
  quote: string | null;
  modelId: string | null;
  failure: { kind: "bad answer" | "model error"; why: string } | null;
};
export type FetcherMatcher = (title: string, description: string) => Promise<MatchResult>;
export type BoardTask = {
  kind: string;
  board: string; // job_source (kind, board)
  fetch: (known: ReadonlySet<string>) => Promise<BoardFetch>; // the network `fetch` is already bound in by the caller
  close?: "missing" | { unseenDays: number }; // next cut. Default "missing"
};
export type Deps = {
  db: Db;
  now: () => Date;
  chain: Omit<ChainData, "matcher">;
  matcher: FetcherMatcher;
  boards: readonly BoardTask[];
  concurrency?: number; // boards at once, default 8
  deadline?: Date; // after it, no new advert is assessed
  log?: (line: string) => void;
};
export type BoardReport = {
  kind: string;
  board: string;
  ok: boolean;
  error: string | null;
  seen: number;
  passed: number;
  queued: number;
  rejected: number;
  closed: number;
  unsaved: string[]; // advert ids left for the next run: matcher failure, deadline, or a write that threw
};

export type AdvertRow = {
  externalId: string;
  url: string | null;
  title: string;
  employerName: string;
  result: "passed" | "queued" | "rejected";
  stage: string;
  reason: string | null;
  quotedEvidence: string | null;
  matcherModel: string | null;
};
export type JobRow = {
  title: string;
  employerName: string;
  county: string | null;
  sector: string;
  occupationCode: string | null;
  salaryLow: number | null;
  salaryHigh: number | null;
  passRoute: "stated_pay" | "big_company" | "public_pay" | null;
  status: "live" | "in_review";
  ownPageUrl: string;
};
export type Plan =
  | { action: "defer"; why: string }
  | { action: "reject"; advert: AdvertRow }
  | { action: "job"; advert: AdvertRow; job: JobRow; text: string };
