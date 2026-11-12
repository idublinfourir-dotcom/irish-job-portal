import { candidateSettings } from "@portal/auth";
import { handleReport } from "@portal/db";
import { candidateReporter } from "../../../lib/candidate";

// Report a live job: { jobId, reason, evidence? }.
export const POST = (request: Request) =>
  handleReport(request, { origin: new URL(candidateSettings(process.env).baseURL).origin, side: "candidate", login: candidateReporter });
