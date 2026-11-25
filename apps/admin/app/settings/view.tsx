// The settings page (two-person, no frame) as parts that take their data as props, so a test renders every state. page.tsx reads and hands them over.
import { Notice, Pill } from "@portal/ui";
import { humanKey, when } from "../_tools/text";
import { Controls } from "./controls";
import { valueText } from "./text";

export type Setting = { key: string; value: number | null; unit: string | null; is_guess: boolean; solicitor_confirmed_at: string | null; updated_at: string };
export type PendingChange = { requestId: string; key: string; value: number | null; proposedBy: string };

export function Settings({ settings, pending, meId }: { settings: Setting[]; pending: PendingChange[]; meId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Settings</h1>
        <p className="text-muted">The retention periods and limits. A change needs two administrators: one proposes, a different one confirms. The value is written when the second confirms.</p>
      </header>
      {settings.length === 0 && <Notice kind="info">There are no settings yet.</Notice>}
      <ul className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {settings.map((s) => {
          const change = pending.find((x) => x.key === s.key);
          return (
            <li key={s.key} className="flex flex-col gap-3 rounded-bento bg-sand p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[22px] [overflow-wrap:anywhere]">{humanKey(s.key)}</h2>
                <p className="text-[22px] font-semibold">{valueText(s.value, s.unit)}</p>
              </div>
              <p className="flex flex-wrap items-center gap-2 text-small text-muted">
                {s.is_guess && <Pill tone="peach">A guess</Pill>}
                {s.solicitor_confirmed_at ? `Confirmed by the solicitor on ${when(s.solicitor_confirmed_at)}.` : "Not yet confirmed by the solicitor."}
                {` Last changed ${when(s.updated_at)}.`}
              </p>
              <Controls settingKey={s.key} unit={s.unit} pending={change && { requestId: change.requestId, value: change.value, mine: change.proposedBy === meId }} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
