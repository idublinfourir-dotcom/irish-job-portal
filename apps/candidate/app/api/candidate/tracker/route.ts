import { trackerGet, trackerPost, trackerPut } from "../../../../lib/account";

// The tracker: GET lists everything tracked (newest change first, with the count), POST { jobId } is "Mark applied", PUT { jobId, stage } changes the stage.
export const GET = trackerGet;
export const POST = trackerPost;
export const PUT = trackerPut;
