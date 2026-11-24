"use client";
// The pop-up of frames C10, C11 and M05: a native <dialog> (focus trapped, Escape closes) that is a centred card from 640 px and a sheet from the bottom on a phone.
// The caller mounts it only while it is open, so it opens once on mount. Body and footer classes are exported so every pop-up has the same two bands.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "@portal/ui";

export const MODAL_BODY = "flex flex-col gap-4 bg-sand px-6 pb-5 pt-1 sm:px-7";
export const MODAL_FOOT = "flex flex-col gap-2 bg-white px-6 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-3 sm:px-7";

export function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[35rem] overflow-y-auto rounded-bento bg-sand p-0 text-ink shadow-modal backdrop:bg-ink/50 max-sm:mx-0 max-sm:mb-0 max-sm:mt-auto max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
    >
      <div className="flex items-start justify-between gap-3 px-6 pb-3 pt-6 sm:px-7">
        <h2 id={titleId} className="text-[20px]">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 shrink-0 place-items-center rounded-pill bg-white hover:bg-hover-light">
          <Icon name="close" size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
