/**
 * The display half of owner alerting: one pure function turning the server's
 * `AlertStatus` into the exact words `/app` shows.
 *
 * Why it is separate from the component: the honesty rule below is the part that
 * matters, and a pure function is testable in the app self-test without a browser.
 *
 * The rule: **`/app` must never imply that the owner is being told about important
 * mail when alerting is not on.** The label the server builds ("Alerts: on",
 * "Alerts: waiting for the workflow 'doppel-important-mail' in Knock", …) is shown
 * as-is, and every state other than `on` also carries a `honesty` sentence saying
 * plainly that nothing is reaching the owner yet. No state is dressed up.
 *
 * No server-only import here: this runs in the browser on a payload the server
 * function already produced, and it must never see the Knock key.
 */
import type { AlertState, AlertStatus } from "~/lib/inbox-types";

export type AlertsView = {
  state: AlertState;
  /** True only when Knock accepted a check — the one state that means "alerts on". */
  on: boolean;
  /** Short badge next to the label. */
  chip: string;
  /** Card colour: emerald when on, amber while unfinished, rose when refused. */
  tone: "emerald" | "amber" | "rose";
  /** The server's plain-words line, shown unchanged. */
  label: string;
  /** The server's optional "how we know / what changes it" sentence. */
  note?: string;
  /**
   * Present whenever alerting is **not** on: the plain sentence that says the owner
   * is not being told about important mail. Never present when `on` is true.
   */
  honesty?: string;
};

const CHIPS: Record<AlertState, { chip: string; tone: AlertsView["tone"] }> = {
  on: { chip: "On", tone: "emerald" },
  not_configured: { chip: "Not set up", tone: "amber" },
  workflow_missing: { chip: "Waiting on Knock", tone: "amber" },
  unauthorized: { chip: "Key refused", tone: "rose" },
  rejected: { chip: "Knock refused it", tone: "rose" },
  unavailable: { chip: "Not confirmed", tone: "amber" },
  unknown: { chip: "Not checked", tone: "amber" },
};

const HONESTY: Record<Exclude<AlertState, "on">, string> = {
  not_configured:
    "The owner is not being told about important mail: alerting is switched off, so a message that crosses the bar is only ranked here.",
  workflow_missing:
    "The owner is not being told about important mail yet — the check reaches Knock, but there is no workflow to run it.",
  unauthorized:
    "The owner is not being told about important mail: Knock refused the key, so no alert can go out.",
  rejected:
    "The owner is not being told about important mail: Knock refused the alert, so nothing was sent.",
  unavailable:
    "We could not confirm alerting just now, so we cannot promise the owner is being told about important mail.",
  unknown:
    "Alerting has not been checked yet, so nothing tells the owner when important mail arrives.",
};

export function alertsView(status: AlertStatus): AlertsView {
  const { chip, tone } = CHIPS[status.state] ?? CHIPS.unknown;
  const view: AlertsView = {
    state: status.state,
    on: status.state === "on",
    chip,
    tone,
    label: status.label,
    ...(status.note ? { note: status.note } : {}),
  };
  if (view.on) return view;
  const off: Exclude<AlertState, "on"> = status.state === "on" ? "unknown" : status.state;
  return { ...view, honesty: HONESTY[off] ?? HONESTY.unknown };
}
