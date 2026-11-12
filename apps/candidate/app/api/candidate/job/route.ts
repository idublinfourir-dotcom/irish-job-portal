import { jobGet } from "../../../../lib/account";

// One saved or tracked job, closed or not: GET ?id=. A closed job comes with up to 5 similar live jobs.
export const GET = jobGet;
