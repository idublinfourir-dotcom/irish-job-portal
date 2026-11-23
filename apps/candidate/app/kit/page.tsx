import { notFound } from "next/navigation";
import { Kit } from "@portal/ui/kit";

// A preview of every component, for looking at in a browser. It does not exist in production.
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Kit />;
}
