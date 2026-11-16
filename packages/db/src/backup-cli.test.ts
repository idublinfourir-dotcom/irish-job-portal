// No database: file names, connection strings and what the log may show. The real backup is packages/db/test/backup.test.ts.
import { describe, expect, it } from "vitest";
import { conninfo, connOf, main, scrub, stamp } from "./backup-cli.ts";

describe("backup file names", () => {
  it("are the UTC time to the minute, so the newest name sorts last", () => {
    expect(stamp(new Date("2026-11-16T12:30:45Z"))).toBe("20261116T1230Z");
    expect(stamp(new Date("2026-11-16T23:59:59Z")) < stamp(new Date("2026-12-01T00:00:00Z"))).toBe(true);
    expect(stamp(new Date("2026-11-16T23:30:00+02:00"))).toBe("20261116T2130Z");
  });
});

describe("pg_dump connection", () => {
  const url = "postgres://app_backup.abc:p%40ss'w%5Cd@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
  it("keeps the password out of the connection string", () => {
    const c = connOf(url, {}, undefined, "/tmp/ca.crt");
    expect(c).toMatchObject({ host: "aws-0-eu-west-1.pooler.supabase.com", port: "5432", user: "app_backup.abc", password: "p@ss'w\\d", sslmode: "verify-full" });
    expect(conninfo(c)).toBe("host='aws-0-eu-west-1.pooler.supabase.com' port='5432' user='app_backup.abc' dbname='postgres' sslmode='verify-full' sslrootcert='/tmp/ca.crt'");
    expect(conninfo(c)).not.toContain("w%5Cd");
    expect(conninfo(c)).not.toMatch(/password|p@ss/);
  });
  it("a local database may opt out of TLS, and the tool address can be overridden", () => {
    expect(connOf("postgres://u:p@127.0.0.1:54329/x", { DATABASE_SSL: "disable", PG_TOOLS_ADDR: "127.0.0.1:5432" })).toMatchObject({ host: "127.0.0.1", port: "5432", sslmode: "disable" });
  });
  it("quotes a value that holds a quote", () => {
    expect(conninfo({ host: "h", port: "1", user: "a'b", password: "", database: "d", sslmode: "disable" })).toContain("user='a\\'b'");
  });
});

describe("log scrubbing", () => {
  it("removes the address and the password from an error text", () => {
    expect(scrub("connect ECONNREFUSED db.example.test:5432 as pw1", "db.example.test", "pw1", "", undefined)).toBe("connect ECONNREFUSED ***:5432 as ***");
  });
});

describe("main", () => {
  it("needs one folder and the login, and never prints the address when the URL is wrong", async () => {
    const lines: string[] = [];
    expect(await main([], {}, (l) => lines.push(l))).toBe(2);
    expect(await main(["out"], {}, (l) => lines.push(l))).toBe(2);
    expect(await main(["out"], { BACKUP_DATABASE_URL: "not a url" }, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).not.toContain("not a url");
  });
});
