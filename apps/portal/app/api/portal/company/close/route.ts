import { closePost } from "../../../../../lib/profile";

// The account owner closes the company (P12): POST { confirmName } with the company's exact name.
export const POST = (request: Request) => closePost(request);
