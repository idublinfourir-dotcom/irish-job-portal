import type { ReactNode } from "react";

/** The title and the one line under it that every staff queue page opens with. */
/** `big`: the same title with the frame's highlighted words (its text must start with the title). */
export function Head({ title, big, children }: { title: string; big?: ReactNode; children: ReactNode }) {
  return (
    <header>
      <h1 className={`mb-1 text-[32px] md:text-[34px] ${big ? "leading-[1.5]" : "leading-tight"}`}>{big ?? title}</h1>
      <p className="text-muted">{children}</p>
    </header>
  );
}
