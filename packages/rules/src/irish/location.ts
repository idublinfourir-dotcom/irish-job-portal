import { pyRegex } from "../employers/py-text";

// R02. Python: prototype/classify.py:12 (the list), used at classify.py:209 (`IRL.search(j.get("location", ""))`).
// One of four different place lists in the Python (PORT-MAP section 2): do not merge with the others.
const IRL = pyRegex(
  String.raw`\b(ireland|irl|dublin|cork|galway|limerick|shannon|waterford|kildare|meath|wicklow|westmeath|athlone|sligo|kinsale|leixlip|clonmel|letterkenny|donegal|drogheda|louth|dundalk|kilkenny|wexford|carlow|kerry|tralee|clare|ennis|naas|swords|tipperary|mayo|castlebar|roscommon|longford|cavan|monaghan|offaly|laois|leitrim|portlaoise|tullamore|mullingar|navan|bray)\b`,
  "i",
);

/** R02: does the location text look Irish (coarse)? Empty counts as not Irish. */
export const locationLooksIrish = (location: string): boolean => IRL.test(location);
