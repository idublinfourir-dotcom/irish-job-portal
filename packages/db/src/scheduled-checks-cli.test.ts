// Unit tests (no database) for the database size check of audit DB-4: the 350 MB line and the text the red run prints.
import { describe, expect, it } from "vitest";
import { main, sizeReport, SIZE_LIMIT_MB } from "./scheduled-checks-cli";

const MB = 1024 * 1024;
describe("sizeReport", () => {
  const top = [{ name: "public.cro_company", bytes: 167 * MB }, { name: "public.job", bytes: 12.25 * MB }];
  it("under the limit: green, the total and each table in MB", () => {
    expect(sizeReport(212 * MB, top)).toEqual({ red: false, lines: [
      "database size: 212.0 MB, limit 350 MB (free plan cap 500 MB)", "    167.0 MB  public.cro_company", "     12.3 MB  public.job"] });
  });
  it("at the limit or over: red, and the line says what to do", () => {
    expect(SIZE_LIMIT_MB).toBe(350);
    expect(sizeReport(350 * MB - 1, []).red).toBe(false);
    const r = sizeReport(350 * MB, top);
    expect(r.red).toBe(true);
    expect(r.lines[0]).toBe("database size: 350.0 MB, limit 350 MB (free plan cap 500 MB): OVER THE LIMIT, plan the move to the paid database or free space");
    expect(sizeReport(10 * MB, [], 5).red).toBe(true);
  });
  it("hostile input: a control character in a table name cannot start a fake log line", () => {
    expect(sizeReport(1, [{ name: "public.x\nfake line\u001b[2J", bytes: 0 }]).lines).toEqual(["database size: 0.0 MB, limit 350 MB (free plan cap 500 MB)", "      0.0 MB  public.x?fake line?[2J"]);
  });
  it("the command: only `size` or no argument; each mode names its own login", async () => {
    const out: string[] = [];
    expect(await main(["size", "x"], {}, (l) => out.push(l))).toBe(2);
    expect(await main(["sizes"], {}, (l) => out.push(l))).toBe(2);
    expect(await main(["size"], { SCHEDULED_ADMIN_DATABASE_URL: "postgres://x" }, (l) => out.push(l))).toBe(2);
    expect(out.at(-1)).toBe("SIZE_BACKUP_DATABASE_URL is not set (the app_backup login)");
  });
});
