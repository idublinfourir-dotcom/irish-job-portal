// Not in forms.tsx: the help page reads these on the server, where a value of a "use client" file is an empty proxy and a call throws (a 500).
export const TOPICS: Record<string, string> = {
  general: "A question about the site",
  account: "My account or company",
  data_request: "My data: export or erase",
  other: "Something else",
  appeal: "My login is blocked or my account was banned",
};
/** The topics each kind of sender may pick: an active login not `appeal`, a visitor only `appeal`. */
export const topicsFor = (signedIn: boolean) => (signedIn ? ["general", "account", "data_request", "other"] : ["appeal"]);
