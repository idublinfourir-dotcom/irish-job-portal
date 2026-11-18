-- P10: fuzzystrmatch for the account review's lookalike-domain reason (levenshtein, packages/db/src/account-review.ts). In the extensions schema, like pg_trgm (0000).
create extension if not exists fuzzystrmatch with schema extensions;
