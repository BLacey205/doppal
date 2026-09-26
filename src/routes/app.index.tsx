import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { AlertsLine, AppNav, Chip, ModeCard, Notice, ScoreBadge } from "~/components/app-ui";
import { ConnectionsSection } from "~/components/channel-ui";
import { ModelConnectionSection } from "~/components/model-credential-ui";
import { getChannels, runChannelsCheck } from "~/lib/channel-fns";
import { channelView } from "~/lib/channel-view";
import {
  getModelCredentialCard,
  removeModelCredentialKey,
  saveModelCredentialKey,
} from "~/lib/model-credential-fns";
import { modelCredentialView } from "~/lib/model-credential-view";
import { getInbox, ingestPastedEmail, loadSampleInbox } from "~/lib/inbox";

export const Route = createFileRoute("/app/")({
  // ?demo=sample — the landing-page hero links here so a visitor lands on the
  // ranked sample inbox rather than an empty one.
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.demo === "string" ? { demo: search.demo } : {},
  head: () => ({
    meta: [
      { title: "Inbox — Doppel" },
      {
        name: "description",
        content:
          "Every message ranked by importance, with the dates we found and a reply already drafted. Drafts only — Doppel never sends.",
      },
    ],
  }),
  loader: async () => ({
    inbox: await getInbox(),
    channels: await getChannels(),
    model: await getModelCredentialCard(),
  }),
  component: AppInbox,
});

type FeedNotice = { tone: "amber" | "emerald" | "rose"; message: string } | null;

function AppInbox() {
  const { inbox: view, channels: initialChannels, model: initialModel } = Route.useLoaderData();
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState<null | "paste" | "sample">(null);
  const [notice, setNotice] = useState<FeedNotice>(null);

  // Connections: rendered from the server's evidence, refreshed only by a real
  // check. Until then the card shows exactly what the server last knew.
  const [channels, setChannels] = useState(() => initialChannels.channels.map(channelView));
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // Model connection: the customer's own key. The server returns only a mask
  // and timestamps — never the key itself — so nothing here can re-render it.
  const [modelCard, setModelCard] = useState(() => initialModel.card);
  const [modelBusy, setModelBusy] = useState<null | "save" | "remove">(null);
  const [modelNotice, setModelNotice] = useState<FeedNotice>(null);

  const saveKey = async (input: { provider: "openai" | "anthropic"; key: string }) => {
    setModelBusy("save");
    setModelNotice(null);
    try {
      const res = await saveModelCredentialKey({ data: input });
      setModelNotice({ tone: res.ok ? "emerald" : "rose", message: res.message });
      if (res.ok) await router.invalidate();
      setModelCard((await getModelCredentialCard()).card);
    } catch {
      setModelNotice({
        tone: "rose",
        message: "That didn't reach the server — nothing was saved. Please try again.",
      });
    }
    setModelBusy(null);
  };

  const removeKey = async () => {
    setModelBusy("remove");
    setModelNotice(null);
    try {
      const res = await removeModelCredentialKey();
      setModelNotice({ tone: res.ok ? "emerald" : "rose", message: res.message });
      if (res.ok) await router.invalidate();
      setModelCard((await getModelCredentialCard()).card);
    } catch {
      setModelNotice({
        tone: "rose",
        message: "That didn't reach the server — nothing was removed. Please try again.",
      });
    }
    setModelBusy(null);
  };

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const fresh = await runChannelsCheck();
      setChannels(fresh.channels.map(channelView));
    } catch {
      setCheckError(
        "The check could not run just now, so the card is unchanged — nothing is claimed either way.",
      );
    }
    setChecking(false);
  };

  const guard = async (work: () => Promise<{ ok: boolean; message: string }>) => {
    try {
      const res = await work();
      setNotice({ tone: res.ok ? "emerald" : "amber", message: res.message });
      if (res.ok) await router.invalidate();
      return res.ok;
    } catch {
      setNotice({
        tone: "rose",
        message: "That didn't reach the server — nothing was saved. Please try again.",
      });
      return false;
    }
  };

  const paste = async () => {
    if (!raw.trim()) {
      setNotice({ tone: "amber", message: "Paste the text of an email first — a From and Subject line help too." });
      return;
    }
    setBusy("paste");
    const ok = await guard(() => ingestPastedEmail({ data: { raw } }));
    if (ok) setRaw("");
    setBusy(null);
  };

  const loadSamples = async () => {
    setBusy("sample");
    await guard(() => loadSampleInbox());
    setBusy(null);
  };

  // Arriving from the hero CTA (/app?demo=sample) should land on the ranked inbox,
  // not an empty one. Runs once, and only when there is nothing to rank yet.
  const { demo } = Route.useSearch();
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current || demo !== "sample") return;
    autoLoaded.current = true;
    if (view.emails.length > 0) return;
    void (async () => {
      setBusy("sample");
      await guard(() => loadSampleInbox());
      setBusy(null);
    })();
  }, [demo, view.emails.length]);

  const emails = view.emails;

  /**
   * What this section may say about persistence, state by state.
   *
   * It must never claim a database is connected when none is, and never claim that
   * what you load will stay put before a query has actually proved saving works —
   * the storage card above is evidence-based, so this paragraph has to agree with it
   * (see `~/lib/storage-evidence`).
   */
  const saves: { lead: string; body: string } =
    view.storage.state === "preview"
      ? {
          lead: "Nothing is saved yet.",
          body: "This runs on an in-memory preview — no database is connected, so everything you load here disappears when the server restarts.",
        }
      : view.storage.state === "confirmed"
        ? {
            lead: "Saving is on.",
            body: "This deployment saves to its connected database, so what you load here stays put when the server restarts.",
          }
        : view.storage.state === "failed"
          ? {
              lead: "Nothing is being saved right now.",
              body: "A database is connected but saving through it is failing, so nothing you load here is being kept.",
            }
          : {
              lead: "Saving isn't confirmed yet.",
              body: "A database is connected, but nothing has been saved through it yet in this session — so don't count on anything you load here staying put.",
            };

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <AppNav current="inbox" />

      <header className="mt-8">
        <p className="text-xs font-semibold tracking-wide text-indigo-600 uppercase">The clone at work</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Your inbox, worst first
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-slate-600">
          Every message scored for how much it matters, the dates and times inside it pulled out, and a reply
          already drafted for you to edit. Nothing here is sent — you copy the draft out and send it yourself.
        </p>
      </header>

      <div className="mt-8 space-y-4">
        <ModeCard ai={view.ai} storage={view.storage} />
        {/* Whether the owner is actually told when important mail arrives. */}
        <AlertsLine alerts={view.alerts} />
      </div>

      {/* How each channel really stands — starting with email (Resend forwarding). */}
      <ConnectionsSection channels={channels} checking={checking} checkError={checkError} onCheck={runCheck} />

      {/* The customer's own model key — validated before it is ever used, encrypted at rest. */}
      <ModelConnectionSection card={modelCredentialView(modelCard)} busy={modelBusy} onSave={saveKey} onRemove={removeKey} />

      {modelNotice ? (
        <div className="mt-4">
          <Notice message={modelNotice.message} tone={modelNotice.tone} />
        </div>
      ) : null}

      {notice ? (
        <div className="mt-6">
          <Notice message={notice.message} tone={notice.tone} />
        </div>
      ) : null}

      {emails.length === 0 ? (
        <section className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-slate-900">Start with the sample inbox</h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-700">
            Nothing is in here yet because no mailbox is connected — that's the Gmail/Outlook step still to
            come. Load the five sample messages and watch the whole pipeline run: each one scored and ranked
            worst-first with the reason why, the dates and times inside them pulled out, and a reply drafted
            for each.
          </p>
          <button
            type="button"
            onClick={loadSamples}
            disabled={busy !== null}
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60 sm:w-auto"
          >
            {busy === "sample" ? "Loading the sample messages…" : "Load sample inbox"}
          </button>
          <p className="mt-4 max-w-3xl text-xs leading-relaxed text-slate-600">
            <span className="font-semibold text-slate-700">{saves.lead}</span> {saves.body} Nothing is sent to
            anyone either: Doppel only drafts.
          </p>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-600">
            Got your own mail to hand? Paste an email below instead — the{" "}
            <span className="font-medium text-slate-700">From</span> and{" "}
            <span className="font-medium text-slate-700">Subject</span> lines are optional.
          </p>
        </section>
      ) : null}

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">
          {emails.length === 0 ? "Or paste an email of your own" : "Add a message"}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">
          Paste the text of any email and Doppel will rank it, find its dates and draft a reply. Headers are
          optional — the <span className="font-medium text-slate-700">From</span>,{" "}
          <span className="font-medium text-slate-700">Subject</span> lines are used when they're there.
        </p>
        <label htmlFor="paste-email" className="sr-only">
          Paste an email
        </label>
        <textarea
          id="paste-email"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          rows={6}
          placeholder={"From: Jane Cooper <jane@example.com>\nSubject: Can you fit us in on Friday?\n\nHi — are you free Friday at 9am…"}
          className="mt-4 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 font-mono text-sm text-slate-800 shadow-inner outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={paste}
            disabled={busy !== null}
            className={
              emails.length === 0
                ? "inline-flex min-h-12 items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
                : "inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
            }
          >
            {busy === "paste" ? "Reading it…" : "Add to inbox"}
          </button>
          {emails.length > 0 ? (
            <button
              type="button"
              onClick={loadSamples}
              disabled={busy !== null}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400 disabled:opacity-50"
            >
              {busy === "sample" ? "Working…" : "Load sample inbox"}
            </button>
          ) : null}
          <span className="text-xs text-slate-500">
            {emails.length > 0
              ? "The sample adds five realistic messages through the same path — no mail account needed."
              : "Your message is analysed exactly like the samples are."}
          </span>
        </div>
      </section>

      {!view.ok && view.message ? (
        <div className="mt-6">
          <Notice message={view.message} tone="rose" />
        </div>
      ) : null}

      {emails.length === 0 ? (
        <p className="mt-6 max-w-3xl text-xs leading-relaxed text-slate-500">
          Once there's something to rank, this page becomes the list: most important first, with the score
          and the reason on each message.
        </p>
      ) : (
      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900">
            {`${emails.length} message${emails.length === 1 ? "" : "s"}`}
          </h2>
          <p className="text-xs text-slate-500">Most important first · times shown in UTC</p>
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <ol className="divide-y divide-slate-200">
            {emails.map((email, index) => (
              <li key={email.id}>
                <Link
                  to="/app/email/$id"
                  params={{ id: email.id }}
                  className="flex items-start gap-3 px-4 py-4 transition hover:bg-slate-50 sm:gap-4 sm:px-5"
                >
                  <span className="mt-1 w-4 shrink-0 text-xs font-semibold text-slate-400 sm:w-5">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-900 sm:truncate">
                      {email.subject}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500 sm:truncate">
                      {email.fromLabel} · {email.receivedAtLabel}
                    </span>
                    <span className="mt-2 block text-sm leading-relaxed text-slate-600">
                      {email.snippet}
                    </span>
                    <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      {email.importance.needsReply ? <Chip tone="indigo">Needs a reply</Chip> : null}
                      {email.dates.length > 0 ? (
                        <Chip tone="violet">
                          Contains {email.dates.length === 1 ? "a date" : `${email.dates.length} dates`}
                        </Chip>
                      ) : null}
                      <Chip tone="slate">{email.importance.reason}</Chip>
                    </span>
                  </span>
                  <ScoreBadge score={email.importance.score} />
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>
      )}

      <p className="mt-6 max-w-3xl text-xs leading-relaxed text-slate-500">
        Scores, dates and drafts above are produced by the mode shown at the top of this page. A draft is never
        sent, scheduled, or answered on your behalf in this build.
      </p>
    </main>
  );
}
