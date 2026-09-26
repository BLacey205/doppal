/**
 * The "Model connection" section on /app: the customer's own model key, handled
 * so that a leak is structurally impossible.
 *
 * The rules it renders by (all asserted in the app self-test, on the rendered
 * HTML and the view model):
 *
 *   - the key is entered in a password-style field, never echoed, and the
 *     component's own key state is wiped the moment a save is attempted — the
 *     key is never re-rendered after save;
 *   - only the `connected` state shows the "Connected" chip, and it shows a
 *     MASK (sk-…abcd) and the validation date — never the key, which this file
 *     is physically incapable of receiving from the server;
 *   - every other state carries the honesty line saying the pipeline is on the
 *     built-in rules right now;
 *   - Save / Replace / Remove each answer with the server's own typed sentence
 *     about what actually happened;
 *   - the privacy and cost copy render verbatim from `~/lib/model-credential-view`.
 *
 * Presentational only: no env access, no fetching, no secret can reach this
 * file. `onSave` / `onRemove` are injected by the route, so the self-test can
 * render the card hermetically.
 */
import { useState } from "react";

import { Chip } from "~/components/app-ui";
import { PRIVACY_LEAD, PRIVACY_LINES, PROVIDER_CHOICES, type ModelCredentialView } from "~/lib/model-credential-view";

function frameClass(tone: ModelCredentialView["tone"]): string {
  switch (tone) {
    case "emerald":
      return "border-emerald-200 bg-emerald-50/60";
    case "rose":
      return "border-rose-200 bg-rose-50/60";
    case "amber":
      return "border-amber-200 bg-amber-50/60";
    default:
      return "border-slate-200 bg-slate-50/60";
  }
}

export function ModelConnectionSection({
  card,
  busy,
  onSave,
  onRemove,
}: {
  card: ModelCredentialView;
  busy?: null | "save" | "remove";
  onSave?: (input: { provider: "openai" | "anthropic"; key: string }) => void;
  onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  // The key lives here only while it is being typed. It is cleared before the
  // save call is even awaited, so no re-render can ever put it back on screen.
  const [keyValue, setKeyValue] = useState("");

  const showEntry = editing || card.state === "not_connected" || card.state === "failed";
  const chosen = PROVIDER_CHOICES.find((choice) => choice.id === provider) ?? PROVIDER_CHOICES[0];

  const submit = () => {
    if (!keyValue.trim() || busy) return;
    const entered = keyValue;
    setKeyValue("");
    onSave?.({ provider, key: entered });
  };

  return (
    <section className="mt-6" aria-label="Model connection">
      <div className={`rounded-xl border p-4 sm:p-5 ${frameClass(card.tone)}`}>
        <p className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs font-semibold tracking-wide uppercase text-slate-500">
            Model connection — your own key
          </span>
          <Chip tone={card.tone}>{card.chip}</Chip>
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{PRIVACY_LEAD}</p>
        <p className="mt-2 text-sm font-semibold text-slate-900">{card.message}</p>

        {card.state === "connected" && card.providerLabel ? (
          <p className="mt-2 text-xs leading-relaxed font-semibold text-emerald-900">
            {card.providerLabel} · {card.engineTag} · key on file {card.mask} · validated{" "}
            {card.validatedAtLabel}
          </p>
        ) : null}
        {card.honesty ? (
          <p className={`mt-2 text-xs leading-relaxed font-semibold ${card.tone === "rose" ? "text-rose-900" : "text-amber-900"}`}>
            {card.honesty}
          </p>
        ) : null}
        {card.failureLine ? (
          <p className="mt-2 text-xs leading-relaxed font-semibold text-rose-900">{card.failureLine}</p>
        ) : null}

        {showEntry ? (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3.5">
            <p className="text-xs font-semibold tracking-wide uppercase text-slate-500">Choose your provider</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PROVIDER_CHOICES.map((choice) => (
                <label
                  key={choice.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-xs leading-relaxed transition ${
                    provider === choice.id ? "border-indigo-400 bg-indigo-50/50" : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="model-provider"
                    value={choice.id}
                    checked={provider === choice.id}
                    onChange={() => setProvider(choice.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-900">{choice.label}</span>
                    <span className="mt-0.5 block text-slate-600">{choice.costLine}</span>
                  </span>
                </label>
              ))}
            </div>

            <label htmlFor="model-key-input" className="mt-4 block text-xs font-semibold tracking-wide uppercase text-slate-500">
              Paste your {chosen.label} key
            </label>
            <input
              id="model-key-input"
              type="password"
              autoComplete="off"
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
              placeholder={`${chosen.id === "anthropic" ? "sk-ant-…" : "sk-…"} — never shown back to you after saving`}
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={submit}
                disabled={busy !== null && busy !== undefined || keyValue.trim().length === 0}
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
              >
                {busy === "save" ? "Validating and saving…" : card.state === "connected" ? "Save replacement key" : "Save key"}
              </button>
              {card.state === "connected" && editing ? (
                <button
                  type="button"
                  onClick={() => {
                    setKeyValue("");
                    setEditing(false);
                  }}
                  className="text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
                >
                  Keep the current key
                </button>
              ) : null}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              On save, Doppel makes one real check with your key against {chosen.label} (a free read) and only
              keeps the key if that check succeeds. If it fails, nothing is stored and you'll see what the
              provider said.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400"
            >
              Replace key
            </button>
            <button
              type="button"
              onClick={() => onRemove?.()}
              disabled={busy !== null && busy !== undefined}
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-rose-300 bg-white px-4 py-2.5 text-sm font-semibold text-rose-700 transition hover:border-rose-400 disabled:opacity-50"
            >
              {busy === "remove" ? "Removing…" : "Remove key"}
            </button>
          </div>
        )}

        <p className="mt-4 text-xs font-semibold tracking-wide uppercase text-slate-500">Privacy and usage, plainly</p>
        <ul className="mt-1 space-y-1.5">
          {PRIVACY_LINES.map((line) => (
            <li key={line.slice(0, 24)} className="text-xs leading-relaxed text-slate-600">
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{card.scopeNote}</p>
      </div>
    </section>
  );
}
