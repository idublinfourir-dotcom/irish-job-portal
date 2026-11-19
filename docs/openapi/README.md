# API reference

One OpenAPI 3.1 file per app, written by hand (decision #248):

- [candidate.yaml](candidate.yaml): the candidate site (public reads, contact, report, alerts, the signed-in candidate's own data and files).
- [portal.yaml](portal.yaml): the employer and agency portal.
- [admin.yaml](admin.yaml): the staff admin app.

Each file starts with the same Conventions section (Origin check, body caps, the two error formats, paging, rate limits, ids, times).
Every operation names who may call it (`security` and `x-roles`), its limits (`x-body-cap`, `x-rate-limit`), its body, its reply
with an example, and every error status with its codes.

## The rule

A new or changed route updates its OpenAPI file in the same commit. `packages/db/src/openapi-sync.test.ts` fails when a route file
or an exported method is missing from its app's file, when a file describes a path or method with no route, or when an operation
has no summary, no 4xx (or no `x-no-4xx` reason) or no success example. Some integration tests also check real replies against
the schemas (`replyProblems` in `packages/db/test/openapi.ts`).

## The index route

Each app answers `GET /api` with its name, the deployed commit, the environment, the time and every route as `METHOD /path (who may
call it)` (decision #265). The list is `apps/<app>/lib/api-index.json`, made from the app's file here; the sync test fails when they
differ. After changing a file here, rewrite the three lists with:

    API_INDEX_WRITE=1 npx vitest run packages/db/src/openapi-sync.test.ts

The candidate and employer indexes answer anyone; the admin index answers only a signed-in active staff member. The commit comes from
`APP_VERSION`, which the Deploy workflow passes to each deploy (`local` on a developer machine).

## Lint

    npm run lint:api

Redocly's `recommended` rules; the rules turned off are in `redocly.yaml` at the repo root, each with its reason. It runs in
`npm run check`.

## View

    npx @redocly/cli preview --product=redoc docs/openapi/candidate.yaml

or build one static HTML page to open locally:

    npx @redocly/cli build-docs docs/openapi/candidate.yaml -o /tmp/candidate-api.html

Do not commit built HTML.

## TypeScript types (later)

When the pages need typed clients, generate types from these files with `openapi-typescript` (not installed now), for example
`npx openapi-typescript docs/openapi/candidate.yaml -o apps/candidate/lib/api-types.ts`, and add a check that the generated file
is up to date.
