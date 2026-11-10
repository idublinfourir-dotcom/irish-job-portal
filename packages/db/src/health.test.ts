import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("pg", () => ({ default: { Pool: class { query = query; on() {} } } }));
vi.mock("@vercel/functions", () => ({ attachDatabasePool: () => {} }));

const { checkDatabase, resetHealthCache } = await import("./index");

beforeEach(() => {
  vi.useFakeTimers();
  process.env.DATABASE_URL = "postgres://x@127.0.0.1/x";
  (globalThis as { __portalPool?: unknown }).__portalPool = undefined;
  query.mockReset();
  resetHealthCache();
});
afterEach(() => vi.useRealTimers());

describe("checkDatabase", () => {
  it("makes one query for 100 calls inside 5 seconds, then asks again", async () => {
    query.mockResolvedValue({});
    const results = await Promise.all(Array.from({ length: 100 }, () => checkDatabase()));
    expect(results.every(Boolean)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4999);
    await checkDatabase();
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await checkDatabase();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("caches a failure no longer than a success", async () => {
    query.mockRejectedValueOnce(new Error("down")).mockResolvedValue({});
    expect(await checkDatabase()).toBe(false);
    expect(await checkDatabase()).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(await checkDatabase()).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reports false when the database is not configured", async () => {
    delete process.env.DATABASE_URL;
    expect(await checkDatabase()).toBe(false);
  });
});
