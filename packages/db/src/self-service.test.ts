// Audit row R1, no database: the delete's confirmation check, the refusal codes of migration 0034, the export file name, and the file removal through the fake store.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDelete, exportFilename } from "./candidate";
import { memoryStore, setFileStore } from "./file-store";
import { accountRefusal, portalDelete, STAFF_EXPORT_SQL } from "./self-service";

const raised = (message: string, code = "P0001") => Object.assign(new Error(message), { code });

describe("the delete confirmation", () => {
  it("takes exactly { confirm: true } and nothing else", () => {
    expect(checkDelete({ confirm: true })).toEqual({ confirm: true });
    for (const b of [null, [], "x", 1, {}, { confirm: false }, { confirm: "true" }, { confirm: 1 }, { confirm: true, userId: "p1" }, [{ confirm: true }]])
      expect(checkDelete(b), JSON.stringify(b)).toBeNull();
  });
});

describe("the refusal codes", () => {
  it("maps each refusal of the functions to its status", () => {
    expect(accountRefusal(raised("account refused: NO_SESSION"))).toEqual({ status: 401, code: "NO_SESSION" });
    expect(accountRefusal(raised("account refused: OPEN_SERVICES_CASE"))).toEqual({ status: 409, code: "OPEN_SERVICES_CASE" });
    expect(accountRefusal(raised("account refused: OWNER_MUST_TRANSFER"))).toEqual({ status: 409, code: "OWNER_MUST_TRANSFER" });
    expect(accountRefusal(raised("account refused: CLOSE_COMPANY_FIRST"))).toEqual({ status: 409, code: "CLOSE_COMPANY_FIRST" });
  });
  it("fails closed: an unknown code or any other P0001 is REFUSED; a non P0001 error is not a refusal", () => {
    expect(accountRefusal(raised("account refused: SOMETHING_NEW"))).toEqual({ status: 403, code: "REFUSED" });
    expect(accountRefusal(raised("team refused: OWNER_MUST_TRANSFER"))).toEqual({ status: 403, code: "REFUSED" });
    expect(accountRefusal(raised("boom", "42501"))).toBeNull();
    expect(accountRefusal(null)).toBeNull();
  });
});

it("the export file name is the day's date", () => {
  expect(exportFilename(new Date("2026-11-18T23:59:59Z"))).toBe("my-data-2026-11-18.json");
});

it("the staff export reads by the acting id only and leaves out evidence, bodies, reasons and other staff ids", () => {
  expect(STAFF_EXPORT_SQL).not.toMatch(/\b(detail|body|reason_text|before|after|evidence_text|offer_details|granted_by_staff_user_id)\b/);
  expect(STAFF_EXPORT_SQL.match(/\$\d/g)!.every((p) => p === "$1")).toBe(true);
});

describe("portalDelete", () => {
  afterEach(() => setFileStore(undefined));
  it("removes every stored file the erase returns; a failed removal is logged by key and the reply still says deleted", async () => {
    const store = memoryStore();
    setFileStore(store);
    for (const k of ["case/a", "case/b"]) await store.put(k, new Uint8Array([1]), "application/pdf");
    const db = { query: async () => ({ rows: [{ r: { erased: true, storage_keys: ["case/a", "case/b"] } }] }) } as never;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    store.failNext();
    expect(await portalDelete(db, "token")).toEqual({ ok: true, filesRemoved: 1 });
    expect([...store.objects.keys()]).toEqual(["case/a"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("delete by hand"), '"case/a"');
    log.mockRestore();
  });
});
