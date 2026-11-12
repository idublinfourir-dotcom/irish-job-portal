import { answerPost, promptsGet } from "../../../../lib/account";

// "Did you apply?": GET the prompts, POST { clickId, answer: yes | not_yet | no }.
export const GET = promptsGet;
export const POST = answerPost;
