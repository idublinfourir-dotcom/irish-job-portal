// The browser part of Vercel BotID: every page runs it. A route missing from this list makes checkBotId() refuse it, so keep the list
// equal to the routes the server checks (packages/db/src/bot-check.ts, handleReport, and the contact route). The Google start is listed (C5); its callback is a redirect and is not.
import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    "/api/auth/candidate/sign-up/email", "/api/auth/candidate/sign-in/email", "/api/auth/candidate/request-password-reset",
    "/api/auth/candidate/send-verification-email", "/api/auth/candidate/sign-in/social", "/api/report", "/api/contact",
  ].map((path) => ({ path, method: "POST" })),
});
