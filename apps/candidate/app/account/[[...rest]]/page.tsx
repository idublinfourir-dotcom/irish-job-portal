import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@portal/ui";
import { readSignedIn } from "../../../lib/data";

// ponytail: stands in for every account page (the header, the bell and the permit pages link to them) so none ends on a 404; P17 deletes this folder.
export const metadata: Metadata = { title: "Your account", robots: { index: false, follow: false } };

export default async function Page() {
  if (!(await readSignedIn())) redirect("/login");
  return (
    <section className="mx-auto flex max-w-page flex-col items-start gap-4 px-5 py-16 sm:px-8">
      <h1>Your account</h1>
      <p className="text-muted">This page is not ready yet. Your account works, and you can search every job.</p>
      <Button href="/jobs">Find jobs</Button>
    </section>
  );
}
