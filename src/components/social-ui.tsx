/**
 * The presentational half of `/social`.
 *
 * Deliberately free of the router and of any server import, for two reasons: the
 * page file can stay a thin loader + actions wrapper, and the self-test can render
 * this with `react-dom/server` and assert what the owner actually sees — the
 * sample-data labels and the "nothing is sent" sentences — rather than asserting a
 * view model and hoping the page agrees with it.
 *
 * The action surface is exactly two things: **save as draft** and **copy**. There is
 * no send, no publish, no reply-in-thread and no "post now", and the type of
 * `SocialActions` has no room for one.
 */
import { useState } from "react";

import { Chip, Notice } from "~/components/app-ui";
import { SUGGESTION_LABEL, suggestReplyText } from "~/lib/social/templates";
import type { SocialOverview } from "~/lib/social/views";
import type { ConnectionState, ReplyTarget } from "~/lib/social/types";
import { NETWORK_LABELS } from "~/lib/social/types";

export type SocialActions = {
  /** Saves a reply as a draft. Resolves with the app's own sentence either way. */
  saveDraft: (target: ReplyTarget, body: string) => Promise<{ ok: boolean; message: string }>;
  /** Re-runs the credential check for one network — a real call in the future. */
  checkNetwork: (network: string) => Promise<{ ok: boolean; message: string }>;
};

/** Local notice shape; named apart from the `Notice` component it renders. */
type PageNotice = { tone: "amber" | "emerald" | "rose"; message: string } | null;

/** The chip wording for a state, in the product's under-claiming voice. */
export function stateChip(state: ConnectionState): { label: string; tone: "slate" | "amber" | "emerald" | "rose" } {
  switch (state) {
    case "connected":
      return { label: "Connected", tone: "emerald" };
    case "unverified":
      return { label: "Not confirmed", tone: "amber" };
    case "failed":
      return { label: "Failing", tone: "rose" };
    case "unconfigured":
    default:
      return { label: "Not connected", tone: "amber" };
  }
}

const shown = (value: number | null): string => (value === null ? "not reported" : String(value));

const minutes = (value: number | null): string =>
  value === null ? "not measured" : `${Math.round(value)} min`;

function percentage(value: number | null): string {
  return value === null ? "not reported" : `${value}%`;
}

export function SocialPageBody({ view, actions }: { view: SocialOverview; actions: SocialActions }) {
  const [notice, setNotice] = useState<PageNotice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);

  const allTargets: ReplyTarget[] = view.feeds.flatMap((feed) => feed.targets);
  const target =
    allTargets.find((candidate) => `${candidate.network}:${candidate.kind}:${candidate.id}` === selected) ?? null;

  const chooseTarget = (key: string) => {
    setSelected(key);
    const picked = allTargets.find((candidate) => `${candidate.network}:${candidate.kind}:${candidate.id}` === key);
    if (!picked) {
      setBody("");
      setEdited(false);
      return;
    }
    setBody(suggestReplyText(picked));
    setEdited(false);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({
        tone: "emerald",
        message: "Copied to your clipboard — paste it into the app yourself. Doppel hasn't sent anything.",
      });
    } catch {
      setNotice({
        tone: "amber",
        message: "This browser wouldn't let Doppel copy for you — select the text and copy it yourself.",
      });
    }
  };

  const save = async () => {
    if (!target) {
      setNotice({ tone: "amber", message: "Pick a post, comment or message to reply to first." });
      return;
    }
    setBusy("save");
    const result = await actions.saveDraft(target, body);
    setNotice({ tone: result.ok ? "emerald" : "amber", message: result.message });
    setBusy(null);
  };

  const check = async (network: string) => {
    setBusy(`check:${network}`);
    const result = await actions.checkNetwork(network);
    setNotice({ tone: result.ok ? "emerald" : "amber", message: result.message });
    setBusy(null);
  };

  return (
    <div>
      <header className="mt-8">
        <p className="text-xs font-semibold tracking-wide text-indigo-600 uppercase">The clone at work</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Social, without the send button
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-slate-600">
          Posts, comments, messages and the numbers that matter, in one place. Nothing is connected yet: each
          network below says exactly which keys it waits for and what the platform still has to approve. Until
          then the read views run on Doppel&apos;s built-in sample set, labelled as such on every section.
        </p>
      </header>

      <section className="mt-6 rounded-2xl border border-rose-200 bg-rose-50/60 p-4 sm:p-5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
          <Chip tone="rose">Drafts only</Chip>
          Doppel never posts, replies or sends a direct message
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-700">{view.capabilities.sentence}</p>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-600">
          The reply box below can save a draft and copy text to your clipboard. Those are the only two actions on
          this page — there is no send button anywhere, and no code path that could send even if there were.
        </p>
      </section>

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

      {view.networks.map((network) => {
        const feed = view.feeds.find((candidate) => candidate.network === network.network) ?? null;
        const chip = stateChip(network.state);
        return (
          <section key={network.network} className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0">
                <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-slate-900">
                  {network.label}
                  <Chip tone={chip.tone}>{chip.label}</Chip>
                  {network.account ? <Chip tone="slate">{network.account.handle}</Chip> : null}
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-700">{network.summary}</p>
              </div>
              <button
                type="button"
                onClick={() => check(network.network)}
                disabled={busy !== null}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 transition hover:border-slate-400 disabled:opacity-50"
              >
                {busy === `check:${network.network}` ? "Checking…" : "Check connection"}
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  What {network.label} waits for
                </p>
                {network.missingCredentials.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {network.missingCredentials.map((name) => (
                      <li key={name} className="text-sm text-slate-800">
                        <span className="font-mono text-xs font-semibold text-slate-900">{name}</span>
                        <span className="text-slate-600"> — {network.credentialRoles[name] ?? "needed"}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-slate-700">
                    Every key {network.label} needs is set. Doppel still claims nothing until a call comes back —
                    use “Check connection”.
                  </p>
                )}
                <p className="mt-2 text-xs leading-relaxed text-slate-600">
                  Names only: Doppel never shows, logs or sends the value of a key, and nothing is read from{" "}
                  {network.label} while one is missing.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  What the platform still has to do
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-700">{network.approval}</p>
                <p className="mt-2 text-xs leading-relaxed text-slate-600">
                  Permissions this app would ask for:{" "}
                  <span className="font-mono">{network.permissions.join(", ")}</span>
                </p>
                <a
                  href={network.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-block text-xs font-semibold text-indigo-700 underline"
                >
                  {network.label} API documentation
                </a>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Reads</span>
              {network.reads.map((read) => (
                <Chip key={read.shape} tone={read.available ? "slate" : "rose"}>
                  {read.shape}: {read.available ? "available once approved" : "not available"}
                </Chip>
              ))}
            </div>
            {network.reads
              .filter((read) => read.note)
              .map((read) => (
                <p key={read.shape} className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-600">
                  {read.note}
                </p>
              ))}

            {feed ? <SampleFeed feed={feed} sampleLabel={view.sample.label} /> : null}
          </section>
        );
      })}

      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Reply — as a draft you send yourself</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-700">
          Pick a post, comment or message, edit the reply, then save it as a draft or copy it. Doppel doesn&apos;t
          send it, reply in the thread or touch the other person&apos;s account.
        </p>

        <label htmlFor="social-target" className="mt-4 block text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Reply to
        </label>
        <select
          id="social-target"
          value={selected}
          onChange={(event) => chooseTarget(event.target.value)}
          className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        >
          <option value="">Choose a post, comment or message…</option>
          {allTargets.map((candidate) => (
            <option
              key={`${candidate.network}:${candidate.kind}:${candidate.id}`}
              value={`${candidate.network}:${candidate.kind}:${candidate.id}`}
            >
              {NETWORK_LABELS[candidate.network]} · {candidate.kind} · {candidate.label}
            </option>
          ))}
        </select>

        {target ? (
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">They wrote</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-700">{target.excerpt}</p>
          </div>
        ) : null}

        <label htmlFor="social-reply" className="mt-4 block text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Your reply
        </label>
        <textarea
          id="social-reply"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            setEdited(true);
          }}
          rows={4}
          placeholder="Choose a post, comment or message above and Doppel will drop a starting point in here."
          className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-sm text-slate-800 shadow-inner outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {body.trim().length > 0 ? (
            edited ? (
              <Chip tone="indigo">Edited by you</Chip>
            ) : (
              <Chip tone="amber">{SUGGESTION_LABEL}</Chip>
            )
          ) : null}
          <span className="text-xs text-slate-500">{body.trim().length} characters</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={busy !== null || body.trim().length === 0}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : "Save as draft"}
          </button>
          <button
            type="button"
            onClick={() => copy(body)}
            disabled={body.trim().length === 0}
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400 disabled:opacity-50"
          >
            Copy
          </button>
          <span className="text-xs text-slate-500">
            No send. Copy puts the text on your clipboard so you can post it yourself.
          </span>
        </div>
        <p className="mt-3 max-w-3xl text-xs leading-relaxed text-slate-500">
          <span className="font-semibold text-slate-600">{view.draftStorage.label}.</span>{" "}
          {view.draftStorage.note}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-slate-900">
          Drafts you could send ({view.drafts.length})
        </h2>
        {view.drafts.length === 0 ? (
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
            Nothing saved yet. A draft you save appears here with what produced it, ready to copy out.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {view.drafts.map((draft) => (
              <li key={draft.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="slate">{NETWORK_LABELS[draft.network]}</Chip>
                  <Chip tone="indigo">Draft — not sent</Chip>
                  <Chip tone="amber">{draft.provenanceLabel}</Chip>
                  <span className="text-xs text-slate-500">
                    {draft.targetKind} · saved {draft.updatedAtLabel}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500">Replying to: {draft.targetLabel}</p>
                <p className="mt-2 text-sm whitespace-pre-wrap text-slate-800">{draft.body}</p>
                <button
                  type="button"
                  onClick={() => copy(draft.body)}
                  className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 transition hover:border-slate-400"
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-8 space-y-2">
        <p className="max-w-3xl text-xs leading-relaxed text-slate-500">{view.mappingNote}</p>
        <p className="max-w-3xl text-xs leading-relaxed text-slate-500">
          The machine endpoint <span className="font-mono">/api/social-status</span> reports the same states and the
          same key names, and the guarded read{" "}
          <span className="font-mono">/api/social-read</span> is{" "}
          {view.readTokenConfigured
            ? "switched on for whoever holds the shared token."
            : "switched off until a shared secret (SOCIAL_READ_TOKEN) is set — with none configured it refuses every request rather than exposing an account."}
        </p>
      </footer>
    </div>
  );
}

/** One network's sample feed: posts, comments, messages and the analytics view. */
function SampleFeed({ feed, sampleLabel }: { feed: SocialOverview["feeds"][number]; sampleLabel: string }) {
  return (
    <div className="mt-6 border-t border-slate-200 pt-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="violet">{sampleLabel}</Chip>
        <h3 className="text-sm font-semibold text-slate-900">{feed.label}</h3>
      </div>
      <p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-600">
        Every record in this block is sample data — invented accounts and invented messages, there so the layout
        and the engine are demonstrable before anything is connected. None of it is your audience.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Posts ({feed.posts.length}) · sample
          </h4>
          <ul className="mt-2 space-y-2">
            {feed.posts.map((post) => (
              <li key={post.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <p className="text-sm leading-relaxed text-slate-800">{post.body}</p>
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <Chip tone="violet">Sample</Chip>
                  <span>
                    {post.postedAtLabel} · {post.origin}
                  </span>
                  <span>
                    {shown(post.metrics.likes)} likes · {shown(post.metrics.comments)} comments ·{" "}
                    {shown(post.metrics.shares)} shares
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Comments ({feed.comments.length}) · sample
          </h4>
          <ul className="mt-2 space-y-2">
            {feed.comments.map((comment) => (
              <li key={comment.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <p className="text-sm leading-relaxed text-slate-800">{comment.body}</p>
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <Chip tone="violet">Sample</Chip>
                  <span>
                    {comment.author} · {comment.receivedAtLabel}
                  </span>
                  {comment.needsReply ? <Chip tone="indigo">Looks like it needs a reply</Chip> : null}
                </p>
              </li>
            ))}
          </ul>

          <h4 className="mt-4 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Messages ({feed.messages.length}) · sample
          </h4>
          <ul className="mt-2 space-y-2">
            {feed.messages.map((message) => (
              <li key={message.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <p className="text-sm leading-relaxed text-slate-800">{message.body}</p>
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <Chip tone="violet">Sample</Chip>
                  <span>
                    {message.from} · {message.receivedAtLabel}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-5">
        <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Analytics · sample · described {feed.analytics.capturedAtLabel}
        </h4>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Followers" value={shown(feed.analytics.followers)} />
          <Stat label="Reach" value={shown(feed.analytics.reach)} />
          <Stat label="Engagement per post" value={percentage(feed.analytics.engagementRatePct)} />
          <Stat label="Typical reply time" value={minutes(feed.analytics.medianResponseMinutes)} />
        </div>
        {feed.analytics.perPost.length > 0 ? (
          <table className="mt-3 w-full text-left text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 font-semibold">Post (sample)</th>
                <th className="py-1 font-semibold">Reach</th>
                <th className="py-1 font-semibold">Engagement</th>
              </tr>
            </thead>
            <tbody>
              {feed.analytics.perPost.map((row) => (
                <tr key={row.postId} className="border-t border-slate-200 text-slate-700">
                  <td className="py-1 font-mono">{row.postId}</td>
                  <td className="py-1">{row.reach}</td>
                  <td className="py-1">{row.engagementRatePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-lg font-bold text-slate-900">{value}</p>
    </div>
  );
}
