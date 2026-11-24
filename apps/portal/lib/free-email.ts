// E04: the sign-up page tells a person on a free email provider that the account goes to staff review. The same list the review queue uses (B61 `freeEmail`).
import { isFreeEmailDomain } from "@portal/db";

export const freeEmail = (email: string): boolean => isFreeEmailDomain(email.slice(email.lastIndexOf("@") + 1).toLowerCase());
