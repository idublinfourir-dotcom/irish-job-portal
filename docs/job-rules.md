# Job rules, matcher, sources and fetcher

The map of the code that finds adverts, decides whether one may be shown as a Critical Skills job, and saves the result: where each rule lives, the order the rules run in, what the fetcher writes, and how it is all proven. Read it before you change a rule, the matcher, a source adapter or the fetcher. Words follow `GLOSSARY.md`. Numbers like #95 are entries in the decision log.

The rules, the rules matcher and the adapters are a port of a Python prototype that ran on real adverts from 5 November 2026 and was hand-checked. That code behaves exactly like the Python on purpose, quirks included. Every known quirk has a test whose name starts with `known quirk:`. Fixing a quirk is a product change: do it alone, name its decision, and expect that test to change. Where the code now differs from the Python on purpose, a comment starting `NEW BEHAVIOUR` says what was measured (the input limits, the scam wording rule, and three rules found by the gate on 10 November 2026: "must be a national of an EU member state" counts as no sponsorship, maternity cover counts as a contract under two years, and pay written as "€80,000/yr" is read as yearly pay instead of being dropped as a revenue figure). The AI matcher, the gate and the fetcher are new work with no Python behind them.

## Packages

| Package | What it does | Main exports |
|---|---|---|
| `@portal/sources` | One adapter per kind of job site. Each returns adverts in one shape (`RawAdvert`) | `fetchGreenhouse`, `fetchAshby`, `fetchSmartRecruiters`, `fetchWorkday`, `fetchAmazon`, the type `SourceAdapter`, and `runLinkedin` |
| `@portal/matcher` | Reads a title and advert text and gives the occupation code, whether it is on the Critical Skills list, and a confidence | `rulesMatcher`, `TITLE_RULES`, the type `Matcher`, `createAiMatcher`, `chatClient`, `scoreGate` |
| `@portal/rules` | The readers (salary, contract, wording, doctor grades), the employer code (name cleaning, big-company brand, agency, public pay tier, duplicate keys, name suggestion), the Irish check, and the decision chain | `assess`, `INPUT_LIMITS`, and each reader |

| `@portal/fetcher` | Takes adverts from the adapters, runs each through `assess`, and saves the result | `runBoards`, `planAdvert`, `atsTasks`, `hashAdvert` |

Rules, matcher and sources touch neither the database nor the network: every outside thing is passed in. The fetcher is handed a database pool and the boards to read, and only its one entry file reads the environment. An adapter is given the fetch function, the board and the ids already known, and returns every id it saw plus full records for the new ones. It throws `FetchFailedError` when a fetch failed and returns empty lists when a board is truly empty: the difference decides later whether jobs may be closed.

## The order of the rules (`assess` in `packages/rules/src/chain`)

`assess(advert, data)` takes one advert and the data the rules need (the cleaned DETE employer names, the public pay-deal names, the matcher) and returns one `Assessment`: a stage, a bucket and what was read. The order is part of the behaviour.

1. **Input limits.** An advert over a limit (title 300, employer 200, location 500, employment type 100, salary box 1,000, description 30,000, counted in code points) is not assessed and gets the stage `0 advert too long (admin queue)`. This is the one thing the Python does not do. Adverts are untrusted text, and three ported patterns slow down with the square of the input length.
2. Flags: agency by name, "sponsorship available", scam wording (a request for money from the candidate: "pay a fee", "send a deposit", "registration fee"). A match is dropped when it is an employer's own warning against scams ("we will never ask candidates to pay a fee", "against our policy", "no agency will ask") or a benefit ("registration fees paid"): on 10 November 2026 the plain pattern matched 101 of 1,310 saved adverts and every one was such a warning or a benefit. The chain itself does nothing with the flag; the fetcher sends a flagged advert that would pass to the admin queue.
3. Location looks Irish, or stage `3 not in Ireland`. Since decision #149 (11 November 2026) it must be Ireland only: a location that also names a place outside Ireland ("Dublin or London", "Kilkenny / Quincy, Massachusetts") gets no badge, Northern Ireland counts as outside, and so does an advert text that says the post "can be based in Dublin or London". Several Irish places and remote Ireland stay in. The word lists are in `packages/rules/src/irish/location.ts`; the old Python test is kept there as `locationLooksIrish` for the parity run.
4. "No sponsorship" wording, or stage `4`.
5. Occupation from the matcher: not recognised is stage `5`, not on the list is stage `6`, low confidence is the admin queue. "Not on the list" is tested before "low confidence".
6. Contract length: under 2 years is stage `7`, unclear is the admin queue.
7. Salary: below the minimum, a range crossing it, or none stated without a big-company brand, each stage `8`. Otherwise a pass.
8. A test posting overrides all of the above (stage `0 test posting`).
9. The Irish employer check by evidence, skipped when the stage already starts with `3` or `4`. "Unsure" goes to the admin queue only for a pass or a stage `8`.
10. Doctor grades with no 2 years stated, and "permanent / specified purpose" (#95), for a pass or a stage `8`.
11. The public pay tier, the bucket, whether an AI step would read the advert, and the sector.

## The AI matcher and the 98% gate (`packages/matcher/src/ai`, `src/gate`)

The launch gate (#79, #145): of the jobs passed with a Critical Skills badge in a frozen, labelled test set of at least 300 adverts, at least 98% must truly qualify. The share of rejected jobs that were rightly rejected is reported beside it and is not a gate.

- **The AI matcher** (`createAiMatcher`) has the same type as the rules matcher, so the chain can use either. It sends only the title and the description (#119), between markers, cut to a stated length. The model answers with a code, one entry id from the two occupation lists it was given, a confidence and a quote. The code, not the model, decides list membership from that entry, and the answer is checked strictly. A bad answer, a model error or a timeout is never a pass: the advert goes to the admin queue. No model is named in the code: the address, the key and the model id are passed in.
- **The gate** (`scoreGate` and the runner) puts every advert of the test set through the real `assess` and scores the badge. The runner refuses a set that does not match its frozen hash, keeps every model answer so a stopped run goes on later, and writes a report with numbers and ids only. `packages/matcher/src/gate/README.md` has the file formats and the two commands: the rules matcher alone as a baseline (no key, no network), or a model.
- The test set, the occupation lists and the reports live in the private data folder, never in this repo. The labels are made blind, from the advert and the DETE rule texts only (#120).

## The fetcher (`packages/fetcher`)

`runBoards` reads each board, a few at a time, and handles each advert on its own, so one bad advert or board never stops the run. `planAdvert` is the pure part: one assessment becomes the rows to write.

| The chain says | What is saved |
|---|---|
| Passed on stated pay or the big-company rule | A live job with the badge, its text and search data, and the advert row |
| Unsure, public pay, or scam wording on a pass | A job in the admin queue with its text (the database trigger adds the review item) |
| Rejected, or over the input limits | The advert row only: result, stage, short evidence. Never the advert text (#122) |
| The model failed | Nothing. The advert comes back next run |

- **An unknown employer** becomes an unclaimed organisation with an alias name. The name key is computed in SQL with the database's own cleaning, never in TypeScript.
- **A known advert** carries a hash of its text. Seen again with the same hash it costs no write. Changed, it is assessed again: a live job gets its new content, goes back to the admin queue if the rules are now unsure, or closes as `recheck_failed` if it now fails, with its text deleted. Boards whose list call carries the text are compared every run, the others one day in seven.
- **An advert that is gone** from a fetch that worked and returned ids is marked gone, and its live job is closed and its text removed. A failed fetch, or an empty answer from a board with known adverts, closes nothing. An advert that comes back is assessed again, and a job the fetcher closed is reopened if it passes.
- **Staff's jobs are never touched:** a job in review or hidden, or one staff closed, keeps its status and text whatever the advert does.
- Every statement is a constant with parameters, an advert's writes are one transaction, and no network call is made while a transaction is open. The budgets are counted statements, held by tests: 4 a board, 1 a rejected advert, 6 a job with a known employer, 9 with a new one.
- **The real run** is `packages/fetcher/run/laptop.run.ts`, the only file that reads the environment, with its own config so `npm run check` never calls a job board: `FETCHER_DATABASE_URL=... FETCHER_BOARDS_FILE=... PORTAL_PRIVATE_DATA=... npx vitest run --config packages/fetcher/vitest.run.config.ts`. It uses the rules matcher. `docs/database.md` has the tables, the fetcher's rights and the guards that hold them.

## Rules data still in code

The salary minimum (40,904, a parameter with that default), the big-company brand list, the place lists, the wording patterns and the 66 title rules are constants beside the rule that uses them, each with the Python line it came from. They move to rules tables in a later step. Those tables are not designed yet.

## How it is proven

- **Repo tests** (part of `npm run check`): made-up text only, every branch, every known quirk, a time budget per package, and hostile input (1 MB adverts, very long lines, odd Unicode, script tags, lying page counts, redirects to another host).
- **Parity runs** (not part of `npm run check`): each package has a `*.parity.ts` test that runs our code and compares it with the Python's own output on 1,310 saved real adverts, field by field. On 10 November 2026 every one showed 0 differences. After the three gate rules above, the readers run shows 131 differences on the saved adverts (27 adverts with EU national wording, 3 with maternity cover, 14 with pay written as "/yr"), the chain run 38 adverts that differ (115 after the Ireland-only rule #149, which turns away 77 more saved rows: 73 by location, 4 by text), and the made-up run 6,791 differences, all from maternity cover or pay with "/yr"; each was checked to come from one of the three rules. The matcher run still shows 0. They need the private data folder, named by the environment variable `PORTAL_PRIVATE_DATA`, and fail with a clear message without it. The saved adverts are other sites' text, so they stay on the engineer's machine and never enter this repo. Run one with `npx vitest run --config packages/rules/src/chain/vitest.parity.config.ts` (the other configs are beside the readers, the employer code, the matcher rules and the adapters).
- **Fixtures for the adapters** have the structure of real responses, recorded once, with every text value replaced by made-up text.
- **The fetcher** is tested against the real test database as the real role `app_fetcher`, and was run on the real boards on 10 November 2026: 27 of 27 boards, 959 adverts saved in 55 seconds (353 live, 163 in the admin queue, 443 rejected), and a second run that saved nothing new. A later run with the change handling closed one job whose advert had gone and added two new adverts.
- **The gate** was run once as a preview on 10 November 2026, on 128 labelled adverts (too few to be a gate): the rules matcher alone passed 41 jobs with a badge and 40 truly qualified. No model has been run against it yet.

## Known limits

- A description of 30,000 digits still takes about 0.9 seconds in the salary reader. The limit bounds it. Making the pattern itself fast changes behaviour, so it waits for a decision.
- Titles, locations and Ashby descriptions are not stripped of HTML, as in the Python. Whoever shows them on a page must escape them.
- Not ported: Lever, Workable and Recruitee (no board uses them).
- LinkedIn: the adapter is ported (`runLinkedin`, with a retry on 429 and a request budget, both off by default), but its advert page answered 429 in the one recording pass, so its parser has never met a real page. It is not in the fetcher.
- The AI matcher is built and not yet wired into the fetcher, and no model has been chosen: that waits for the frozen test set and a model key.
- A changed advert that the rules are now unsure about sends its live job back to the admin queue, even if an admin approved it before.
- The same job on two boards is saved twice: there is no cross-source duplicate key yet.
- Not built yet: the rules tables, the nightly re-run of live jobs, scheduling (the fetcher runs by hand), and the importers for the government files.
- Three packages each carry their own small helper that gives a JavaScript pattern Python's meaning (`readers/pyre.ts`, `employers/py-text.ts`, `matcher/src/rules/pyRegex.ts`). One shared copy would do.
