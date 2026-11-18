# The Workday runner (the engineer's laptop)

Workday's Cloudflare answers GitHub's own runners with a bot challenge (run 44262644215: `HTTP 429`, `cf-mitigated: challenge`, an HTML page), and the laptop with 200. So the Workday boards are fetched from the laptop by a GitHub self-hosted runner; every other board stays on GitHub's runners (`docs/job-rules.md`, "Where Workday runs").

## What it is

A small program from GitHub, running on the laptop as your own user, that asks GitHub for jobs labelled `self-hosted, workday` and runs them there. Only one workflow uses those labels: `.github/workflows/workday-fetch.yml`.

- **What can start it:** only its schedule (daily, 08:17 UTC, 14:17 Dhaka) and a person pressing "Run workflow" on the Actions tab. Never a pull request or a push, so code from a pull request never runs on the laptop (`packages/db/test/workday-fetch-workflow.test.ts` holds this). A person with write access can still start it on another branch by hand: that branch's code then runs on the laptop, so start it only on `main`.
- **What it does:** checks out the repo, installs Node (the version in `.nvmrc`, through `actions/setup-node`) and the packages, and runs the fetcher with `FETCHER_ONLY_KINDS: workday` and at most 10 model requests. No guard step, no admin step.
- **Secrets it sees:** `FETCHER_DATABASE_URL` (the `app_fetcher` login) and `FETCHER_MODEL_KEY` (OpenRouter), in the Fetch step only, as environment values of that one process. No admin login, email key or file key.
- **When the laptop is off:** the run waits; GitHub keeps it queued up to 24 hours, then drops it. Nothing else depends on it: the daily fetch, the guard and the watch leave Workday out.
- **A red run** (every Workday board failed) emails you like any failed run: the laptop is then challenged too.

## One-time setup

1. On GitHub: the repo's Settings, Actions, Runners, "New self-hosted runner", Linux. Run the download and `./config.sh` commands that page shows, as your own user (not root), in a folder of their own, for example `~/actions-runner`. The page gives the URL and a short-lived token; use those, nothing else.
2. When `config.sh` asks for extra labels, type `workday`. The runner then has `self-hosted, linux, X64, workday`.
3. Run it as a service so it starts with the laptop: in that folder, `sudo ./svc.sh install $USER`, then `sudo ./svc.sh start`. `sudo ./svc.sh status` shows it. The service runs as your user, not root.
4. Check: Settings, Actions, Runners shows it "Idle". Then Actions, "Workday fetch", "Run workflow" on `main` once.

Node: `actions/setup-node` downloads the `.nvmrc` version into the runner's own tool folder, so a system Node is not needed.

## How to stop it

- For a while: `sudo ./svc.sh stop` in the runner folder (start again with `start`). Queued runs wait, then drop after 24 hours.
- For good: `sudo ./svc.sh uninstall`, then `./config.sh remove` with the removal token from the runner's page on GitHub (Settings, Actions, Runners, the runner, "Remove").
- To stop only the schedule: Actions, "Workday fetch", the "..." menu, "Disable workflow".

If the repo ever becomes public, remove the runner first: GitHub advises against self-hosted runners on public repositories.
