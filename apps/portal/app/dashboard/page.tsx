import { redirect } from "next/navigation";
import { homeFor, requireLogin } from "../../lib/data";

// P18 (wave 3) replaces this page. It is here so that a signed-in login lands on a page, not a 404 (the sidebar's own link is /dashboard).
// A login with no company, or one still in review, goes to its own step first.
export default async function Page() {
  const to = homeFor(await requireLogin());
  if (to !== "/dashboard") redirect(to);
  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl">Employer portal</h1>
      <p className="mt-2">Nothing here yet.</p>
    </div>
  );
}
