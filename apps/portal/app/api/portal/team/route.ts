import { teamGet, teamPost } from "../../../../lib/team";

// The caller's team (GET) and every team change (POST { action, ... }): invite, accept, request, approve, refuse, remove, leave, role, transfer.
export const GET = (request: Request) => teamGet(request);
export const POST = (request: Request) => teamPost(request);
