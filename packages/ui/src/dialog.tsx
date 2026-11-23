"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

/** A modal on the native <dialog>: focus is trapped, Escape closes it. The page owns `open` and `onClose`. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} className="m-auto w-full max-w-lg rounded-card bg-white p-0 text-ink shadow-pop backdrop:bg-ink/50">
      <div className="flex items-start justify-between gap-3 border-b border-line p-5">
        <h2 id={titleId} className="text-xl">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 place-items-center rounded-control hover:bg-hover-light">
          <Icon name="close" />
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
