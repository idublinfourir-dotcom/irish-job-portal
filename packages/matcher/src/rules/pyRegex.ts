// Turns a Python `re` pattern (str, Unicode) into a JavaScript RegExp that matches the same text.
// JavaScript's \b \w \s \d and `.` differ from Python's even with the `u` flag (PORT-MAP F6):
//   \w  Python: letters, digits of any script, "_"  (str.isalnum)
//   \s  Python: str.isspace (adds U+001C to U+001F and U+0085, drops U+FEFF)
//   \d  Python: any decimal digit
//   .   Python: anything but "\n" (JavaScript also excludes "\r", U+2028, U+2029)
// Only the escapes the matcher's patterns use are handled; anything else is passed through.

const WORD = String.raw`\p{L}\p{N}_`;
const SPACE = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　`;
const DIGIT = String.raw`\p{Nd}`;
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;

export function pyRegex(source: string, ignoreCase = false): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[++i];
      if (next === "b" && !inClass) out += BOUNDARY;
      else if (next === "w") out += inClass ? WORD : `[${WORD}]`;
      else if (next === "s") out += inClass ? SPACE : `[${SPACE}]`;
      else if (next === "d") out += inClass ? DIGIT : `[${DIGIT}]`;
      else out += ch + next;
    } else if (ch === "[" && !inClass) {
      inClass = true;
      out += ch;
    } else if (ch === "]" && inClass) {
      inClass = false;
      out += ch;
    } else if (ch === "." && !inClass) out += "[^\\n]";
    else out += ch;
  }
  return new RegExp(out, ignoreCase ? "iu" : "u");
}
