// The signed-in candidate routes (step 9, part 10). Each route file is one line per method; the work is in @portal/db (candidate.ts).
import { candidateSettings } from "@portal/auth";
import {
  answerClick, applyClick, candidateRead, candidateWrite, checkAnswer, checkDelete, checkJobId, checkProfile, checkSettings, checkStage, deleteAccount,
  didYouApplyPrompts, getProfile, getSettings, listSaved, markApplied, putProfile, putSettings, saveJob, savedJob, setStage, unsaveJob,
} from "@portal/db";
import { signedInCandidate } from "./candidate";
import { OCCUPATION_CODES } from "./occupations";

const env = () => ({ origin: new URL(candidateSettings(process.env).baseURL).origin, login: signedInCandidate });

export const profileGet = (r: Request) => candidateRead(r, env(), getProfile);
export const profilePut = (r: Request) => candidateWrite(r, env(), checkProfile(OCCUPATION_CODES), putProfile);
export const savedList = (r: Request) => candidateRead(r, env(), listSaved);
export const savedPost = (r: Request) => candidateWrite(r, env(), checkJobId, saveJob);
export const savedDelete = (r: Request) => candidateWrite(r, env(), checkJobId, unsaveJob);
export const clickPost = (r: Request) => candidateWrite(r, env(), checkJobId, applyClick);
export const promptsGet = (r: Request) => candidateRead(r, env(), didYouApplyPrompts);
export const answerPost = (r: Request) => candidateWrite(r, env(), checkAnswer, answerClick);
export const trackerPost = (r: Request) => candidateWrite(r, env(), checkJobId, markApplied);
export const trackerPut = (r: Request) => candidateWrite(r, env(), checkStage, setStage);
export const jobGet = (r: Request) => candidateRead(r, env(), savedJob);
export const settingsGet = (r: Request) => candidateRead(r, env(), getSettings);
export const settingsPut = (r: Request) => candidateWrite(r, env(), checkSettings, putSettings);
export const accountDelete = (r: Request) => candidateWrite(r, env(), checkDelete, (db, userId) => deleteAccount(db, userId));
