import { alertResumePost } from "../../../../../lib/alerts";

// POST { id } turns a paused or unsubscribed alert back on (verified candidates only, never while the stamp is Stamp 4).
export const POST = alertResumePost;
