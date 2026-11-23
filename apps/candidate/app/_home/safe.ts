// One section's read failing (a database error, a missing column during a deploy) must not take the whole home page down: the read becomes that
// section's failed state, and the error is logged on the server so it is not silent.
export type Failed = { ok: false; status: number; code: string; retryAfter?: number };

export const safe = <T>(read: Promise<T>, section: string): Promise<T | Failed> =>
  read.catch((e: unknown): Failed => {
    console.error(`home: the ${section} read failed`, e);
    return { ok: false, status: 500, code: "READ_FAILED" };
  });
