// The browser part of Vercel BotID: every page runs it. A route missing from this list makes checkBotId() refuse it, so keep the list
// equal to the routes the server checks (packages/db/src/bot-check.ts, handleReport, and the contact route).
import { initBotId } from "botid/client/core";

initBotId({
  protect: [
    "/api/auth/portal/sign-up/email", "/api/auth/portal/sign-in/email", "/api/auth/portal/request-password-reset",
    "/api/auth/portal/send-verification-email", "/api/portal/report", "/api/portal/contact",
  ].map((path) => ({ path, method: "POST" })),
});
