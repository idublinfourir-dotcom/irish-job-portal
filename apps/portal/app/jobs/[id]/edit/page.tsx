import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormPage, validId } from "../../../_jobform/page-parts";
import { meta } from "../../../_site/meta";

export const metadata: Metadata = meta("Edit a job", "Change a draft or a job you posted. The checks run while you type, and a change to the pay or the role runs the rules again before it is saved.");

/** Frames NE3 and E10 for a job of the company. An address that is not a job id is a 404, as is another company's job. */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  if (!validId(id)) notFound();
  return <FormPage here={`/jobs/${id}/edit`} mode="edit" jobId={id} saved={typeof saved === "string" ? saved : undefined} />;
}
