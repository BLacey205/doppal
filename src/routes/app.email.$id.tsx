import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { AppNav, Chip, ModeTag, Notice, ScoreBadge } from "~/components/app-ui";
import { addToCalendar, getEmailView, updateDraft } from "~/lib/inbox";

export const Route = createFileRoute("/app/email/$id")({
  head: () => ({
    meta: [
      { title: "Email — Doppel" },
      {
        name: "description",
        content: "One message: the dates we found, an Add to calendar action, and a reply drafted for you to edit.",
      },
    ],
  }),
  loader: async ({ params }) => await getEmailView({ data: { id: params.id } }),
  component: EmailDetail,
});

type FeedNotice = { tone: "amber" | "emerald" | "rose"; message: string } | null;

function EmailDetail() {
  const view = Route.useLoaderData();
  const router = useRouter();
  const email = view.email;
  const [draftText, setDraftText] = useState(email?.draft?.body ?? "");
  const [notice, setNotice] = useState<FeedNotice>(null);
  const [copied, setCopied] = useState(false);
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const run = async (work: () => Promise<{ ok: boolean; message: string }>) => {
    try {
      const res = await work();
      setNotice({ tone: res.ok ? "emerald" : "amber", message: res.message });
      if (res.ok) await router.invalidate();
      return res.ok;
    } catch {
      setNotice({ tone: "rose", message: "That didn't reach the server — nothing changed. Please try again." });
      return false;
    }
  };

  const copy = async () => {
    const text = draftText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      const el = document.getElementById("draft-body") as HTMLTextAreaElement | null;
      if (el) {
        el.select();
        document.execCommand("copy");
        setCopied(true);
      } else {
        setNotice({ tone: "amber", message: "Copying isn't available here — select the text and copy it by hand." });
        return;
      }
    }
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <AppNav current="inbox" />

      {!view.ok || !email ? (
        <div className="mt-8 space-y-4">
          <Notice message={view.message ?? "We couldn't open that email."} tone="amber" />
          <Link
            to="/app"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400"
          >
            Back to the inbox
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <Link
                to="/app"
                className="inline-flex min-h-11 items-center text-xs font-semibold tracking-wide text-indigo-600 uppercase transition hover:text-indigo-700"
              >
                ← Back to the inbox
              </Link>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{email.subject}</h1>
              <p className="mt-2 text-sm text-slate-600">
                <span className="font-medium text-slate-800">{email.fromLabel}</span> · {email.receivedAtLabel}
                {email.toAddress ? (
                  <span className="text-slate-500"> · arrived on {email.toAddress}</span>
                ) : null}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {email.source === "sms" ? <Chip tone="violet">Text message</Chip> : null}
                {email.importance.needsReply ? <Chip tone="indigo">Needs a reply</Chip> : <Chip>No reply needed</Chip>}
                {email.dates.length > 0 ? (
                  <Chip tone="violet">
                    {email.dates.length === 1 ? "1 date found" : `${email.dates.length} dates found`}
                  </Chip>
                ) : null}
                <Chip tone={email.aiMode === "model" ? "emerald" : "amber"}>
                  Ranked by {email.aiMode === "model" ? `the model · ${email.aiProvider}` : "built-in rules"}
                </Chip>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <ScoreBadge score={email.importance.score} />
              <p className="max-w-[13rem] text-xs leading-relaxed text-slate-600">{email.importance.reason}</p>
            </div>
          </div>

          <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">The message</h2>
            <pre className="mt-3 max-h-[28rem] overflow-auto rounded-xl bg-slate-50 p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap text-slate-800">
              {email.body}
            </pre>
          </section>

          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">Dates and times we found</h2>
              <Chip tone={email.aiMode === "model" ? "emerald" : "amber"}>
                {email.aiMode === "model"
                  ? `Found by the model · ${email.aiProvider}`
                  : "Found by built-in rules (regex)"}
              </Chip>
            </div>

            {email.dates.length === 0 ? (
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                No day or time in this message that we'd put in a diary. If there is one and we missed it, paste the
                message again once a model key is connected — the rules only catch the common shapes.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {email.dates.map((date) => (
                  <li
                    key={date.id}
                    className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:grid-cols-[1fr_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900" title={date.label}>
                        “{date.label}”
                      </p>
                      <p className="mt-1 text-sm text-slate-700">
                        {date.startsAtLabel} ·{" "}
                        <span className="text-slate-500">
                          reminder: {date.reminderLabel} {date.reminderAt ? `(${date.reminderAt} UTC)` : ""}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {date.added ? (
                        <Link
                          to="/app/calendar"
                          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-sm font-semibold text-emerald-800 transition hover:border-emerald-400"
                        >
                          On the calendar ✓
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={async () => {
                            setBusyDate(date.id);
                            await run(() => addToCalendar({ data: { emailId: email.id, candidateId: date.id } }));
                            setBusyDate(null);
                          }}
                          disabled={busyDate !== null}
                          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
                        >
                          {busyDate === date.id ? "Adding…" : "Add to calendar"}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">Drafted reply</h2>
              <ModeTag mode={email.draft?.mode ?? email.aiMode} provider={email.draft?.provider ?? email.aiProvider} />
            </div>
            {(email.draft?.note ?? view.ai.note) && email.draft?.mode !== "model" ? (
              <p className="mt-2 text-xs leading-relaxed text-slate-500">{email.draft?.note ?? view.ai.note}</p>
            ) : null}

            <label htmlFor="draft-body" className="sr-only">
              Draft reply
            </label>
            <textarea
              id="draft-body"
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              rows={12}
              className="mt-4 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm leading-relaxed text-slate-800 shadow-inner outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={copy}
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                {copied ? "Copied ✓" : "Copy to clipboard"}
              </button>
              <button
                type="button"
                onClick={async () => {
                  setSaving(true);
                  await run(() => updateDraft({ data: { emailId: email.id, body: draftText } }));
                  setSaving(false);
                }}
                disabled={saving}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save my edit"}
              </button>
              <p className="text-xs text-slate-500">
                Doppel won't send, schedule or reply to this — edit it, copy it, and send it yourself.
              </p>
            </div>

            {notice ? (
              <div className="mt-4">
                <Notice message={notice.message} tone={notice.tone} />
              </div>
            ) : null}
          </section>

          <p className="mt-6 text-xs leading-relaxed text-slate-500">
            Everything on this page is a draft: no mail was sent, and the calendar event lives inside Doppel, not
            in your mail account's calendar. Times are handled in UTC in this build.
          </p>
        </>
      )}
    </main>
  );
}
