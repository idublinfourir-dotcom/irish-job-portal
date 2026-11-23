"use client";

import { useState } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";

export function KitDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Close this job?">
        <p className="mb-4">Placeholder text. Escape or Close dismisses it.</p>
        <Button onClick={() => setOpen(false)}>Done</Button>
      </Dialog>
    </>
  );
}
