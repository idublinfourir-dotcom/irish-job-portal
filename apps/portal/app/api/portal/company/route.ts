import { profileGet, profilePost } from "../../../../lib/profile";

// The company profile (P3): GET for any active member, POST { description, website, county } for the account owner.
export const GET = (request: Request) => profileGet(request);
export const POST = (request: Request) => profilePost(request);
