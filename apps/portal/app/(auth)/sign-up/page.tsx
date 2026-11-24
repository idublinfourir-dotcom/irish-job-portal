import type { Metadata } from "next";
import { Button, Icon } from "@portal/ui";
import { meta } from "../../_site/meta";
import { outLinks } from "../../_site/guard";
import { candidateHref } from "../../../lib/data";
import { AuthFrame } from "../frame";

export const metadata: Metadata = meta("Create an employer account", "Pick employer or recruitment agency, then create your login. Irish Work Permit verifies every employer and agency before a sponsored job goes live.");

const CHOICES = [
  { value: "employer", title: "I'm an employer", text: "A company registered and trading in Ireland, hiring for itself.", icon: "building" },
  { value: "agency", title: "I'm a recruitment agency", text: "A licensed employment agency, hiring for clients or as the permit employer.", icon: "users" },
] as const;

/** Frame E02: the account type. A plain GET form to the account step, so it needs no script. */
export default function Page() {
  const candidates = candidateHref("/");
  return (
    <AuthFrame step={1} title={<>Create an <span className="text-deep-green">employer account</span></>} lead="Pick the one that describes you. It decides how we verify you." panel={["Post jobs", "candidates can trust"]} panelLead="Every employer and agency is verified before a job goes live." {...outLinks()}>
      <form action="/sign-up/account" method="get" className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Account type</legend>
          {CHOICES.map((c, i) => (
            <label key={c.value} className="flex cursor-pointer items-center gap-4 rounded-bento border-[1.5px] border-transparent bg-sand p-4 has-[:checked]:border-deep-green has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink">
              <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-pill bg-white text-deep-green"><Icon name={c.icon} /></span>
              <span className="flex-1"><span className="block font-semibold">{c.title}</span><span className="block text-small text-muted">{c.text}</span></span>
              <input type="radio" name="kind" value={c.value} defaultChecked={i === 0} className="size-5 accent-deep-green" />
            </label>
          ))}
        </fieldset>
        <Button type="submit" variant="dark" size="lg" className="w-full">Continue</Button>
      </form>
      {candidates && <p className="text-small text-muted">Looking for a job instead? <a href={candidates} className="font-semibold text-deep-green underline underline-offset-2">Go to the candidate site</a></p>}
    </AuthFrame>
  );
}
