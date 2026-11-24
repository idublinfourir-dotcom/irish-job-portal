// What the degree result says (frame C08's peach box): pure, from a DegreeResult. A state is never an error: "below" is said plainly and calmly.
import { Icon } from "@portal/ui";
import type { DegreeResult } from "./degree";
import { euro } from "./format";

export function ResultText({ r, label = "Minimum that applies to you" }: { r: DegreeResult; label?: string }) {
  if (r.kind === "public_pay")
    return (
      <>
        <p className="text-small">Result</p>
        <p className="font-heading text-[20px] font-semibold leading-snug">No salary minimum applies to this job</p>
        <p className="flex items-center gap-1.5 text-small"><Icon name="check" size={16} />This job follows a public sector pay scale.</p>
      </>
    );
  if (r.kind === "route_closed")
    return (
      <>
        <p className="text-small">{label}</p>
        <p className="text-[15px]">Without a relevant degree, this permit route is not open for this kind of job.</p>
      </>
    );
  const [icon, line] =
    r.standing === "clears" ? (["check", "This job clears it."] as const)
    : r.standing === "depends" ? (["info", "The top of the pay range clears it. It depends on where you start."] as const)
    : r.standing === "below" ? (["warning", "This job is below that minimum."] as const)
    : r.basis === "big_company" ? (["info", "Salary is not stated. This employer is on our list of large companies whose pay for this role clears the minimum."] as const)
    : r.basis === "pay_floor" ? (["info", "Salary is not stated. The employer has signed a pay floor for this role."] as const)
    : (["info", "Salary is not stated, so we cannot say if it clears the minimum."] as const);
  return (
    <>
      <p className="text-small">{label}</p>
      <p className="font-heading text-[26px] font-semibold leading-tight">{euro(r.minimum)} a year</p>
      <p aria-live="polite" className="flex items-start gap-1.5 text-small"><Icon name={icon} size={16} className="mt-0.5 shrink-0" />{line}</p>
    </>
  );
}
