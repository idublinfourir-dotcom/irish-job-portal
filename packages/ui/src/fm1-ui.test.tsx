// FM1 motion: the button ring, the header pill island, the sidebar and card hooks. No browser: the island's handlers are called with a fake row.
import { renderToStaticMarkup as html } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const row = { style: { setProperty: vi.fn() }, setAttribute: vi.fn(), removeAttribute: vi.fn() };
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useRef: () => ({ current: row }) }));

import { Button, PortalShell } from "./index";
import { NavPill } from "./nav-pill";
import { SiteHeader } from "./candidate-shell";

const link = { closest: () => ({ offsetLeft: 40, offsetWidth: 90 }) };
const reduce = (on: boolean) => vi.stubGlobal("window", { matchMedia: () => ({ matches: on }) });
const props = () => (NavPill({ children: null }) as ReactElement<Record<string, (e?: unknown) => void>>).props;

describe("primary button ring", () => {
  it("is an aria-hidden span, only on primary, and the name is unchanged", () => {
    const h = html(<Button>Apply now</Button>);
    expect(h).toContain('<span aria-hidden="true" data-btn-ring="true"></span>');
    expect(h.replace(/<span[^>]*><\/span>/, "").replace(/<[^>]*>/g, "")).toBe("Apply now");
    expect(html(<Button variant="dark">x</Button>)).not.toContain("data-btn-ring");
    expect(html(<Button disabled>x</Button>)).not.toContain("data-btn-ring");
    expect(html(<Button href="/a">Go</Button>)).toMatch(/<a [^>]*href="\/a"[^>]*><span aria-hidden="true" data-btn-ring="true"><\/span>Go<\/a>/);
  });
});

describe("header pill island", () => {
  beforeEach(() => vi.clearAllMocks());
  it("moves on pointer and focus, and clears on leave", () => {
    reduce(false);
    props().onPointerOver?.({ pointerType: "mouse", target: link });
    expect(row.style.setProperty).toHaveBeenCalledWith("--x", "40px");
    expect(row.style.setProperty).toHaveBeenCalledWith("--w", "90px");
    props().onFocus?.({ target: link });
    expect(row.setAttribute).toHaveBeenCalledTimes(2);
    props().onPointerLeave?.();
    expect(row.removeAttribute).toHaveBeenCalledWith("data-hov");
  });
  it("ignores touch and does nothing with reduced motion", () => {
    reduce(false);
    props().onPointerOver?.({ pointerType: "touch", target: link });
    reduce(true);
    props().onFocus?.({ target: link });
    expect(row.setAttribute).not.toHaveBeenCalled();
  });
  it("keeps the header links real links", () => {
    const h = html(<SiteHeader />);
    expect(h).toMatch(/<nav aria-label="Main"[^>]*><div data-nav-row[^>]*><span aria-hidden="true" data-nav-pill="true"><\/span><a /);
    expect(h).toContain('href="/login"');
  });
});

describe("sidebar and css hooks", () => {
  it("marks the sidebar to slide in and keeps its links", () => {
    const h = html(<PortalShell companyName="Fake Co" role="Poster" roleKey="poster">BODY</PortalShell>);
    expect(h).toMatch(/<aside data-slide-in="true"/);
    expect(h).toContain('<nav aria-label="Sections"');
  });
  it("css gates every effect on fine pointers or reduced motion", () => {
    const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\)[^{]*\{\s*\[data-press\]:hover > \[data-btn-ring\]/);
    expect(css).toMatch(/\(prefers-reduced-motion: no-preference\)[^{]*\{\s*\[data-lift\]:hover \{ transform: translateY\(-4px\)/);
    expect(css).toMatch(/\(prefers-reduced-motion: no-preference\) \{\s*\[data-slide-in\] \{ animation: slide-in 600ms cubic-bezier\(0.23, 1, 0.32, 1\)/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\[data-btn-ring\] \{ animation: none/);
  });
});
