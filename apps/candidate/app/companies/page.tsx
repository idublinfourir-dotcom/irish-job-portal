// /companies: the directory of companies (P9, frame C13). Reads only through lib/data.ts; a search is a plain GET form, paging is by cursor.
import type { Metadata } from "next";
import { readCompanies } from "../../lib/data";
import { meta } from "../_content/meta";
import { Problem, type Failed } from "../_content/problem";
import { DirectoryView, type CompanyRow } from "./directory-view";

export const generateMetadata = (): Metadata => meta("Companies that sponsor permits", "Companies hiring in Ireland with their employment permit history from DETE records since 2019, their county, labels and live jobs.", "/companies");

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = one(sp.q).trim(), after = one(sp.after);
  const r = await readCompanies({ ...(q && { q }), ...(after && { after }) });
  if (!r.ok) return <Problem read={r as Failed} what="search" back={{ href: "/companies", label: "Back to all companies" }} />;
  const d = r.data as { companies: CompanyRow[]; next: string | null };
  return <DirectoryView companies={d.companies} next={d.next} q={q} />;
}
