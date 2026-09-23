import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { AppNav, Chip, EmptyState, ModeCard, Notice } from "~/components/app-ui";
import { loadSampleInbox, getCalendar, removeCalendarEvent } from "~/lib/inbox";

export const Route = createFileRoute("/app/calendar")({
  head: () => ({
    meta: [
      { title: "Calendar — Doppel" },
      {
        name: "description",
        content: "The events Doppel pulled out of your email, each with the reminder it will use.",
      },
    ],
  }),
  loader: async () => await getCalendar(),
  component: AppCalendar,
});

type FeedNotice = { tone: "amber" | "emerald" | "rose"; message: string } | null;

function AppCalendar() {
  const view = Route.useLoaderData();
  const router = useRouter();
  const [notice, setNotice] = useState<FeedNotice>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (work: () => Promise<{ ok: boolean; message: string }>, id?: string) => {
    setBusy(id ?? "sample");
    try {
      const res = await work();
      setNotice({ tone: res.ok ? "emerald" : "amber", message: res.message });
      if (res.ok) await router.invalidate();
    } catch {
      setNotice({ tone: "rose", message: "That didn't reach the server — nothing changed. Please try again." });
    }
    setBusy(null);
  };

  const events = view.events;

  return (
    <main className="mx-auto max-w-4xl px-5 py-10 sm:px-8">
      <AppNav current="calendar" />

      <header className="mt-8">
        <Link
          to="/app"
          className="inline-flex min-h-11 items-center text-xs font-semibold tracking-wide text-indigo-600 uppercase transition hover:text-indigo-700"
        >
          ← Back to the inbox
        </Link>
        <p className="text-xs font-semibold tracking-wide text-indigo-600 uppercase">
          Dates pulled out of the inbox
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Your calendar</h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-slate-600">
          Every date Doppel found in an email that you chose to keep, with the reminder it will use. This is
          Doppel's own calendar — nothing is written into your mail account, and no invitation is ever sent.
        </p>
      </header>

      <div className="mt-8">
        <ModeCard ai={view.ai} storage={view.storage} />
      </div>

      {notice ? (
        <div className="mt-6">
          <Notice message={notice.message} tone={notice.tone} />
        </div>
      ) : null}
      {!view.ok && view.message ? (
        <div className="mt-6">
          <Notice message={view.message} tone="rose" />
        </div>
      ) : null}

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">
            {events.length === 0 ? "No events yet" : `${events.length} event${events.length === 1 ? "" : "s"}`}
          </h2>
          {events.length > 0 ? <p className="text-xs text-slate-500">Soonest first · times in UTC</p> : null}
        </div>

        <div className="mt-3">
          {events.length === 0 ? (
            <EmptyState
              title="Nothing on the calendar yet"
              body="Open a message in the inbox, find the date Doppel spotted in it, and use Add to calendar. The event appears here with the reminder it will use."
            >
              <Link
                to="/app"
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
              >
                Go to the inbox
              </Link>
              <button
                type="button"
                onClick={() => run(() => loadSampleInbox())}
                disabled={busy !== null}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400 disabled:opacity-50"
              >
                {busy === "sample" ? "Working…" : "Load sample inbox"}
              </button>
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[1fr_auto] sm:items-center sm:p-5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{event.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
                      <Chip tone="violet">{event.startsAtLabel}</Chip>
                      <span className="text-xs text-slate-500">
                        Reminder: {event.reminderLabel ?? "none"}
                        {event.reminderAt ? ` · ${event.reminderAt} UTC` : ""}
                      </span>
                    </p>
                    <p className="mt-2 text-xs break-words text-slate-500">
                      From:{" "}
                      {event.emailId ? (
                        <Link
                          to="/app/email/$id"
                          params={{ id: event.emailId }}
                          className="font-medium text-indigo-600 transition hover:text-indigo-700"
                        >
                          {event.sourceLabel}
                        </Link>
                      ) : (
                        event.sourceLabel
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => run(() => removeCalendarEvent({ data: { id: event.id } }), event.id)}
                    disabled={busy !== null}
                    className="inline-flex min-h-11 items-center justify-center justify-self-start rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:border-rose-300 hover:text-rose-700 disabled:opacity-50 sm:justify-self-end"
                  >
                    {busy === event.id ? "Removing…" : "Delete"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
