// Helpers that make a JavaScript regular expression behave like Python's `re` on text (PORT-MAP F6).
// Python's \d, \w, \s and \b know Unicode; JavaScript's do not, so they are rewritten here.

const WORD = String.raw`\p{L}\p{N}_`; // Python \w: letters, numbers, underscore
const SPACE = String.raw`\t-\r\x1c-\x1f \x85\xa0  -     　`; // Python \s (str.isspace)
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`; // Python \b

/** Build a RegExp from a Python pattern: \d, \w, \s and \b get their Unicode meaning. Always uses the `u` flag. */
export function py(source: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      const next = source[++i]!;
      if (next === "d") out += String.raw`\p{Nd}`;
      else if (next === "w") out += inClass ? WORD : `[${WORD}]`;
      else if (next === "s") out += inClass ? SPACE : `[${SPACE}]`;
      else if (next === "b") out += BOUNDARY;
      else out += ch + next;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    // Python's ignore-case also matches the dotted capital I (U+0130) and dotless i (U+0131) to i; JavaScript's does not.
    out += flags.includes("i") && (ch === "i" || ch === "I") ? (inClass ? "iI\u0130\u0131" : "[iI\u0130\u0131]") : ch;
  }
  return new RegExp(out, flags + "u");
}

/** Python `s[:n]`: the first n code points (JavaScript slices count UTF-16 units). */
export function cpHead(s: string, n: number): string {
  const t = s.slice(0, n);
  return !/[\ud800-\udfff]/.test(t) ? t : Array.from(s.slice(0, 2 * n)).slice(0, n).join("");
}

/** The last n code points of s. */
export function cpTail(s: string, n: number): string {
  const t = s.slice(-n);
  return !/[\ud800-\udfff]/.test(t) ? t : Array.from(s.slice(-2 * n)).slice(-n).join("");
}

export function cpLength(s: string): number {
  return Array.from(s).length;
}

/** Python `int()` and `float()` accept every Unicode decimal digit: turn them into 0 to 9. */
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (d) => {
    let steps = 0; // Unicode digits come in runs of ten starting at zero
    for (let cp = d.codePointAt(0)! - 1; /\p{Nd}/u.test(String.fromCodePoint(cp)); cp--) steps++;
    return String(steps % 10);
  });
}

/** Python `str.strip()`. */
export function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu"), "");
}
