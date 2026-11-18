import { accountDelete } from "../../../../lib/account";

// The signed-in login deletes itself (R1): DELETE { confirm: true }. Its stored files are removed and every session ends.
export const DELETE = (request: Request) => accountDelete(request);
