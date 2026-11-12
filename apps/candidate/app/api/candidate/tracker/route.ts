import { trackerPost, trackerPut } from "../../../../lib/account";

// The tracker: POST { jobId } is "Mark applied", PUT { jobId, stage } changes the stage.
export const POST = trackerPost;
export const PUT = trackerPut;
