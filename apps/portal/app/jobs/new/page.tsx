import type { Metadata } from "next";
import { FormPage, validId } from "../../_jobform/page-parts";
import { meta } from "../../_site/meta";

export const metadata: Metadata = meta("Post a job", "Post a job with the rules checked while you type: the occupation, the pay minimum, the contract and the advert text. Publish it, or save a draft for later.");

/** Frames NE3 and E10. `?from=<id>` fills the form with an earlier job of the company (a repost); anything else in the address is ignored. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { from } = await searchParams;
  return <FormPage here="/jobs/new" mode="new" jobId={validId(from) ? from : undefined} />;
}
