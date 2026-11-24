"use client";
// "Your degree" (frames N03 and NM3, states in C08): three answers, and the minimum that applies. Pure from the minimums the job read carries, so a click needs no request.
import { useState } from "react";
import { criticalSkillsResult, degreeChoices, type DegreeChoice, type Minimums, type Pay } from "./degree";
import { ResultText } from "./result";

export function DegreeBox({ minimums, pay, initial }: { minimums: Minimums; pay: Pay; initial: DegreeChoice }) {
  const [choice, setChoice] = useState<DegreeChoice>(initial);
  return (
    <section aria-labelledby="degree-heading" data-degree-box className="flex flex-col gap-3 rounded-bento bg-sand p-6 xl:p-8">
      <h2 id="degree-heading" className="text-[22px] sm:text-[24px]">Your degree</h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Your degree</legend>
        {degreeChoices(minimums.graduateMonths).map(([value, label]) => (
          <label key={value} className="flex min-h-[52px] cursor-pointer items-center gap-3 rounded-pill bg-lilac px-5 py-2 text-[15px] has-[:checked]:bg-deep-green has-[:checked]:text-white has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink">
            <input type="radio" name="degree" value={value} checked={choice === value} onChange={() => setChoice(value)} className="size-5 shrink-0 accent-ink" />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1 rounded-card bg-peach p-5"><ResultText r={criticalSkillsResult(choice, minimums, pay)} /></div>
    </section>
  );
}
