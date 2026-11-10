import { describe, expect, test } from "vitest";
import { noSponsorshipPhrase, scamPatternPython, scamWording, sponsorshipAvailable } from "./index";

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

describe("R04 noSponsorshipPhrase: an EU member state national is required (NEW BEHAVIOUR, 10 Nov 2026)", () => {
  test.each([
    "This role requires you to be a national of an EU member state",
    "This role requires you to be a national of an EU Member state.",
    "Candidate must be a national of an EU member state and residing in the EU",
    "Applicants need to be citizens of the European Union",
    "You are required to be an EEA national? No: you must be a citizen of the EEA",
    "THIS POST REQUIRES THE HOLDER TO BE A CITIZEN OF THE EU",
  ])("finds a phrase in %j", (text) => {
    expect(noSponsorshipPhrase("", text)).not.toBeNull();
  });
  test("the matched phrase is the requirement itself", () => {
    expect(noSponsorshipPhrase("", "Note: this role requires you to be a national of an EU member state.")).toBe("requires you to be a national of an EU");
  });
  test.each([
    "We welcome applicants who are a national of any country",
    "Our team includes a national of an EU member state",
    "Nationals of the EU are welcome to apply",
    "You must be a good citizen of the team",
    "The role requires one more thing and then four words before to be a national of the EU",
    "must be a national of Ireland",
  ])("does not find a phrase in %j", (text) => {
    expect(noSponsorshipPhrase("", text)).toBeNull();
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

  // NEW BEHAVIOUR, not in the Python (10 November 2026). The Python's pattern matched 101 of 1,303 saved adverts and every one was
  // an employer's own warning against scams (100) or a benefit (1). Made-up text below, in the shapes those adverts had.
  test.each([
    "Fake Corp will never ask applicants to pay a hiring fee.",
    "It is strictly against Fake Corp policy for applicants to pay any fee to take part.",
    "We do not ask candidates to send a deposit at any stage.",
    "You won\u2019t be asked to pay a fee, and you don't need to transfer a deposit.",
    "There is no registration fee.",
    "No hiring agency that works with Fake & Sons will ask applicants to pay a fee at any time.",
    "Benefits: professional registration fees paid, pension, parking.",
    "Your registration fee is covered by the clinic.",
  ])("a warning against scams, or a benefit, is not scam wording: %j", (text) => expect(scamWording(text)).toBe(false));
  test.each([
    "You will not be considered unless you pay a processing charge.", // "not ... unless" is a demand
    "We never close. Send us a deposit today.", // the negation is in another sentence
    "No experience needed, just pay a small fee to start.", // "no" is about something else
    "Do not delay: pay the fee today.",
    "We will never ask you to pay a fee by phone. To confirm your place, transfer a deposit of 100 euro.", // a warning first, a demand later
    "A registration fee of 50 euro is paid by the candidate.",
    "The registration fee is paid by the applicant before the interview.",
  ])("a demand for money is still scam wording: %j", (text) => expect(scamWording(text)).toBe(true));
  test("hostile text: a megabyte of warnings, of demands, or of half sentences is read in time and never throws", () => {
    const cases = [
      "Fake Corp will never ask applicants to pay a hiring fee. ".repeat(18_000), // every match is a warning: nothing returns early
      "pay a fee ".repeat(100_000),
      "no ".repeat(300_000) + "pay a fee", // "no" right before the match reads as "no fee": not flagged
      "registration fee" + "s".repeat(1_000_000),
      "never " + "x".repeat(1_000_000) + " pay a fee\0",
    ];
    const t0 = performance.now();
    expect(cases.map(scamWording)).toEqual([false, true, false, true, true]);
    expect(performance.now() - t0).toBeLessThan(1000); // measured about 25 ms for all five
  });
  test("the Python's own test is kept as it was, for the parity run", () => {
    expect(scamPatternPython("Fake Corp will never ask applicants to pay a hiring fee.")).toBe(true);
    expect(scamPatternPython("no fee")).toBe(false);
  });
});
