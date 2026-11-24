// What a page says when its read did not answer ok. Every status the public reads can give has its words (429 too many requests, 400 a bad request, anything else a failure).
import { A, Button, Notice } from "@portal/ui";
import { loginHref } from "../jobs/format";
import { wrap } from "./head";

export type Failed = { ok: false; status: number; code: string; retryAfter?: number };

export function Problem({ read, what, back, path }: { read: Failed; what: string; back?: { href: string; label: string }; path?: string }) {
  const wait = read.retryAfter ? ` about ${read.retryAfter} seconds` : " a little";
  return (
    <div className={`${wrap} py-10`}>
      {read.status === 401 ? (
        <Notice kind="info" title="Log in to see more">
          <p className="mb-3">Visitors see the first jobs only. It is free for candidates.</p>
          <span className="flex flex-wrap gap-3"><Button href={loginHref(path ?? "/")}>Log in</Button><Button href="/signup" variant="outline">Create free account</Button></span>
        </Notice>
      ) : read.status === 429 ? (
        <Notice kind="warning" title="Too many requests">Please wait{wait} and try again.</Notice>
      ) : read.status === 400 ? (
        <Notice kind="error" title={`We could not use that ${what}`}>The address is not valid.{back && <> <A href={back.href} className="underline underline-offset-2">{back.label}</A>.</>}</Notice>
      ) : (
        <Notice kind="error" title={`The ${what} could not be loaded`}>Please try again in a moment.</Notice>
      )}
    </div>
  );
}
