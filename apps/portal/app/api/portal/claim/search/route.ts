import { companySearch } from "../../../../../lib/company";

// Companies to claim (or CRO numbers to register with) by name or CRO number: GET ?q=.
export const GET = (request: Request) => companySearch(request);
