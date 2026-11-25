import { shortDate } from "../../_home/format";
import { Row } from "./settings-forms";

export type LogRow = { by: string; action: string; at: string };

/** Who viewed my data (B41): empty at Launch A, so the page says so; each row is who, and when. */
export function DataLog({ rows }: { rows: LogRow[] }) {
  return (
    <Row title="Who viewed my data" detail={rows.length === 0 ? "No employer or staff member has viewed your data." : "Employers and staff who viewed or received your data, newest first."}>
      {rows.length > 0 && (
        <ul className="flex flex-col gap-1 text-small">
          {rows.slice(0, 50).map((r, i) => <li key={i}><span className="font-semibold">{r.by}</span> · {shortDate(r.at.slice(0, 10))}</li>)}
        </ul>
      )}
    </Row>
  );
}
