import { profileGet, profilePut } from "../../../../lib/account";

// The signed-in candidate's profile: GET it, PUT replaces it (a Stamp 4 pauses the alerts).
export const GET = profileGet;
export const PUT = profilePut;
