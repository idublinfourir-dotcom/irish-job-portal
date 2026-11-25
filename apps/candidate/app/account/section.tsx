import type { ReactNode } from "react";

/** One card of an account page (frames NA3, A09): a soft surface with a heading and its content. */
export function Section({ title, tone, num, children }: { title: string; tone?: "danger"; num?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
      <h2 className={`flex items-center gap-3 text-[1.375rem] ${tone === "danger" ? "text-error" : ""}`}>
        {num !== undefined && <span aria-hidden="true" className="grid size-8 place-items-center rounded-pill bg-ink text-small font-semibold text-white">{num}</span>}
        {title}
      </h2>
      {children}
    </section>
  );
}
