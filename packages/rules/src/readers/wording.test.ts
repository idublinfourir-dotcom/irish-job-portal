import { describe, expect, test } from "vitest";
import { noSponsorshipPhrase, scamWording, sponsorshipAvailable } from "./index";

describe("R04 noSponsorshipPhrase", () => {
  test.each([
    ["We do not offer visa sponsorship", "do not offer visa sponsorship"],
    ["Sorry, cannot provide a work permit", "cannot provide a work permit"],
    ["Visa sponsorship is not available", "Visa sponsorship is not"],
    ["visa sponsorship unavailable", "visa sponsorship unavailable"],
    ["Applicants without sponsorship", "without sponsorship"],
    ["without the need for employment permit", "without the need for employment permit "],
    ["You must already have the right to work", "must already have the right to work"],
    ["must hold a valid right to work", "must hold a valid right to work"],
    ["Full right to work in Ireland is required", "Full right to work in Ireland is required"],
    ["Valid authorisation to work in the EU", "Valid authorisation to work in the EU"],
    ["Stamp 4 holders", "Stamp 4"],
    ["EU citizens only", "EU citizens only"],
    ["EU/EEA nationals only", "EU/EEA nationals only"],
    ["won't be able to consider any visa", "won't be able to consider any visa"],
    ["do not one two three four offer visa", "do not one two three four offer visa"],
    ["unable to offer 1 2 3 work permit", "unable to offer 1 2 3 work permit"],
  ])("finds the phrase in %j", (text, phrase) => {
    expect(noSponsorshipPhrase(text, "")).toBe(phrase);
  });

  test("returns null when no phrase is there", () => {
    expect(noSponsorshipPhrase("Engineer", "Great team, great pay")).toBeNull();
    expect(noSponsorshipPhrase("", "We can sponsor visas")).toBeNull();
    expect(noSponsorshipPhrase("", "do not very very very very very offer visa")).toBeNull(); // five words between: over the limit of four
    expect(noSponsorshipPhrase("", "unable to offer 1 2 3 4 work permit")).toBeNull(); // four words after: over the limit of three
  });

  test("reads the title as well as the description", () => {
    expect(noSponsorshipPhrase("EU citizens only", "x")).toBe("EU citizens only");
    expect(noSponsorshipPhrase("Engineer", "no sponsorship available here")).toBeNull(); // "no" then "sponsorship" needs a verb first
  });

  test("ignores letter case", () => {
    expect(noSponsorshipPhrase("", "visa sponsorship is NOT available")).toBe("visa sponsorship is NOT");
  });

  test("the dotted capital I matches i, as Python's ignore-case does", () => {
    expect(noSponsorshipPhrase("", "VİSA sponsorship is not available")).toBe("VİSA sponsorship is not");
  });

  test("known quirk: the word 'no' can start the phrase inside a longer word", () => {
    expect(noSponsorshipPhrase("", "Casino noticing support visa")).toBe("no noticing support visa");
  });

  test("known quirk: a bare 'NO VISA SPONSORSHIP' does not match (it needs a verb between)", () => {
    expect(noSponsorshipPhrase("", "NO VISA SPONSORSHIP")).toBeNull();
  });
});

describe("R05 sponsorshipAvailable", () => {
  test.each(["visa sponsorship available", "Immigration sponsorship will be offered", "we will sponsor", "We DO sponsor", "Sponsorship available", "Critical Skills Employment Permit holders", "permit sponsorship considered"])(
    "true for %j",
    (text) => expect(sponsorshipAvailable(text)).toBe(true),
  );
  test("false for plain wording", () => {
    expect(sponsorshipAvailable("We sponsor")).toBe(false);
    expect(sponsorshipAvailable("")).toBe(false);
  });
});

describe("R06 scamWording", () => {
  test.each(["pay a small fee", "send us a deposit", "Registration fee required", "visa fee payable by candidate", "Visa fee is payable by the candidate"])("true for %j", (text) =>
    expect(scamWording(text)).toBe(true),
  );
  test("false when the words are too far apart or absent", () => {
    expect(scamWording("transfer one two three a processing charge")).toBe(false); // four words between: over the limit of three
    expect(scamWording("pay a b c d fee")).toBe(false);
    expect(scamWording("no fee")).toBe(false);
  });
});
