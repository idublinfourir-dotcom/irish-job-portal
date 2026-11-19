import { checkerRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// The eligibility checker: ?occupationCode, annualPay, relevantDegree, and optional degreeAwardMonth, contractMonths, weeklyHours, title. Any other key is 400.
export const GET = (r: Request) => publicRead(r, signedInCandidate, checkerRead);
