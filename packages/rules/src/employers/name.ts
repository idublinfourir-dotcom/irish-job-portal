import { pyRegex } from "./py-text";

// R15 name cleaning. Python: prototype/classify.py:180-183. NOT the same as the database's `normalised_name`
// (PORT-MAP 5.4): this drops brackets and suffix words such as "ltd", "ireland" and "group".
// Applied after lower-casing and stripping everything but a-z, 0-9 and space, so no ignore-case flag.
const SUFFIX_WORDS = pyRegex(
  String.raw`\b(unlimited company|designated activity company|limited|ltd|uc|dac|clg|plc|llp|sarl|se|company|ireland|irish|emea|europe|international|holdings?|group|services|the|inc|corporation|corp|llc|gmbh|bv)\b`,
  "g",
);

/** Python `norm`. */
export function cleanEmployerName(name: string): string {
  // Python's `.` skips only "\n"; JS `.` also skips "\r", U+2028 and U+2029, so spell it out.
  const noBrackets = name.toLowerCase().replaceAll("&", "and").replace(/\([^\n]*?\)/gu, " ");
  return noBrackets
    .replace(/[^a-z0-9 ]/gu, " ")
    .replace(SUFFIX_WORDS, " ")
    .split(" ")
    .filter(Boolean)
    .join(" ");
}
