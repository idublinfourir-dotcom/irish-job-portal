import { savedDelete, savedList, savedPost } from "../../../../lib/account";

// Saved jobs: GET the list (closed jobs marked), POST { jobId } saves, DELETE { jobId } removes.
export const GET = savedList;
export const POST = savedPost;
export const DELETE = savedDelete;
