import { candidateSettings } from "@portal/auth";
import { handleContact } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// The contact form: { topic, name, email, body }. Open to visitors; a signed-in candidate's id comes from the session and name and email may be left out.
export const POST = (request: Request) => {
  const settings = candidateSettings(process.env);
  return handleContact(request, { origin: new URL(settings.baseURL).origin, side: "candidate", secret: settings.secret, login: signedInCandidate });
};
