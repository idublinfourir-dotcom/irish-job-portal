// Each app's app/global-error.tsx reports the render error to Sentry and shows plain text, never the error itself (decision #267).
// Rendered on the server with React; useEffect is made to run at once, since a server render never runs effects.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useEffect: (f: () => void) => f() }));

const apps = {
  admin: () => import("./admin/app/global-error"),
  candidate: () => import("./candidate/app/global-error"),
  portal: () => import("./portal/app/global-error"),
};

beforeEach(() => captureException.mockClear());

describe.each(Object.entries(apps))("%s global-error", (_, load) => {
  it("calls Sentry.captureException with the error and shows only placeholder text", async () => {
    const { default: GlobalError } = await load();
    const error = Object.assign(new Error("render failed for jane@example.com"), { digest: "d1" });
    const html = renderToStaticMarkup(createElement(GlobalError, { error }));
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error);
    expect(html).toContain("Something went wrong");
    expect(html).not.toMatch(/jane|render failed|d1/);
  });
});
