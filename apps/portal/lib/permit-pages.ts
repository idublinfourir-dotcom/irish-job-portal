// P20: the two public reads the permit services pages share with the candidate site (the occupation picker and the closed-portal notice, #291), on the portal's own pool. lib/data.ts
// wraps them; it imports nothing from @portal/db itself (the wall test in data.test.ts).
import { getPermitNotice, getPool, occupationPicker } from "@portal/db";

export const occupationList = () => occupationPicker(getPool());
export const permitNotice = () => getPermitNotice(getPool());
