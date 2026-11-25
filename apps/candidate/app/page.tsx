import type { Metadata } from "next";
import { HomeView } from "./_home/home";
import { HOME_DESCRIPTION, HOME_TITLE } from "./_home/meta";
import { loadHome } from "./_home/load";
import { meta } from "./_content/meta";
import { staticPath } from "../lib/paths";

// A sector tab (?sector=) is this same page: one canonical address.
export const generateMetadata = (): Metadata => meta(HOME_TITLE, HOME_DESCRIPTION, staticPath("home")!);

export default async function Page({ searchParams }: { searchParams: Promise<{ sector?: string | string[] }> }) {
  const { sector } = await searchParams;
  return <HomeView data={await loadHome(sector)} />;
}
