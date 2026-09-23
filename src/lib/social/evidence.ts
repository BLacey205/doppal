/**
 * The evidence behind every "connected" claim in the social gateway.
 *
 * The rule, and the reason this module exists: **credentials are not evidence.**
 * `META_ACCESS_TOKEN` (or `X_BEARER_TOKEN`, or LinkedIn's half-dozen names) being
 * set says only that somebody configured a string. It says nothing about whether
 * Meta accepted the app, whether the permission was granted, or whether a read came
 * back. So a network is reported:
 *
 *   - `unconfigured` — the credential names it needs are not all present;
 *   - `unverified`   — they are present, but no call has returned in this process;
 *   - `connected`    — a real API call returned data in this process;
 *   - `failed`       — a call was refused or threw, and **that sticks for the life
 *                      of the running server**. A later success does not clear it.
 *
 * That is the same four-state discipline as `~/lib/storage-evidence`, deliberately:
 * both surfaces under-claim rather than over-claim, because a status line that
 * flatters the system is the failure mode this product keeps having to fix.
 *
 * Kept on `globalThis` so it survives a dev-server module reload and is shared by
 * every route handler and server function in the process. Nothing here throws,
 * touches the network, or stores a vendor error: only a short typed code plus the
 * app's own sentence, which is what the card shows and what the log line carries
 * (through `~/lib/log-line`, as a string — never an `Error`).
 */
import type { ConnectionState, SocialAccount, SocialNetwork } from "~/lib/social/types";

export type SocialEvidenceEntry = {
  /** A real API call to this network returned data in this process. */
  connected: boolean;
  /** The account that call reported, when it named one. */
  account: SocialAccount | null;
  /** The first failure in this process, and the typed sentence that describes it. */
  failure: { code: string; message: string } | null;
  /** ISO string of the last state change we observed, or null. */
  checkedAt: string | null;
};

type EvidenceStore = { entries?: Partial<Record<SocialNetwork, SocialEvidenceEntry>> };

function evidenceStore(): EvidenceStore {
  const globalKey = "__doppelSocialEvidence" as const;
  const host = globalThis as unknown as Record<string, EvidenceStore | undefined>;
  if (!host[globalKey]) host[globalKey] = {};
  return host[globalKey];
}

export function networkEvidence(network: SocialNetwork, now: Date = new Date()): SocialEvidenceEntry {
  const store = evidenceStore();
  if (!store.entries) store.entries = {};
  const existing = store.entries[network];
  if (existing) return existing;
  const fresh: SocialEvidenceEntry = { connected: false, account: null, failure: null, checkedAt: now.toISOString() };
  store.entries[network] = fresh;
  return fresh;
}

/**
 * Call only after a network call really returned data in this process.
 *
 * `account` may be `null`: a call can prove the credentials work without naming a
 * handle, and we would rather say "connected, handle unknown" than invent one.
 */
export function noteNetworkCallConnected(
  network: SocialNetwork,
  account: Omit<SocialAccount, "network" | "state"> | null,
  now: Date = new Date(),
): void {
  const entry = networkEvidence(network, now);
  entry.connected = true;
  entry.checkedAt = now.toISOString();
  // A read that cannot name the account must not erase what an earlier call proved.
  if (account) entry.account = { network, state: "connected", ...account };
}

/**
 * Call when a call to a network was refused or threw.
 *
 * `code` is a short typed token (`unauthorized`, `forbidden`, `rate_limited`,
 * `unreachable`, …) and `message` is the app's own sentence for that case — never
 * the vendor's response body, status text or an error object. The first failure
 * wins: no later failure may soften it, and no later success may erase it.
 */
export function noteNetworkCallFailed(
  network: SocialNetwork,
  code: string,
  message: string,
  now: Date = new Date(),
): void {
  const entry = networkEvidence(network, now);
  if (!entry.failure) entry.failure = { code, message };
  entry.checkedAt = now.toISOString();
}

/**
 * The state this process can support with evidence — configuration first, then
 * what we have actually seen. Failure is checked before success on purpose: a
 * sticky failure must win over an earlier successful call.
 */
export function connectionStateFor(network: SocialNetwork, configured: boolean): ConnectionState {
  const entry = networkEvidence(network);
  if (entry.failure) return "failed";
  if (entry.connected) return "connected";
  return configured ? "unverified" : "unconfigured";
}

/** Test helper: forget everything this process has learned. */
export function resetSocialEvidence(): void {
  evidenceStore().entries = {};
}
