import { unsubscribeGet, unsubscribePost } from "../../../../lib/alerts";

// No sign-in: the unsubscribe link in a job alert email. GET changes nothing; POST (also the RFC 8058 one-click) unsubscribes.
export const GET = unsubscribeGet;
export const POST = unsubscribePost;
