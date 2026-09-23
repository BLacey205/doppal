/**
 * Small presentational pieces shared by the /app screens, so /app feels like the
 * same product as the landing page (same slate/indigo palette, same rounded
 * cards) without any new dependency.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { alertsView } from "~/lib/alert-view";
import type { AiStatus, AlertStatus, StorageStatus } from "~/lib/inbox-types";

export function AppNav({ current }: { current: "inbox" | "calendar" | "social" }) {
  const item = (active: boolean) =>
    `inline-flex min-h-11 items-center rounded-lg px-3.5 text-sm font-semibold transition ${
      active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    }`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-200 pb-4">
      <div className="flex items-center gap-1.5">
        <Link to="/app" className={item(current === "inbox")}>
          Inbox
        </Link>
        <Link to="/app/calendar" className={item(current === "calendar")}>
          Calendar
        </Link>
      
      </div>
      <p className="text-xs font-medium text-slate-500">Drafts only — Doppel never sends mail</p>
    </div>
  );
}

export function Chip({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "amber" | "indigo" | "emerald" | "violet" | "rose";
}) {
  const tones: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 text-slate-600",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    indigo: "border-indigo-200 bg-indigo-50 text-indigo-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    violet: "border-violet-200 bg-violet-50 text-violet-700",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 75
      ? "bg-rose-50 text-rose-700 ring-rose-200"
      : score >= 50
        ? "bg-amber-50 text-amber-800 ring-amber-200"
        : score >= 25
          ? "bg-indigo-50 text-indigo-700 ring-indigo-200"
          : "bg-slate-50 text-slate-600 ring-slate-200";
  return (
    <span
      className={`inline-flex shrink-0 flex-col items-center rounded-xl px-3 py-1.5 ring-1 ring-inset ${tone}`}
      title={`Importance ${score} out of 100`}
    >
      <span className="text-lg leading-none font-bold">{score}</span>
      <span className="mt-0.5 text-[10px] font-semibold tracking-wide uppercase">/ 100</span>
    </span>
  );
}

/**
 * "Where the data lives" — configuration *and* evidence, kept separate.
 *
 * The card may only say saving works when the server reports `state: "confirmed"`,
 * which follows a query that really came back. A connection string on its own is
 * `unverified` and the card says so ("not confirmed", amber); a failed query is
 * `failed` (rose) and says which half failed. See `~/lib/storage-evidence`.
 */
export function ModeCard({ ai, storage }: { ai: AiStatus; storage: StorageStatus }) {
  const model = ai.mode === "model";
  const saved = storage.state === "confirmed";
  const tone: "emerald" | "amber" | "rose" = saved ? "emerald" : storage.state === "failed" ? "rose" : "amber";
  const chip =
    storage.state === "confirmed"
      ? "Database"
      : storage.state === "preview"
        ? "Preview"
        : storage.state === "unverified"
          ? "Not confirmed"
          : storage.failedDirection === "read"
            ? "Read failing"
            : "Save failing";
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div
        className={`rounded-xl border p-4 ${
          model ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"
        }`}
      >
        <p className="text-xs font-semibold tracking-wide uppercase text-slate-500">
          Ranking, dates &amp; drafts
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
          <Chip tone={model ? "emerald" : "amber"}>{model ? "Model" : "Built-in rules"}</Chip>
          {ai.label}
        </p>
        {ai.note ? <p className="mt-2 text-xs leading-relaxed text-slate-600">{ai.note}</p> : null}
      </div>

      <div
        className={`rounded-xl border p-4 ${
          tone === "emerald"
            ? "border-emerald-200 bg-emerald-50/60"
            : tone === "rose"
              ? "border-rose-200 bg-rose-50/60"
              : "border-amber-200 bg-amber-50/60"
        }`}
      >
        <p className="text-xs font-semibold tracking-wide uppercase text-slate-500">Where the data lives</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
          <Chip tone={tone}>{chip}</Chip>
          {storage.label}
        </p>
        {storage.note ? <p className="mt-2 text-xs leading-relaxed text-slate-600">{storage.note}</p> : null}
      </div>
    </div>
  );
}

/**
 * Whether the owner is actually told when important mail arrives (Knock alerting).
 *
 * Styled as the same kind of line as the two cards above, and deliberately blunt:
 * unless Knock has accepted a check, the line says in words that nothing is
 * reaching the owner yet. `view.honesty` is the sentence that guarantees it, and
 * the self-test asserts both sides of that rule.
 */
export function AlertsLine({ alerts }: { alerts: AlertStatus }) {
  const view = alertsView(alerts);
  const frame =
    view.tone === "emerald"
      ? "border-emerald-200 bg-emerald-50/60"
      : view.tone === "rose"
        ? "border-rose-200 bg-rose-50/60"
        : "border-amber-200 bg-amber-50/60";

  return (
    <div className={`rounded-xl border p-4 ${frame}`}>
      <p className="text-xs font-semibold tracking-wide uppercase text-slate-500">
        When important mail arrives
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
        <Chip tone={view.tone}>{view.chip}</Chip>
        {view.label}
      </p>
      {view.note ? <p className="mt-2 text-xs leading-relaxed text-slate-600">{view.note}</p> : null}
      {view.honesty ? (
        <p
          className={`mt-1 text-xs leading-relaxed font-semibold ${
            view.tone === "rose" ? "text-rose-900" : "text-amber-900"
          }`}
        >
          {view.honesty}
        </p>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        The alert only ever goes to Doppel's own inbox, and only for mail forwarded to us — never to the
        person who wrote in.
      </p>
    </div>
  );
}

export function Notice({
  message,
  tone = "amber",
}: {
  message: string;
  tone?: "amber" | "emerald" | "rose";
}) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
  } as const;
  return (
    <p role="status" className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>
      {message}
    </p>
  );
}

export function ModeTag({ mode, provider }: { mode: "model" | "heuristic"; provider?: string }) {
  return mode === "model" ? (
    <Chip tone="emerald">Drafted by the model{provider ? ` · ${provider}` : ""}</Chip>
  ) : (
    <Chip tone="amber">Drafted by built-in rules{provider ? ` · ${provider}` : ""}</Chip>
  );
}

export function EmptyState({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-slate-600">{body}</p>
      {children ? <div className="mt-5 flex flex-wrap justify-center gap-3">{children}</div> : null}
    </div>
  );
}
