// Helpers for the adapter tests: a fake fetch that records every call, and the fixtures.
import type { Fetch } from "../types";
import amazon from "./fixtures/amazon.json";
import ashby from "./fixtures/ashby.json";
import greenhouse from "./fixtures/greenhouse.json";
import srDetails from "./fixtures/smartrecruiters-details.json";
import srList from "./fixtures/smartrecruiters-list.json";
import wdDetails from "./fixtures/workday-details.json";
import wdList from "./fixtures/workday-list.json";

export type Call = { url: string; method: string; body: unknown; headers: Record<string, string>; signal: AbortSignal | null | undefined; redirect: RequestRedirect | undefined };
export type Handler = (call: Call) => Response | Promise<Response>;

export const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

export function fake(handler: Handler): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(call);
  }) as Fetch;
  return { fetch: f, calls };
}

export const none: ReadonlySet<string> = new Set();
export const clone = <T>(v: T): T => structuredClone(v);
export const fixtures = { amazon, ashby, greenhouse, srDetails: srDetails as Record<string, unknown>, srList, wdDetails: wdDetails as Record<string, unknown>, wdList };
/** The adapters' options for a test: no real waiting (429 retries and Workday's pauses). */
export const noSleep = { sleep: async () => {} };
