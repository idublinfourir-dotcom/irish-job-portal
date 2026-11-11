# The 98% gate

The launch gate (decisions #79, #119, #145): of the jobs in the frozen test set that the chain passes with a Critical Skills badge, at least 98% must truly qualify. The set must hold at least 300 jobs. The share of rejected jobs that were rightly rejected is reported beside it and is not a gate.

Nothing in this folder names a model. The address, key and model id are passed in on the build day.

## The private folder

One folder outside the repo (`PORTAL_PRIVATE_DATA`, for example `step5/gate/`). The adverts are other sites' text, so none of it is committed.

| File | What |
| --- | --- |
| `testset.jsonl` | The frozen test set, one JSON line per advert. |
| `testset.sha256` | SHA-256 of `testset.jsonl`, written when the set is frozen (the `sha256sum` layout works). The runner refuses a set that does not match it. |
| `dete-2026.json` | The chain's employer list, `[[name, count], ...]`, as the parity run reads it. |
| `public_employers_candidates.json` | The public pay candidates, `{ "name": { "tier": 1 } }`. |
| `occupation-lists.json` | Only for an AI run: the two occupation lists as `[{ "id", "code", "title", "list" }]`, `list` being `critical-skills` or `ineligible`. |
| `answers/` | Made by the runner: every model answer, by model id, advert id and prompt hash. |
| `report-<model id or rules>.json` (`report-rules+ai-<model id>.json` in the batched mode) | Made by the runner: numbers and wrong ids only. |

## Test set line

```json
{"id":"t-001","advert":{"source":"greenhouse","employer":"Example Ltd","title":"Cloud Solutions Architect","location":"Dublin, Ireland","description":"Design cloud systems. Salary 70,000 a year. Permanent.","employmentType":"Full time","salaryBox":null},"label":{"qualifies":true,"occupationCode":"2135","note":"architect role, pay above the minimum"}}
```

- `id`: text, unique in the set.
- `advert`: the fields `assess` reads (`AdvertInput`): `source` (required), then `id`, `board`, `employer`, `title`, `location`, `description`, `url`, `employmentType`, `salaryBox`, each text or null. Any other field is refused.
- `label.qualifies`: true when the job truly qualifies for the Critical Skills badge, false otherwise.
- `label.occupationCode`: the four digit code the labeller chose, or `none`. `label.note`: a short reason.

## Run

From the repo root:

```
PORTAL_PRIVATE_DATA=<folder> PORTAL_GATE_MATCHER=rules npx vitest run --config packages/matcher/src/gate/vitest.gate.config.ts
```

That is the rules matcher alone: no key, no network, the baseline. For a model:

```
PORTAL_PRIVATE_DATA=<folder> PORTAL_GATE_MODEL_URL=https://host/api/v1 PORTAL_GATE_MODEL_KEY=... PORTAL_GATE_MODEL_ID=... npx vitest run --config packages/matcher/src/gate/vitest.gate.config.ts
```

The free model service allows few requests a day, so there is a third mode: the rules run first, and the model is asked once per batch of **badge** adverts only (a second opinion, see `docs/job-rules.md`). It needs the same model settings, plus `PORTAL_GATE_MATCHER=rules+ai`:

```
PORTAL_PRIVATE_DATA=<folder> PORTAL_GATE_MATCHER=rules+ai PORTAL_GATE_BATCH_SIZE=10 PORTAL_GATE_MODEL_URL=https://host/api/v1 PORTAL_GATE_MODEL_KEY=... PORTAL_GATE_MODEL_ID=... npx vitest run --config packages/matcher/src/gate/vitest.gate.config.ts
```

`PORTAL_GATE_BATCH_SIZE` is the adverts a request (default 10). A job counts as passed only if it keeps its badge. The report is `report-rules+ai-<model id>.json` and says how many requests were made (`modelCalls`), how many saved answers were reused, and the badges before and after (`secondOpinion`). Each request's answer is saved in `answers/` by model id and a hash of the request, so a run stopped by a daily limit goes on the next day without paying twice.

Optional: `PORTAL_GATE_DELAY_MS` (wait between real requests), `PORTAL_GATE_TIMEOUT_MS` (per request, default 60000).

A model error stops the run with the number of answers saved. Run the same command later: saved answers are reused and not paid for twice.
