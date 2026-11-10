import type { OccupationMatch } from "../types";

/** One line of an occupation list. The real lists come from the two DETE documents (decision #143 Q2). */
export type ListEntry = {
  id: string;
  /** Four digit occupation code. */
  code: string;
  title: string;
  list: "critical-skills" | "ineligible";
};

export type Prompt = { system: string; user: string };

/** Prompt in, the model's text out. Throws on any transport or HTTP failure. */
export type ModelClient = (prompt: Prompt) => Promise<string>;

export type AiOptions = {
  /** Code points kept of the description. 6,000 is the cut the Python uses when it reads a description (classify.py contract and doctor tests). */
  descriptionLimit?: number;
  /** Code points kept of the title. 300 is the chain's own title limit. */
  titleLimit?: number;
  /** One more request after a bad answer. Default true. */
  retry?: boolean;
};

export type AiFailure = { kind: "bad answer" | "model error"; why: string };

/** The match, plus what the fetcher stores beside it (decision #122). */
export type AiResult = {
  match: OccupationMatch;
  /** The supporting quote the model gave (null when there was no usable answer). */
  quote: string | null;
  modelId: string;
  /** Null when the answer was usable. */
  failure: AiFailure | null;
};
