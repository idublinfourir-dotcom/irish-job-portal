// Shared types for source adapters. Python: prototype/step0/run_day.py.
import type { CallerOptions } from "./ats/shared";

// The fetch function an adapter receives. Tests pass a fake, so no adapter touches the network itself.
export type Fetch = typeof globalThis.fetch;

// The normalised record every adapter returns (run_day.py:135-137, function `job`).
export type RawAdvert = {
  /** `id`: `${source}:${board}:${externalId}` */
  id: string;
  /** `source`: the kind of board, e.g. "greenhouse", "workday" */
  source: string;
  /** `board`: the company slug or tenant */
  board: string;
  /** `employer` (not stripped by Python, may be empty) */
  employer: string;
  /** `title` (stripped by Python) */
  title: string;
  /** `location` ("" when missing) */
  location: string;
  /** `description`: plain text, HTML already removed ("" when missing) */
  description: string;
  /** `url` ("" when missing) */
  url: string;
  /** `employment_type` ("" when missing) */
  employmentType: string;
  /** `salary_box` ("" when missing) */
  salaryBox: string;
};

// "The fetch failed" (network error, HTTP error, bad shape, HTTP 429). run_day.py:341-347 treats it
// differently from "the board is empty": an adapter returns [] for an empty board and throws this for a failure.
export class FetchFailedError extends Error {
  constructor(
    public readonly board: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FetchFailedError";
  }
}

// What one fetch of one board gives (run_day.py:146): every id seen, and full records for the ids not already known.
// `seen` matters as much as `adverts`: a job is closed later only if its id is missing from a fetch that worked.
export type BoardFetch = { seen: string[]; adverts: RawAdvert[] };

// One function per source kind (run_day.py:147-282). `Board` is that source's own way to name a board: a slug and
// employer name for most, employer, tenant, wd and site for Workday. An id in `known` skips its detail request.
// Resolves with empty lists for an empty board; rejects with FetchFailedError on failure. `opts`: the sleep and the run's wait budget (shared.ts PACE).
export type SourceAdapter<Board> = (board: Board, known: ReadonlySet<string>, fetch: Fetch, opts?: Omit<CallerOptions, "gapMs" | "text">) => Promise<BoardFetch>;
