// FM1 first-visit cover: a plain cream cover in the server HTML, hidden by default. The inline script shows it from the first paint
// when the preloader will run (no `portal-pre` flag, motion allowed, not a webdriver), so the page never flashes before the overlay.
// Fails open: no JS or a script error leaves it hidden; Motion clears it on mount; motion.css hides it after 6 s whatever happens.
// The script is a fixed string, no outside input; React writes a script child as raw text, so no raw HTML prop is needed.
export const PRE_SCRIPT = `try{if(!sessionStorage.getItem("portal-pre")&&!navigator.webdriver&&!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.setAttribute("data-pre","")}catch(e){}`;

/** Put first in each app's root <body>, before the shell. */
export function PreCover() {
  return (
    <>
      <script>{PRE_SCRIPT}</script>
      <div className="mo-cover" hidden aria-hidden="true" />
    </>
  );
}
