// Shared by the backup tests: where pg_dump and pg_restore run, and a seeded database. Fake data only.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestDb } from "./db";

// The laptop has no Postgres client, so the tools run inside the test container (the same image, version 17). check.yml sets these to
// `docker exec` on its service container. The prefix passes PGPASSWORD through; the address is the server as the container sees it.
export const toolEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  DATABASE_SSL: "disable",
  PG_TOOLS_PREFIX: process.env.PG_TOOLS_PREFIX ?? `${process.env.CONTAINER ?? "podman"} exec -i -e PGPASSWORD portal-test-db`,
  PG_TOOLS_ADDR: process.env.PG_TOOLS_ADDR ?? "127.0.0.1:5432",
});

export const tempDir = () => mkdtemp(join(tmpdir(), "backup-test-"));

// Rows in several tables, and in cro_company (whose rows a backup leaves out).
export async function seed(db: TestDb) {
  const su = db.pool("postgres");
  await su.query("insert into candidate_user(id,name,email,email_verified,updated_at) select 'c'||g,'Fake','c'||g||'@example.test',true,now() from generate_series(1,5) g");
  await su.query("insert into portal_user(id,name,email,email_verified,updated_at) select 'p'||g,'Fake','p'||g||'@example.test',true,now() from generate_series(1,2) g");
  await su.query("insert into staff_user(id,name,email,email_verified,updated_at) values ('s1','Fake','s1@example.test',true,now())");
  await su.query("insert into organisation(slug,display_name,kind,status) values ('fake-org','Fake Org','employer','verified')");
  await su.query("insert into cro_company(cro_number,name,normalised_name,status,last_seen_on) select (900000+g)::text,'Fake Company '||g||' Limited','fake company '||g,'Normal',now() from generate_series(1,40) g");
  await su.query("insert into wrc_licence(licence_number,agency_name,county,first_seen_on,last_seen_on) values ('EA1','Fake Recruitment Limited','Dublin',now(),now())");
}
