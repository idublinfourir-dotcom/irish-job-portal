import { noticesGet, noticesPost } from "../../../../lib/account";

// The candidate's updates: GET ?after= lists them 50 a page, newest first; POST { action: "read", id } or { action: "read_all" } marks them seen.
export const GET = noticesGet;
export const POST = noticesPost;
