import { pyRegex } from "../employers/py-text";

// R02. Python: prototype/classify.py:12 (the list), used at classify.py:209 (`IRL.search(j.get("location", ""))`).
// One of four different place lists in the Python (PORT-MAP section 2): do not merge with the others.
const IRL = pyRegex(
  String.raw`\b(ireland|irl|dublin|cork|galway|limerick|shannon|waterford|kildare|meath|wicklow|westmeath|athlone|sligo|kinsale|leixlip|clonmel|letterkenny|donegal|drogheda|louth|dundalk|kilkenny|wexford|carlow|kerry|tralee|clare|ennis|naas|swords|tipperary|mayo|castlebar|roscommon|longford|cavan|monaghan|offaly|laois|leitrim|portlaoise|tullamore|mullingar|navan|bray)\b`,
  "i",
);

/** R02: does the location text look Irish (coarse)? Empty counts as not Irish. */
export const locationLooksIrish = (location: string): boolean => IRL.test(location);

// NEW BEHAVIOUR (decision #149, 11 November 2026): a job counts as in Ireland only when it is based in Ireland only.
// There is no Python line for this. The words are the ones the 1,303 saved adverts use in `location`, plus the obvious
// neighbours. Northern Ireland is the UK for this permit, so it is foreign here even though it contains "ireland".
// A code like FRA only counts straight after a comma, as Workday writes "Bernin,FRA", so it cannot match a plain word.
const FOREIGN = pyRegex(
  String.raw`\b(uk|united kingdom|great britain|england|scotland|wales|northern ireland|ni|belfast|derry|londonderry|newry|armagh|antrim|london|edinburgh|glasgow|manchester|birmingham|watford|paisley|hemel hempstead|usa|united states|united states of america|america|canada|massachusetts|minnesota|texas|georgia|ontario|north carolina|quincy|boston|atlanta|austin|toronto|new york|san francisco|seattle|chicago|reston|durham|france|germany|spain|italy|netherlands|belgium|luxembourg|poland|portugal|switzerland|austria|sweden|denmark|norway|finland|czechia|czech republic|hungary|romania|bulgaria|serbia|greece|israel|china|hong kong|india|singapore|japan|australia|paris|berlin|madrid|barcelona|milan|milano|rome|amsterdam|brussels|frankfurt|munich|hamburg|dresden|prague|warsaw|budapest|vienna|zurich|stockholm|copenhagen|lisbon|eindhoven|nijmegen|grenoble|bernin|treviso|villach|zwolle|hoofddorp|thessaloniki|kiryat gat)\b|,(gbr|usa|fra|deu|ita|nld|bel|esp|prt|che|aut|pol|swe|dnk|cze|hun|isr|chn|ind|sgp|jpn|can|aus)\b`,
  "i",
);

/** Decision #149: the location names an Irish place and no place outside Ireland. Empty counts as no. */
export const locationIsIrelandOnly = (location: string): boolean => IRL.test(location) && !FOREIGN.test(location);

// NEW BEHAVIOUR (#149): the advert says the post itself can be based elsewhere: "This role can be based in Dublin or London",
// "This role is located in Dublin, Ireland or London, United Kingdom". The place outside Ireland must come after an "or" in the
// same sentence, so "our offices in London and Dublin" or "you will travel to London" do not match.
// ponytail: a list on the next lines ("can be based in any of the following offices:") is not read.
const POST_BASED = pyRegex(
  "\\b(?:role|position|job|post) (?:(?:can|may|could) (?:also )?be|is) (?:based|located) (?:in|at|out of) [^.\n]{0,150}? or ([^.\n]{0,150})",
  "ig",
);

/** Decision #149: does the advert text say the post can be based outside Ireland? */
export const postBasedElsewhere = (description: string): boolean => {
  for (const m of description.matchAll(POST_BASED)) if (FOREIGN.test(m[1]!)) return true;
  return false;
};
