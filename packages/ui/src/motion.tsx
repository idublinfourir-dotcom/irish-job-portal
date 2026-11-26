"use client";
// FM1 page motion: scroll reveals, count-up, the once-a-session preloader and intro, the scroll-to-top button. Web Animations API plus motion.css, no library.
// Everything is added by JS after mount; the server HTML holds the final text and no hidden element. It always fails open: whatever throws, the overlay goes and scroll returns.
import { useEffect, useRef } from "react";

const EASE = "cubic-bezier(.23,1,.32,1)";
const FLAG = "portal-pre";
const FILL = 2800, SETTLE = 450, FLY = 900, HARD = 6000;
const LOGO = 'a[aria-label$=", home"]';
const RISE = [{ opacity: 0, transform: "translateY(28px) scale(.97)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }];
const fillAt = (t: number) => (t < 0.72 ? 0.8 * (1 - (1 - t / 0.72) ** 2) : 0.8 + 0.2 * ((u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2))((t - 0.72) / 0.28));
const wave = (a: number) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='120' height='400'><path d='M0 12 Q30 ${12 - a} 60 12 T120 12 V400 H0Z'/></svg>`)}")`;
const media = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;

/** "€40,904" at progress p (0 to 1) of a count-up, ease-out quart; null when the text holds no number. */
export function countText(orig: string, p: number): string | null {
  const m = /^(\D*)(\d[\d,]*)(.*)$/s.exec(orig);
  if (!m) return null;
  return m[1] + Math.round(Number(m[2]!.replace(/,/g, "")) * (1 - (1 - p) ** 4)).toLocaleString("en-IE") + m[3];
}

/** Wires the page and returns the cleanup. `btn` is the scroll-to-top button. */
export function mountMotion(btn: HTMLButtonElement | null): () => void {
  const root = document.documentElement;
  const reduce = media("(prefers-reduced-motion: reduce)");
  const offs: (() => void)[] = [];
  const anims: Animation[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const counted = new Map<Element, string>();
  let raf = 0, io: IntersectionObserver | undefined, overlay: HTMLElement | undefined, locked: string | undefined, started = false;

  const play = (el: Element, kf: Keyframe[], ms: number, delay = 0, easing = EASE) => {
    const a = el.animate(kf, { duration: ms, delay, easing, fill: "both" });
    anims.push(a);
    void a.finished.then(() => a.cancel(), () => {}); // the end frame equals the static page, so drop the fill and let CSS hover work again
    return a;
  };
  const later = (fn: () => void, ms: number) => { timers.push(setTimeout(fn, ms)); };

  const countUp = (el: Element, delay: number) => {
    const orig = counted.get(el) ?? el.textContent ?? "";
    counted.set(el, orig);
    if (countText(orig, 1) === null) return;
    el.textContent = countText(orig, 0);
    later(() => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / 1100);
        el.textContent = p < 1 ? countText(orig, p) : orig;
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
  };

  // Scroll reveals and count-ups: one observer. Anything already in the viewport (or taller than 5 screens, which .12 could never reach) is left alone.
  const startScroll = () => {
    if (started || reduce || typeof IntersectionObserver !== "function") return;
    started = true;
    const all = [...document.querySelectorAll<HTMLElement>("main section, main h2, [data-lift]")];
    const blocks = all.filter((el) => !all.some((p) => p !== el && p.contains(el)));
    const counters = [...document.querySelectorAll("[data-count]")];
    const hide = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top >= innerHeight && r.height <= innerHeight * 5;
    };
    io = new IntersectionObserver((entries) => {
      entries.filter((e) => e.isIntersecting).forEach((e, i) => {
        io?.unobserve(e.target);
        const delay = Math.min(i, 6) * 70;
        if (e.target.hasAttribute("data-count")) return countUp(e.target, delay);
        e.target.removeAttribute("data-rv");
        play(e.target, RISE, 750, delay);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });
    blocks.filter(hide).forEach((el) => { el.setAttribute("data-rv", ""); io?.observe(el); });
    counters.forEach((el) => io?.observe(el));
  };

  const intro = () => {
    const head = document.querySelector("header");
    if (head) play(head, [{ opacity: 0, transform: "translateY(-10px) scale(.985)" }, { opacity: 1, transform: "none" }], 600);
    const h1 = document.querySelector("h1");
    if (h1) play(h1, [{ opacity: 0 }, { opacity: 1 }], 200, 80);
  };

  const finish = () => {
    timers.forEach(clearTimeout);
    cancelAnimationFrame(raf);
    overlay?.remove();
    overlay = undefined;
    if (locked !== undefined) { root.style.overflow = locked; locked = undefined; }
    startScroll();
  };

  // Preloader: water fills the logo, settles, then the logo flies onto the real one. Once per browser session.
  const preload = () => {
    if (reduce || navigator.webdriver) return false;
    const real = [...document.querySelectorAll<HTMLElement>(LOGO)].find((a) => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (!real) return false;
    try { if (sessionStorage.getItem(FLAG)) return false; sessionStorage.setItem(FLAG, "1"); } catch { /* storage blocked: run it every load, harmless */ }
    const guard = (fn: () => void) => () => { try { fn(); } catch { finish(); } };
    try {
      const mk = document.createElement("div");
      mk.className = "mo-mk";
      const copy = (cls: string) => {
        const c = real.cloneNode(true) as HTMLElement;
        c.removeAttribute("href"); c.removeAttribute("aria-label"); c.setAttribute("aria-hidden", "true"); c.className += ` ${cls}`; // keep the logo's own font classes
        c.style.display = "block";
        return c;
      };
      const base = copy("mo-base"), fill = copy("mo-fill");
      mk.append(base, fill);
      overlay = document.createElement("div");
      overlay.className = "mo-pre";
      overlay.setAttribute("aria-hidden", "true");
      overlay.append(mk);
      document.body.append(overlay);
      locked = root.style.overflow;
      root.style.overflow = "hidden";
      timers.push(setTimeout(finish, HARD)); // the hard stop, whatever else happens
      scrollTo(0, 0);
      const K = 2.6;
      mk.style.transform = `translate(0px,0px) scale(${K})`;
      const H = fill.offsetHeight, t0 = performance.now();
      let lastA = -1;
      const step = (now: number) => guard(() => {
        const el = now - t0, p = fillAt(Math.min(1, el / FILL));
        const amp = Math.round((4 + 6 * (1 - p)) * (1 - Math.min(1, Math.max(0, (el - FILL) / SETTLE))) * 2) / 2;
        if (amp !== lastA) { fill.style.webkitMaskImage = fill.style.maskImage = wave(amp); lastA = amp; }
        fill.style.webkitMaskPosition = fill.style.maskPosition = `${(el * 0.07) % 60}px ${(H + 7) * (1 - p) - 7 * p - 6}px`;
        if (el < FILL + SETTLE) raf = requestAnimationFrame(step); else fly();
      })();
      const fly = () => {
        if (!overlay) return;
        const o = overlay, t = real.getBoundingClientRect(), m = mk.getBoundingClientRect();
        base.style.opacity = "0";
        const to = `translate(${t.left - m.left}px,${t.top - m.top}px) scale(1)`;
        play(mk, [{ transform: `translate(0px,0px) scale(${K})` }, { transform: to }], FLY, 0, "cubic-bezier(.76,0,.24,1)");
        mk.style.transform = to;
        play(o, [{ backgroundColor: getComputedStyle(o).backgroundColor }, { backgroundColor: "transparent" }], FLY * 0.75, FLY * 0.2);
        o.style.background = "transparent";
        later(guard(() => { intro(); startScroll(); root.style.overflow = locked ?? ""; }), FLY * 0.25);
        later(finish, FLY + 30);
      };
      raf = requestAnimationFrame(step);
    } catch { finish(); }
    return true;
  };

  if (btn) {
    const bar = btn.querySelector<SVGCircleElement>(".mo-bar")!, C = 2 * Math.PI * 22;
    bar.style.strokeDasharray = String(C);
    const onScroll = () => {
      const max = root.scrollHeight - innerHeight;
      bar.style.strokeDashoffset = String(C * (1 - (max > 0 ? scrollY / max : 0)));
      if (scrollY > 300) btn.setAttribute("data-on", ""); else btn.removeAttribute("data-on");
    };
    const onClick = () => scrollTo({ top: 0, behavior: reduce ? "instant" : "smooth" });
    addEventListener("scroll", onScroll, { passive: true });
    btn.addEventListener("click", onClick);
    onScroll();
    offs.push(() => removeEventListener("scroll", onScroll), () => btn.removeEventListener("click", onClick));
  }

  if (!preload()) startScroll(); // with the preloader, the scroll layer starts at the fly

  return () => {
    started = true; // no new observer after cleanup
    finish();
    anims.forEach((a) => a.cancel());
    io?.disconnect();
    counted.forEach((txt, el) => { el.textContent = txt; });
    document.querySelectorAll("[data-rv]").forEach((el) => el.removeAttribute("data-rv"));
    offs.forEach((f) => f());
  };
}

/** The scroll-to-top button; mounts the whole motion layer. Put once in each app's root layout. */
export function Motion() {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => mountMotion(btn.current), []);
  return (
    <button ref={btn} type="button" aria-label="Back to top" className="mo-stt">
      <svg className="mo-ring" viewBox="0 0 48 48" aria-hidden="true">
        <circle className="mo-trk" cx="24" cy="24" r="22" fill="none" strokeWidth="2" />
        <circle className="mo-bar" cx="24" cy="24" r="22" fill="none" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="mo-in">
        <svg viewBox="0 0 18 18" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 11l5-5 5 5" /></svg>
      </span>
    </button>
  );
}
