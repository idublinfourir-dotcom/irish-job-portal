"use client";
// The soft pill that slides behind the main nav link under the pointer or keyboard focus (look in tokens.css). The links stay plain links; this only sets --x and --w.
import { useRef, type ReactNode } from "react";

export function NavPill({ className, children }: { className?: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const move = (e: { target: EventTarget }) => {
    const a = (e.target as HTMLElement).closest?.("a");
    const r = row.current;
    if (!a || !r || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    r.style.setProperty("--x", `${a.offsetLeft}px`);
    r.style.setProperty("--w", `${a.offsetWidth}px`);
    r.setAttribute("data-hov", "");
  };
  const leave = () => row.current?.removeAttribute("data-hov");
  return (
    <div ref={row} data-nav-row className={`relative isolate ${className ?? ""}`} onPointerOver={(e) => e.pointerType === "mouse" && move(e)} onFocus={move} onPointerLeave={leave} onBlur={leave}>
      <span aria-hidden="true" data-nav-pill />
      {children}
    </div>
  );
}
