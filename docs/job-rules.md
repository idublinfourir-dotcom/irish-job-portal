# Job rules, matcher and sources

The map of the code that decides whether an advert may be shown as a Critical Skills job: where each rule lives, the order the rules run in, and how they are proven. Read it before you change a rule, the matcher or a source adapter. Words follow `GLOSSARY.md`. Numbers like #95 are entries in the decision log.

This code is a port of a Python prototype that ran on real adverts from 5 November 2026 and was hand-checked. It behaves exactly like the Python on purpose, quirks included. Every known quirk has a test whose name starts with `known quirk:`. Fixing a quirk is a product change: do it alone, name its decision, and expect that test to change.

## Packages

| Package | What it does | Main exports |
|---|---|---|
| `@portal/sources` | One adapter per kind of job site. Each returns adverts in one shape (`RawAdvert`) | `fetchGreenhouse`, `fetchAshby`, `fetchSmartRecruiters`, `fetchWorkday`, `fetchAmazon`, the type `SourceAdapter` |
| `@portal/matcher` | Reads a title and advert text and gives the occupation code, whether it is on the Critical Skills list, and a confidence | `rulesMatcher`, `TITLE_RULES`, the type `Matcher` |
| `@portal/rules` | The readers (salary, contract, wording, doctor grades), the employer code (name cleaning, big-company brand, agency, public pay tier, duplicate keys, name suggestion), the Irish check, and the decision chain | `assess`, `INPUT_LIMITS`, and each reader |

No package here touches the database or the network. An adapter is given the fetch function, the board and the ids already known, and returns every id it saw plus full records for the new ones. It throws `FetchFailedError` when a fetch failed and returns empty lists when a board is truly empty: the difference decides later whether jobs may be closed.

## The order of the rules (`assess` in `packages/rules/src/chain`)

`assess(advert, data)` takes one advert and the data the rules need (the cleaned DETE employer names, the public pay-deal names, the matcher) and returns one `Assessment`: a stage, a bucket and what was read. The order is part of the behaviour.

1. **Input limits.** An advert over a limit (title 300, employer 200, location 500, employment type 100, salary box 1,000, description 30,000, counted in code points) is not assessed and gets the stage `0 advert too long (admin queue)`. This is the one thing the Python does not do. Adverts are untrusted text, and three ported patterns slow down with the square of the input length.
2. Flags: agency by name, "sponsorship available", scam wording (a request for money from the candidate: "pay a fee", "send a deposit", "registration fee"). A match is dropped when it is an employer's own warning against scams ("we will never ask candidates to pay a fee", "against our policy", "no agency will ask") or a benefit ("registration fees paid"): on 10 November 2026 the plain pattern matched 101 of 1,310 saved adverts and every one was such a warning or a benefit. The chain itself does nothing with the flag; the fetcher sends a flagged advert that would pass to the admin queue.
3. Location looks Irish, or stage `3 not in Ireland`.
4. "No sponsorship" wording, or stage `4`.
5. Occupation from the matcher: not recognised is stage `5`, not on the list is stage `6`, low confidence is the admin queue. "Not on the list" is tested before "low confidence".
6. Contract length: under 2 years is stage `7`, unclear is the admin queue.
7. Salary: below the minimum, a range crossing it, or none stated without a big-company brand, each stage `8`. Otherwise a pass.
8. A test posting overrides all of the above (stage `0 test posting`).
9. The Irish employer check by evidence, skipped when the stage already starts with `3` or `4`. "Unsure" goes to the admin queue only for a pass or a stage `8`.
10. Doctor grades with no 2 years stated, and "permanent / specified purpose" (#95), for a pass or a stage `8`.
11. The public pay tier, the bucket, whether an AI step would read the advert, and the sector.

## Rules data still in code

The salary minimum (40,904, a parameter with that default), the big-company brand list, the place lists, the wording patterns and the 66 title rules are constants beside the rule that uses them, each with the Python line it came from. They move to rules tables in a later step. Those tables are not designed yet.

## How it is proven

- **Repo tests** (part of `npm run check`): made-up text only, every branch, every known quirk, a time budget per package, and hostile input (1 MB adverts, very long lines, odd Unicode, script tags, lying page counts, redirects to another host).
- **Parity runs** (not part of `npm run check`): each package has a `*.parity.ts` test that runs our code and compares it with the Python's own output on 1,310 saved real adverts, field by field. On 10 November 2026 every one showed 0 differences. They need the private data folder, named by the environment variable `PORTAL_PRIVATE_DATA`, and fail with a clear message without it. The saved adverts are other sites' text, so they stay on the engineer's machine and never enter this repo. Run one with `npx vitest run --config packages/rules/src/chain/vitest.parity.config.ts` (the other configs are beside the readers, the employer code, the matcher rules and the adapters).
- **Fixtures for the adapters** have the structure of real responses, recorded once, with every text value replaced by made-up text.

## Known limits

- A description of 30,000 digits still takes about 0.9 seconds in the salary reader. The limit bounds it. Making the pattern itself fast changes behaviour, so it waits for a decision.
- Titles, locations and Ashby descriptions are not stripped of HTML, as in the Python. Whoever shows them on a page must escape them.
- Not ported: Lever, Workable and Recruitee (no board uses them) and LinkedIn (it refused every run of the prototype).
- Not built yet: the AI step of the matcher and its 98% test, the rules tables, the fetcher that writes adverts to the database, and the importers for the government files.
- Three packages each carry their own small helper that gives a JavaScript pattern Python's meaning (`readers/pyre.ts`, `employers/py-text.ts`, `matcher/src/rules/pyRegex.ts`). One shared copy would do.
