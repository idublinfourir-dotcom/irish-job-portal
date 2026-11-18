import { exportGet } from "../../../../../lib/account";

// The signed-in login's own data as one downloadable file (R1).
export const GET = (request: Request) => exportGet(request);
