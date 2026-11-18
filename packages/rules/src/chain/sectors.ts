// #257 (P6): the two sectors the Python's run_day.py does not have. No imports, so plain-node CLIs (packages/db/src/sector-backfill-cli.ts) read
// it too. SOC 2010 codes (packages/rules/data/soc2010-unit-groups.json); none is in the health set of assess.ts.
/** Care workers and home carers, senior care workers, care escorts, residential, day and domiciliary care managers. */
export const CARE_CODES: readonly string[] = ["6145", "6146", "6147", "1242"];
/** Chefs, cooks, catering and bar managers, hotel, restaurant and licensed premises managers, kitchen assistants, waiters, bar staff. */
export const HOSPITALITY_CODES: readonly string[] = ["5434", "5435", "5436", "1221", "1223", "1224", "9272", "9273", "9274"];
