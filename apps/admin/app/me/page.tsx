import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readMe } from "../../lib/data";
import { tryRead } from "../_tools/read";
import { Me } from "./view";

export const metadata: Metadata = { title: `My data, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function Page() {
  const r = await tryRead(readMe); // any active staff login: only a visitor or a disabled login is turned away
  if (!r.ok) return null;
  return <Me name={r.value.name} roles={r.value.roles} />;
}
