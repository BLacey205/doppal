/**
 * The Connections section on /app: one honest card per channel.
 *
 * The rules it renders by (all asserted in the app self-test, on the rendered HTML):
 *
 *   - only a `proven` channel shows the "Connected" chip — every other state shows
 *     its own chip AND an `honesty` sentence saying plainly that mail is not flowing;
 *   - the not-configured state names the missing env vars **by name** — names only,
 *     never a value (the view model physically carries no values);
 *   - the owner's steps are shown in the adapter's declared order, numbered, short;
 *   - the standing line ("nothing is claimed connected until a real forwarded
 *     message is fetched and stored") appears in every unproven state;
 *   - the last check is shown verbatim — status, flags and the handler's own
 *     message — labelled with when it ran; a failed check says so and stays;
 *   - a channel without a check says so instead of showing a dead button.
 *
 * Presentational only: no env access, no fetching, no secret can reach this file.
 * The `onCheck` behaviour is injected by the route, so the self-test can render the
 * card hermetically.
 */
import type { ChannelView } from "~/lib/channel-view";
import { Chip } from "~/components/app-ui";

function frameClass(tone: ChannelView["tone"]): string {
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

function CheckLine({ check }: { check: NonNullable<ChannelView["lastCheck"]> }) {
  const headline =
    check.kind === "ok"
      ? check.summary
      : check.kind === "failed"
        ? check.reason
        : check.message;
  const tone = check.kind === "ok" ? "emerald" : check.kind === "failed" ? "rose" : "amber";
  const chip = check.kind === "ok" ? "Check ran" : check.kind === "failed" ? "Check failed" : "Check could not run";
  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3.5">
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
        <Chip tone={tone}>{chip}</Chip>
        <span className="text-xs font-medium text-slate-500">Ran {check.ranAtLabel}</span>
      </p>
      {headline ? <p className="mt-2 text-xs leading-relaxed text-slate-700">{headline}</p> : null}
      {check.facts.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {check.facts.map((fact) => (
            <li key={fact.label} className="text-xs leading-relaxed text-slate-600">
              <span className={fact.expected ? "font-semibold text-slate-700" : "font-semibold text-rose-700"}>
                {fact.expected ? "as expected" : "NOT as expected"} — HTTP {fact.status}
              </span>{" "}
              · {fact.label}
              {fact.detail ? <span className="block pl-0 text-slate-500">“{fact.detail}”</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ChannelCard({
  channel,
  checking,
  onCheck,
}: {
  channel: ChannelView;
  checking?: boolean;
  onCheck?: (channelId: string) => void;
}) {
  const honestyTone = channel.tone === "rose" ? "text-rose-900" : "text-amber-900";
  return (
    <div className={`rounded-xl border p-4 sm:p-5 ${frameClass(channel.tone)}`}>
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide uppercase text-slate-500">{channel.label}</span>
        <Chip tone={channel.tone === "slate" ? "slate" : channel.tone}>{channel.chip}</Chip>
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{channel.purpose}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{channel.message}</p>

      {channel.provenLine ? (
        <p className="mt-2 text-xs leading-relaxed font-semibold text-emerald-900">{channel.provenLine}</p>
      ) : null}
      {channel.failureLine ? (
        <p className="mt-2 text-xs leading-relaxed font-semibold text-rose-900">{channel.failureLine}</p>
      ) : null}
      {channel.honesty ? (
        <p className={`mt-2 text-xs leading-relaxed font-semibold ${honestyTone}`}>{channel.honesty}</p>
      ) : null}
      {channel.needsLine ? (
        <p className="mt-1 text-xs leading-relaxed text-slate-700">{channel.needsLine}</p>
      ) : null}

      <p className="mt-3 text-xs font-semibold tracking-wide uppercase text-slate-500">What this needs</p>
      <ul className="mt-1 space-y-1">
        {channel.envVars.map((envVar) => (
          <li key={envVar.name} className="text-xs leading-relaxed text-slate-600">
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-800">
              {envVar.name}
            </code>{" "}
            — {envVar.role}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs font-semibold tracking-wide uppercase text-slate-500">Your steps, in order</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        {channel.ownerSteps.map((step, index) => (
          <li key={`${channel.id}-step-${index}`} className="text-xs leading-relaxed text-slate-600">
            {step}
            {channel.webhookUrl && step.includes("webhook URL below") ? (
              <code className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-800">
                {channel.webhookUrl}
              </code>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="mt-3 text-xs leading-relaxed text-slate-500">{channel.standingLine}</p>

      {channel.lastCheck ? <CheckLine check={channel.lastCheck} /> : null}

      {channel.canCheck ? (
        <button
          type="button"
          onClick={() => onCheck?.(channel.id)}
          disabled={checking}
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-slate-400 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check now"}
        </button>
      ) : (
        <p className="mt-3 text-xs text-slate-500">No check exists for this channel yet, so none is offered.</p>
      )}
    </div>
  );
}

export function ConnectionsSection({
  channels,
  checking,
  checkError,
  onCheck,
}: {
  channels: ChannelView[];
  checking?: boolean;
  checkError?: string | null;
  onCheck?: (channelId: string) => void;
}) {
  return (
    <section className="mt-6" aria-label="Connections">
      <h2 className="text-lg font-semibold text-slate-900">Connections</h2>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
        How each channel really stands — what it needs, what to do next, and what has actually been proven.
        A channel is only ever shown connected once a real message has come through it and been stored.
      </p>
      {checkError ? (
        <p role="status" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {checkError}
        </p>
      ) : null}
      <div className="mt-3 grid grid-cols-1 gap-4">
        {channels.map((channel) => (
          <ChannelCard key={channel.id} channel={channel} checking={checking} onCheck={onCheck} />
        ))}
      </div>
    </section>
  );
}
