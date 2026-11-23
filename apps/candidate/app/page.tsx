import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { HomeView } from "./_home/home";
import { HOME_DESCRIPTION, HOME_TITLE } from "./_home/meta";
import { loadHome } from "./_home/load";

export function generateMetadata(): Metadata {
  return { title: `${HOME_TITLE} | ${SITE_NAME}`, description: HOME_DESCRIPTION };
}

export default async function Page({ searchParams }: { searchParams: Promise<{ sector?: string | string[] }> }) {
  const { sector } = await searchParams;
  return <HomeView data={await loadHome(sector)} />;
}
