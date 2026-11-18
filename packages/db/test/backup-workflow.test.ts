// The backup and restore-check workflows' shape (no workflow linter in the repo): triggers, permissions, pinned actions, each secret only on the
// step that needs it, nothing that could echo the address, and the schedule clear of the other workflows.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../../../.github/workflows/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
const steps = (yml: string) => yml.split(/^ {6}- /m).slice(1);
const named = (yml: string, name: string) => steps(yml).find((s) => s.startsWith(`name: ${name}`)) ?? "";

const FLOWS = [
  { file: "backup.yml", group: "backup", secrets: { "Back up the database": ["BACKUP_DATABASE_URL"], "Upload to S3": ["BACKUP_S3_KEY_ID", "BACKUP_S3_SECRET"] } },
  { file: "restore-check.yml", group: "restore-check", secrets: { "Download the newest backup": ["BACKUP_S3_KEY_ID", "BACKUP_S3_SECRET"] } },
];

describe.each(FLOWS)("$file", ({ file, group, secrets }) => {
  const yml = read(file);
  it("runs on a schedule and by hand, never on a pull request or a push", () => {
    expect(yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"))).toMatch(/^\non:\n {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "[^"]+".*\n {2}workflow_dispatch:\n$/);
    expect(yml).not.toMatch(/pull_request|^ {2}push:|workflow_run|repository_dispatch/m);
  });
  it("has read-only permissions, one run at a time, a timeout, and keeps no checkout credentials", () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(yml).toMatch(new RegExp(`group: ${group}\\n\\s+cancel-in-progress: false`));
    expect(yml).toMatch(/^ {4}timeout-minutes: 15$/m);
    expect(yml).toMatch(/actions\/checkout@\w{40} # v[\d.]+\n\s+with:\n\s+persist-credentials: false/);
  });
  it("pins every action to a full commit, like the other workflows", () => {
    const uses = [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(1);
    for (const u of uses) expect(u).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    const others = readdirSync(dir).filter((f) => f !== file && f.endsWith(".yml")).map(read).join("\n");
    for (const u of uses) expect(others, u).toContain(u); // the same pins the repo already uses
  });
  it("gives each secret to its own step only, as an environment value never put in a script", () => {
    const used = [...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]!);
    expect([...new Set(used)].sort()).toEqual([...new Set(Object.values(secrets).flat())].sort());
    for (const [name, list] of Object.entries(secrets)) {
      const s = named(yml, name);
      expect(s, name).not.toBe("");
      for (const secret of list) expect(s).toMatch(new RegExp(`: \\$\\{\\{ secrets\\.${secret} \\}\\}\\n`));
      expect(s.match(/secrets\./g)).toHaveLength(list.length);
      expect(s).not.toMatch(/continue-on-error|if:/); // a failure must turn the run red
    }
    for (const s of steps(yml)) if (!Object.keys(secrets).some((n) => s.startsWith(`name: ${n}`))) expect(s, s.slice(0, 40)).not.toMatch(/secrets\./);
    const scripts = [...yml.matchAll(/run: \|?\n?([\s\S]*?)(?=\n {6}- |\n*$)/g)].map((m) => m[1]!).join("\n");
    expect(scripts).not.toMatch(/\$\{\{/); // no expression inside a script: values reach it as environment variables
  });
  it("never traces commands or prints a secret value", () => {
    expect(yml).not.toMatch(/set -\w*x|set -o xtrace|--debug|ACTIONS_STEP_DEBUG/);
    expect(yml).not.toMatch(/echo[^\n]*(DATABASE_URL|S3_SECRET|S3_KEY_ID|AWS_SECRET|AWS_ACCESS|PGPASSWORD)/);
    expect(yml).not.toMatch(/\benv\b\s*(\||$)|printenv/m);
  });
});

describe("backup.yml", () => {
  const yml = read("backup.yml");
  it("runs every 6 hours at times clear of the fetch, its watch and the other schedules", () => {
    const cron = [...yml.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1]);
    expect(cron).toEqual(["47 */6 * * *"]);
    const taken = readdirSync(dir).filter((f) => f !== "backup.yml").flatMap((f) => [...read(f).matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1]!));
    expect(taken.length).toBeGreaterThan(4);
    for (const t of taken) for (const h of ["0", "6", "12", "18"]) expect(t.split(" ").slice(0, 2).join(" "), t).not.toBe(`47 ${h}`);
  });
  it("uses Postgres 17 tools, checks them before the backup, and uploads the dump before its manifest", () => {
    expect(named(yml, "Install the Postgres 17 client")).toMatch(/postgresql-client-17[\s\S]*\/usr\/lib\/postgresql\/17\/bin >> "\$GITHUB_PATH"/);
    expect(yml.indexOf("Install the Postgres 17 client")).toBeLessThan(yml.indexOf("name: Back up the database"));
    const up = named(yml, "Upload to S3");
    expect(up.indexOf("$name.dump")).toBeLessThan(up.indexOf("$name.json\" \"$prefix\""));
    expect(up).toMatch(/s3:\/\/irish-job-portal-backups\/db\/\$\{stamp:0:4\}\/\$\{stamp:4:2\}\//);
    expect(up).toMatch(/AWS_DEFAULT_REGION: eu-west-1/);
    expect(named(yml, "Back up the database")).toMatch(/node packages\/db\/src\/backup-cli\.ts "\$RUNNER_TEMP\/backup"/);
    expect(named(yml, "Back up the database")).toMatch(/DATABASE_CA_CERT="\$\(cat packages\/fetcher\/data\/supabase-ca\.crt\)"/);
  });
});

describe("restore-check.yml", () => {
  const yml = read("restore-check.yml");
  it("runs once a month and restores into the tests' own Supabase image, which holds no secret", () => {
    expect([...yml.matchAll(/^\s*- cron: "([^"]+)"/gm)].map((m) => m[1])).toEqual(["37 4 1 * *"]);
    const check = read("check.yml");
    expect(yml.match(/image: (\S+)/)![1]).toBe(check.match(/image: (\S+)/)![1]);
    expect(read("../../packages/db/test/test-db.sh")).toContain(`docker.io/${yml.match(/image: (\S+)/)![1]}`);
    expect(named(yml, "Restore and check")).not.toMatch(/secrets\./);
    expect(named(yml, "Restore and check")).toMatch(/restore-check-cli\.ts --manifest .* --dump /);
  });
  it("takes the newest manifest by sorted key and fails when there is none", () => {
    const s = named(yml, "Download the newest backup");
    expect(s).toMatch(/sort \| tail -n 1/);
    expect(s).toMatch(/if \[ -z "\$key" \]; then echo "no backup found in the bucket"; exit 1; fi/);
    expect(s).toMatch(/\$\{key%\.json\}\.dump/);
  });
});

describe("check.yml", () => {
  it("points the backup tests at the database service container", () => {
    const yml = read("check.yml");
    const first = yml.slice(0, yml.indexOf("\n  perf:"));
    expect(first).toMatch(/PG_TOOLS_PREFIX=docker exec -i -e PGPASSWORD \$\(docker ps -q --filter ancestor=supabase\/postgres:17\.11\.0\.018\)" >> "\$GITHUB_ENV"/);
    expect(first.indexOf("PG_TOOLS_PREFIX")).toBeLessThan(first.indexOf("npm run check"));
  });
});
