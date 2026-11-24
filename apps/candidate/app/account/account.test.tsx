// The stand-in for the account pages (until P17): a visitor goes to sign-in, a signed-in candidate gets a page, never a 404.
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let signedIn = false;
vi.mock("../../lib/data", () => ({ readSignedIn: async () => signedIn }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));

describe("the account stand-in", () => {
  it("sends a visitor to sign-in", async () => {
    const Page = (await import("./[[...rest]]/page")).default;
    signedIn = false;
    await expect(Page()).rejects.toThrow("redirect /login");
  });
  it("shows a signed-in candidate one page with a way on, not indexed", async () => {
    const { default: Page, metadata } = await import("./[[...rest]]/page");
    signedIn = true;
    const h = html(await Page());
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).toContain('href="/jobs"');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
