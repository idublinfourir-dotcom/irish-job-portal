import type { ReactNode } from "react";

/** The title and the one line under it that every staff queue page opens with. */
export function Head({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header>
      <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">{title}</h1>
      <p className="text-muted">{children}</p>
    </header>
  );
}
