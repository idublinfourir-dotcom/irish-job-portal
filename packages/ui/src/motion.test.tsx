// Unit tests of the motion layer (FM1). No DOM package is installed, so the few DOM parts motion.tsx touches are faked here; no network, no browser.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countText, Motion, mountMotion } from "./motion";

class El {
  attrs = new Set<string>();
  style: Record<string, string> = {};
  kids: El[] = [];
  parent?: El;
  textContent = "";
  className = "";
  offsetHeight = 30;
  rect = { top: 0, left: 10, width: 100, height: 30 };
  qs: Record<string, El> = {};
  static throwOnAnimate = false;
  animate = vi.fn((...args: unknown[]) => {
    void args;
    if (El.throwOnAnimate) throw new Error("animate failed");
    return { finished: Promise.resolve(), cancel: vi.fn() };
  });
  setAttribute(k: string) { this.attrs.add(k); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  append(...c: El[]) { c.forEach((x) => { x.parent = this; this.kids.push(x); }); }
  remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); }
  contains(o: El) { for (let n: El | undefined = o; n; n = n.parent) if (n === this) return true; return false; }
  getBoundingClientRect() { return this.rect; }
  cloneNode() { const c = new El(); c.rect = { ...this.rect }; return c; }
  querySelector(s: string) { return this.qs[s] ?? null; }
  addEventListener() {}
  removeEventListener() {}
}

let lists: Record<string, El[]>, doc: { documentElement: El; body: El }, io: { cb: (e: unknown[]) => void; observed: Set<El>; disconnect: () => void }, store: Map<string, string>, reduce: boolean, webdriver: boolean;
const listeners = new Map<string, () => void>();
const fire = (...els: El[]) => io.cb(els.map((target) => ({ target, isIntersecting: true })));
const mk = (top: number, height = 100) => { const e = new El(); e.rect = { top, left: 0, width: 300, height }; return e; };
const LOGO = 'a[aria-label$=", home"]';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  El.throwOnAnimate = false; reduce = false; webdriver = false; lists = {}; store = new Map(); listeners.clear();
  doc = { documentElement: new El(), body: new El() };
  doc.documentElement.style.overflow = "";
  io = undefined as never;
  vi.stubGlobal("document", {
    ...doc,
    createElement: () => new El(),
    querySelectorAll: (s: string) => lists[s] ?? [],
    querySelector: (s: string) => lists[s]?.[0] ?? null,
  });
  class IO {
    observed = new Set<El>();
    disconnect = vi.fn();
    constructor(public cb: (e: unknown[]) => void) { io = { cb, observed: this.observed, disconnect: this.disconnect }; }
    observe(e: El) { this.observed.add(e); }
    unobserve(e: El) { this.observed.delete(e); }
  }
  vi.stubGlobal("IntersectionObserver", IO);
  vi.stubGlobal("matchMedia", () => ({ matches: reduce }));
  vi.stubGlobal("navigator", { get webdriver() { return webdriver; } });
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("getComputedStyle", () => ({ backgroundColor: "rgb(0, 0, 0)" }));
  vi.stubGlobal("addEventListener", (e: string, f: () => void) => listeners.set(e, f));
  vi.stubGlobal("removeEventListener", (e: string) => listeners.delete(e));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
// the fake `document` above copies body and documentElement by reference, so reach them through doc
const docEl = () => doc.documentElement, body = () => doc.body;
const logo = () => { const l = mk(10, 30); lists[LOGO] = [l]; return l; };

describe("count-up text", () => {
  it("keeps prefix and suffix and formats like en-IE", () => {
    expect(countText("€40,904", 0)).toBe("€0");
    expect(countText("€40,904", 1)).toBe("€40,904");
    expect(countText("27%", 0.5)).toMatch(/^\d+%$/);
    expect(countText("€40,904 a year", 1)).toBe("€40,904 a year");
    expect(countText("No salary", 1)).toBeNull();
  });
  it("counts up, ends on the original text, and cleanup restores it midway", () => {
    const a = new El(), b = new El();
    a.textContent = "€40,904"; b.textContent = "27%";
    lists["[data-count]"] = [a, b];
    const stop = mountMotion(null);
    a.attrs.add("data-count"); b.attrs.add("data-count");
    expect(a.textContent).toBe("€40,904"); // the final text stays until the number is on screen
    fire(a, b);
    expect(a.textContent).toBe("€0");
    vi.advanceTimersByTime(300);
    expect(a.textContent).not.toBe("€0");
    stop();
    expect(a.textContent).toBe("€40,904");
    expect(b.textContent).toBe("27%");
    const c = new El(); c.textContent = "€10,000"; c.attrs.add("data-count"); lists["[data-count]"] = [c];
    mountMotion(null); fire(c); vi.advanceTimersByTime(1400);
    expect(c.textContent).toBe("€10,000");
  });
});

describe("scroll reveals", () => {
  it("hides only what starts below the fold, top-level only, and never a huge block", () => {
    const above = mk(100), below = mk(2000), inner = mk(2100), huge = mk(1500, 9000), outer = mk(2000);
    outer.kids = [inner]; inner.parent = outer;
    lists["main section, main h2, [data-lift]"] = [above, outer, inner, huge];
    mountMotion(null);
    expect(above.attrs.has("data-rv")).toBe(false);
    expect(huge.attrs.has("data-rv")).toBe(false);
    expect(inner.attrs.has("data-rv")).toBe(false);
    expect(outer.attrs.has("data-rv")).toBe(true);
    expect([...io.observed]).toEqual([outer]);
    expect(below.attrs.has("data-rv")).toBe(false);
    fire(outer);
    expect(outer.attrs.has("data-rv")).toBe(false);
    expect(outer.animate.mock.calls[0]![1]).toMatchObject({ duration: 750, delay: 0, easing: "cubic-bezier(.23,1,.32,1)" });
  });
  it("staggers by 70 ms, at most 6 steps", () => {
    const els = Array.from({ length: 9 }, (_, i) => mk(2000 + i * 100));
    lists["main section, main h2, [data-lift]"] = els;
    mountMotion(null);
    fire(...els);
    expect(els.map((e) => (e.animate.mock.calls[0]![1] as { delay: number }).delay)).toEqual([0, 70, 140, 210, 280, 350, 420, 420, 420]);
  });
  it("cleanup removes every hidden mark and stops the observer", () => {
    const s = mk(2000);
    lists["main section, main h2, [data-lift]"] = [s];
    lists["[data-rv]"] = [s];
    const stop = mountMotion(null);
    expect(s.attrs.has("data-rv")).toBe(true);
    stop();
    expect(s.attrs.has("data-rv")).toBe(false);
    expect(io.disconnect).toHaveBeenCalled();
  });
  it("reduced motion does nothing", () => {
    reduce = true;
    const s = mk(2000);
    lists["main section, main h2, [data-lift]"] = [s]; logo();
    mountMotion(null);
    expect(s.attrs.has("data-rv")).toBe(false);
    expect(s.animate).not.toHaveBeenCalled();
    expect(body().kids).toHaveLength(0);
    expect(store.size).toBe(0);
  });
});

describe("preloader", () => {
  it("runs once per session, locks scroll, then removes itself and unlocks", () => {
    logo();
    const stop = mountMotion(null);
    expect(body().kids).toHaveLength(1);
    expect(docEl().style.overflow).toBe("hidden");
    expect([...store.keys()]).toEqual(["portal-pre"]);
    vi.advanceTimersByTime(4300);
    expect(body().kids).toHaveLength(0);
    expect(docEl().style.overflow).toBe("");
    stop();
    mountMotion(null);
    expect(body().kids).toHaveLength(0); // second load of the session: no overlay
  });
  it("is skipped with no logo, with a webdriver browser, and when storage is blocked it still runs", () => {
    mountMotion(null);
    expect(body().kids).toHaveLength(0);
    webdriver = true; logo();
    mountMotion(null);
    expect(body().kids).toHaveLength(0);
    webdriver = false;
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    mountMotion(null);
    expect(body().kids).toHaveLength(1);
  });
  it("fails open when animate throws halfway", () => {
    logo();
    El.throwOnAnimate = true;
    mountMotion(null);
    expect(body().kids).toHaveLength(1);
    vi.advanceTimersByTime(3400); // the fill ends, the fly calls animate, it throws
    expect(body().kids).toHaveLength(0);
    expect(docEl().style.overflow).toBe("");
  });
  it("the hard timeout removes the overlay and restores scroll even if the frames never run", () => {
    logo();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    docEl().style.overflow = "scroll";
    mountMotion(null);
    expect(docEl().style.overflow).toBe("hidden");
    vi.advanceTimersByTime(5900);
    expect(body().kids).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(body().kids).toHaveLength(0);
    expect(docEl().style.overflow).toBe("scroll");
  });
  it("cleanup mid-flight removes the overlay and starts nothing new", () => {
    logo();
    const stop = mountMotion(null);
    vi.advanceTimersByTime(1000);
    stop();
    expect(body().kids).toHaveLength(0);
    expect(docEl().style.overflow).toBe("");
    vi.advanceTimersByTime(7000);
    expect(io).toBeUndefined();
  });
});

describe("scroll-to-top button", () => {
  it("shows after 300px, draws progress, scrolls instantly with reduced motion, and cleans up", () => {
    reduce = true;
    const btn = new El(), bar = new El();
    btn.qs[".mo-bar"] = bar;
    docEl().rect = { top: 0, left: 0, width: 0, height: 0 };
    Object.assign(docEl(), { scrollHeight: 2000 });
    const stop = mountMotion(btn as never);
    expect(btn.attrs.has("data-on")).toBe(false);
    vi.stubGlobal("scrollY", 600);
    listeners.get("scroll")!();
    expect(btn.attrs.has("data-on")).toBe(true);
    expect(Number(bar.style.strokeDashoffset)).toBeCloseTo(2 * Math.PI * 22 * (1 - 600 / 1200));
    stop();
    expect(listeners.has("scroll")).toBe(false);
  });
});

describe("server HTML", () => {
  it("is a real labelled button and carries no overlay and nothing hidden", () => {
    const h = html(<Motion />);
    expect(h).toMatch(/^<button[^>]*type="button"[^>]*aria-label="Back to top"/);
    expect(h).not.toMatch(/mo-pre|data-rv| style=|[^-]hidden/);
  });
});

describe("security", () => {
  const src = readFileSync(new URL("./motion.tsx", import.meta.url), "utf8");
  it("builds DOM nodes only: no innerHTML, eval, outside origin, cookie or other storage", () => {
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|eval\(|new Function|document\.write|document\.cookie|localStorage|fetch\(|sendBeacon/);
    expect([...src.matchAll(/https?:\/\/[^'"`\s)]+/g)].map((m) => m[0])).toEqual(["http://www.w3.org/2000/svg"]); // the data: SVG's namespace, not a request
    expect([...src.matchAll(/sessionStorage\.(\w+)\(([^)]*)\)/g)].map((m) => m[2])).toEqual(["FLAG", "FLAG, \"1\""]);
  });
});
