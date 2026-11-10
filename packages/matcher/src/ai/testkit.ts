// Made-up lists and fake model clients for the tests. No real model, no network.
import type { ListEntry, ModelClient, Prompt } from "./types";

export const ENTRIES: ListEntry[] = [
  { id: "cs-1", code: "2134", title: "IT project manager", list: "critical-skills" },
  { id: "cs-2", code: "2135", title: "IT business analyst, architect", list: "critical-skills" },
  { id: "in-1", code: "5111", title: "Chef de partie", list: "ineligible" },
];

export const answer = (o: Partial<Record<"code" | "entry" | "confidence" | "quote", string>> = {}) =>
  JSON.stringify({ code: "2135", entry: "cs-2", confidence: "high", quote: "design cloud systems", ...o });

export const ADVERT = { title: "Cloud Solutions Architect", description: "We need a person to design cloud systems for our Dublin office." };

/** A fake client that records every prompt and answers from a function or a fixed text. */
export function fakeClient(reply: string | ((p: Prompt, n: number) => string | Promise<string>)): { client: ModelClient; prompts: Prompt[] } {
  const prompts: Prompt[] = [];
  const client: ModelClient = async (p) => {
    prompts.push(p);
    return typeof reply === "string" ? reply : reply(p, prompts.length);
  };
  return { client, prompts };
}
