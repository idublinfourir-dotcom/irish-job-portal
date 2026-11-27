// The text of one legal purpose, as the public legal route gives it (GET /api/legal), shown in the body format (B16) with the same Body as the candidate site, never HTML. Every answer of the route has a state.
import { Body, Notice } from "@portal/ui";

export type Text = { version: string; body: string; publishedAt: string };

/** The states of the legal route: 200 the text; 404 NOT_FOUND nothing published yet; 429 over the read limit; anything else a plain "try later". */
export function LegalView({ title, status, text }: { title: string; status: number; text?: Text }) {
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4 py-8">
      <h1>{title}</h1>
      {status === 200 && text ? (
        <>
          <p className="text-small text-muted">Version {text.version}</p>
          <div data-legal-text className="text-body"><Body text={text.body} /></div>
        </>
      ) : status === 404 ? (
        <Notice kind="info" title="Not published yet">This text has not been published yet. Check again soon.</Notice>
      ) : status === 429 ? (
        <Notice kind="warning" title="Too many reads">Wait a minute, then reload this page.</Notice>
      ) : (
        <Notice kind="error" title="We cannot show this text now">Try again in a few minutes.</Notice>
      )}
    </article>
  );
}

