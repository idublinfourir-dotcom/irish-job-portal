import { publicRead, type Work } from "@portal/db";
import { signedInCandidate } from "./candidate";

// PERF-11: a public list that is the same for every reader (the work ignores the visitor flag) may sit on the CDN. Only a 200 is marked cacheable: a
// refusal (429, 404, 400) never is, so a rate limit or a switched-off notice is not served to the next reader.
export const CDN_CACHE = "public, s-maxage=300, stale-while-revalidate=3600";
export async function cachedRead(r: Request, work: Work): Promise<Response> {
  const res = await publicRead(r, signedInCandidate, work);
  if (res.status === 200) res.headers.set("cache-control", CDN_CACHE);
  return res;
}
