/**
 * A customer's own model credential — stored so carefully that a leak is
 * structurally impossible, and used only after the provider itself said the key
 * works.
 *
 * The rules this module is built out of (each one asserted in the app self-test):
 *
 *  1. **Validate before anything is kept.** Saving makes a real authenticated
 *     call to the provider (a free `GET /v1/models`) with the entered key. A
 *     refusal stores NOTHING — no row, no "saved" claim — and the card records
 *     why. A stored credential is only ever marked usable because a real
 *     validation succeeded; a row without that proof is never used by the
 *     pipeline, whatever else is true of it.
 *  2. **Encryption at rest, fail-closed.** The key is encrypted with
 *     AES-256-GCM under `MODEL_ENCRYPTION_KEY` (a platform secret). Without
 *     that secret the flow refuses to store anything and names the missing
 *     secret — it never falls back to plaintext, and never claims a save that
 *     didn't happen.
 *  3. **The key never crosses to the browser.** Every view model carries the
 *     provider, the model, a mask (`sk-…abcd`) and timestamps — never the key.
 *     The key never appears in a URL, a log line, or an error message: provider
 *     error details are scrubbed against the key before they are stored or
 *     shown, and the raw provider body is never surfaced at all.
 *  4. **Removing really removes.** Remove deletes the row (a genuine DELETE),
 *     clears the in-memory copy, and says so; triage falls back to the built-in
 *     rules immediately.
 *  5. **A bad credential can never break the app.** The pipeline resolves its
 *     provider through `getValidatedCredential()` first and the platform env
 *     key second; if neither is usable, the deterministic rules engine runs,
 *     labelled as such. A removed, invalid or failing customer key degrades the
 *     engine — it never breaks a page.
 *
 * Scope: this first version is one shared connection for the whole app. The row
 * carries a `scope` column (fixed to `"workspace"` today) so per-customer
 * credentials later become a row-scoped change rather than a schema change. The
 * copy says this plainly rather than implying multi-tenant isolation that does
 * not exist.
 *
 * Server-only: reads `process.env`, holds decrypted key material. Never
 * imported by a component — the card gets its view through
 * `~/lib/model-credential-view`, fed by the server functions in
 * `~/lib/model-credential-fns`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { failureLogLine } from "~/lib/log-line";
import { modelTransport } from "~/lib/model-transport";

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

export type ModelProviderId = "openai" | "anthropic";

export type ModelProviderInfo = {
  id: ModelProviderId;
  label: string;
  /** The model the pipeline uses with this provider (mirrors the env path's default). */
  model: string;
  /** The free, authenticated endpoint the validation check calls. */
  validationUrl: string;
  /** How the key is presented: Bearer header or the x-api-key header. */
  auth: "bearer" | "header";
  /** The honest cost line: the customer pays their provider directly. No prices are invented here. */
  costLine: string;
};

export const MODEL_PROVIDERS: Record<ModelProviderId, ModelProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    model: "gpt-4o-mini",
    validationUrl: "https://api.openai.com/v1/models",
    auth: "bearer",
    costLine:
      "OpenAI bills you directly for what the pipeline uses, at OpenAI's own published prices — Doppel adds nothing on top and never sees your bill.",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    model: "claude-3-5-haiku-latest",
    validationUrl: "https://api.anthropic.com/v1/models?limit=1",
    auth: "header",
    costLine:
      "Anthropic bills you directly for what the pipeline uses, at Anthropic's own published prices — Doppel adds nothing on top and never sees your bill.",
  },
};

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = ["openai", "anthropic"];

/** Exactly how a model engine is labelled in every triage/date/draft outcome. */
export function providerTag(provider: ModelProviderId, model: string): string {
  return `${provider}:${model}`;
}

/* -------------------------------------------------------------------------- */
/* Encryption — AES-256-GCM under MODEL_ENCRYPTION_KEY                          */
/* -------------------------------------------------------------------------- */

export const MODEL_ENCRYPTION_KEY_ENV = "MODEL_ENCRYPTION_KEY";

const MISSING_SECRET_MESSAGE =
  "Doppel can't store a model key yet: the encryption secret MODEL_ENCRYPTION_KEY is not set on this deployment, so there is nowhere safe to put it. Nothing was saved — a key is never kept in plaintext, so nothing will be stored until that secret exists.";

/**
 * The 32-byte AES key, derived deterministically from the secret so the same
 * secret always decrypts what it encrypted. A 64-hex-digit secret is used as
 * raw bytes (the recommended shape — `openssl rand -hex 32`); a base64 secret
 * is used if it decodes to exactly 32 bytes; anything else is hashed once with
 * SHA-256. Returns null when the secret is absent — the fail-closed case.
 */
function encryptionKey(): Buffer | null {
  const secret = process.env[MODEL_ENCRYPTION_KEY_ENV]?.trim();
  if (!secret) return null;
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, "hex");
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(secret)) {
    const decoded = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (decoded.length === 32) return decoded;
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

type Sealed = { data: string; iv: string; tag: string };

function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { data: data.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function open(key: Buffer, sealed: Sealed): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}

/** The only part of the key a screen may ever show: provider prefix + last 4. */
export function maskFor(provider: ModelProviderId, key: string): string {
  const prefix = provider === "anthropic" ? "sk-ant-…" : "sk-…";
  const last4 = key.length >= 4 ? key.slice(-4) : "";
  return `${prefix}${last4}`;
}

/* -------------------------------------------------------------------------- */
/* Validation — a real authenticated call before anything is kept              */
/* -------------------------------------------------------------------------- */

export type ValidationRefusalCode = "invalid_key" | "rate_limited" | "provider_error" | "unreachable";
export type ValidationOutcome =
  | { ok: true; provider: ModelProviderId; model: string; mask: string }
  | { ok: false; code: ValidationRefusalCode; message: string };

const VALIDATION_TIMEOUT_MS = 15_000;

/**
 * Reduce the provider's error body to a short, typed detail — without ever
 * letting the key (or a piece of it) into the sentence. The raw body is parsed
 * for its `error.message`; if that is missing, a generic line stands in.
 */
export function scrubProviderDetail(detail: string, key: string): string {
  let out = detail.replace(/\s+/g, " ").trim();
  for (const fragment of [key, key.slice(0, 24), key.slice(0, 16), key.slice(0, 12), key.slice(-8)]) {
    if (fragment && fragment.length >= 6) out = out.split(fragment).join("[redacted]");
  }
  // A token that is itself a piece of the key (provider messages echo a
  // truncated form: "Incorrect API key provided: sk-abc123***.") goes too.
  out = out
    .split(/\s+/)
    .map((token) => {
      const bare = token.replace(/[^A-Za-z0-9_-]/g, "");
      return bare.length >= 6 && key.includes(bare) ? "[redacted]" : token;
    })
    .join(" ");
  return out.slice(0, 200);
}

async function validationCall(
  provider: ModelProviderId,
  key: string,
): Promise<{ status: number; body: string; networkError: boolean }> {
  const info = MODEL_PROVIDERS[provider];
  const headers: Record<string, string> =
    info.auth === "bearer"
      ? { authorization: `Bearer ${key}` }
      : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  try {
    const res = await modelTransport()({
      url: info.validationUrl,
      method: "GET",
      headers,
      body: "",
      timeoutMs: VALIDATION_TIMEOUT_MS,
    });
    return { ...res, networkError: false };
  } catch {
    return { status: 0, body: "", networkError: true };
  }
}

/**
 * The real gate: call the provider with the entered key and let IT say whether
 * the key works. 200 means usable; anything else is a typed refusal with the
 * provider's own words (scrubbed) — and nothing is stored anywhere.
 */
export async function validateKey(
  provider: ModelProviderId,
  key: string,
): Promise<ValidationOutcome> {
  const info = MODEL_PROVIDERS[provider];
  const { status, body, networkError } = await validationCall(provider, key);

  if (networkError) {
    return {
      ok: false,
      code: "unreachable",
      message: `${info.label} couldn't be reached just now, so the key couldn't be checked. Nothing was saved — please try again in a minute.`,
    };
  }
  if (status === 200) return { ok: true, provider, model: info.model, mask: maskFor(provider, key) };

  const detail = providerErrorDetail(body);
  const scrubbed = detail ? ` It said: “${scrubProviderDetail(detail, key)}.”` : "";
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: "invalid_key",
      message: `${info.label} refused this key (authentication failed), so nothing was saved.${scrubbed} The built-in rules keep running.`,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: "rate_limited",
      message: `${info.label} rate-limited or queried quota on the validation check (HTTP 429), so nothing was saved.${scrubbed} The built-in rules keep running.`,
    };
  }
  return {
    ok: false,
    code: "provider_error",
    message: `${info.label} answered the validation check with HTTP ${status}, which is a problem on its side or an answer we don't understand. Nothing was saved — please try again.${scrubbed}`,
  };
}

/** The `error.message` field of a provider error body — nothing else is read. */
function providerErrorDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const err = (parsed as Record<string, unknown>).error;
      if (err && typeof err === "object") {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message.trim();
      }
    }
  } catch {
    // A body that isn't JSON yields no detail — the typed message stands alone.
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Storage — Postgres when DATABASE_URL is set, in-memory preview otherwise    */
/* -------------------------------------------------------------------------- */

export type CredentialRow = {
  id: string;
  scope: string;
  provider: ModelProviderId;
  model: string;
  encryptedKey: string;
  iv: string;
  authTag: string;
  mask: string;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Executor = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/** One shared connection for the whole app today; the column is here so
 * per-customer credentials later become a row-scoped change. */
export const WORKSPACE_SCOPE = "workspace";

let schemaReady = false;

async function ensureSchema(db: Executor): Promise<void> {
  if (schemaReady) return;
  await db`
    create table if not exists model_credentials (
      id bigserial primary key,
      scope text not null default 'workspace',
      provider text not null,
      model text not null,
      encrypted_key text not null,
      iv text not null,
      auth_tag text not null,
      mask text not null default '',
      validated_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  schemaReady = true;
}

/* ---- in-memory preview backend ------------------------------------------- */

type MemoryBackend = { rows: CredentialRow[]; seq: number };

const memoryStore = (): MemoryBackend => {
  const key = "__doppelPreviewModelCredentials" as const;
  const host = globalThis as unknown as Record<string, MemoryBackend | undefined>;
  if (!host[key]) host[key] = { rows: [], seq: 0 };
  return host[key];
};

/* ---- backend choice: memory ONLY when no database is configured ---------- */

type Backend =
  | { kind: "sql"; db: Executor }
  | { kind: "memory" }
  | { kind: "broken" };

async function backendFor(exec?: Executor): Promise<Backend> {
  if (exec) return { kind: "sql", db: exec };
  if (process.env.DATABASE_URL) {
    // Dynamically imported so nothing but a server path with a database ever
    // pulls a database driver into its module graph. A handle that cannot even
    // be built (an unusable DATABASE_URL) is a broken store, never a throw:
    // nothing here may turn into an exception inside a caller's ingest path.
    try {
      const { sql } = await import("~/db");
      return { kind: "sql", db: sql() as unknown as Executor };
    } catch (err) {
      console.error(
        failureLogLine(
          "The database behind the stored model credential could not be opened.",
          err,
          "model credential store",
        ),
      );
      return { kind: "broken" };
    }
  }
  return { kind: "memory" };
}

const isoOf = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value ?? ""));
  return Number.isNaN(parsed) ? String(value ?? "") : new Date(parsed).toISOString();
};

function rowFromSql(row: Record<string, unknown>): CredentialRow {
  return {
    id: String(row.id),
    scope: String(row.scope ?? WORKSPACE_SCOPE),
    provider: row.provider === "anthropic" ? "anthropic" : "openai",
    model: String(row.model ?? ""),
    encryptedKey: String(row.encrypted_key ?? ""),
    iv: String(row.iv ?? ""),
    authTag: String(row.auth_tag ?? ""),
    mask: String(row.mask ?? ""),
    validatedAt: row.validated_at === null || row.validated_at === undefined ? null : isoOf(row.validated_at),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

/* -------------------------------------------------------------------------- */
/* The failure record — the card's `failed` state, never a stored credential   */
/* -------------------------------------------------------------------------- */

type FailureRecord = { code: string; message: string; at: string };

let lastFailure: FailureRecord | null = null;

/** Set when the last read of a configured store failed — the card's honesty line. */
let readFailed = false;

function noteCredentialFailure(code: string, message: string, at: string): void {
  lastFailure = { code, message, at };
}

/** Test seam: start the section from nothing. */
export function resetModelCredentialState(): void {
  lastFailure = null;
  pipelineCache = null;
  readFailed = false;
  memoryStore().rows = [];
}

/* -------------------------------------------------------------------------- */
/* Save / remove / read                                                        */
/* -------------------------------------------------------------------------- */

export type SaveOutcome =
  | {
      ok: true;
      state: "connected";
      provider: ModelProviderId;
      model: string;
      mask: string;
      validatedAt: string;
      validatedAtLabel: string;
      /** Where the encrypted row landed — "memory" is the honest no-database preview. */
      where: "database" | "memory";
      message: string;
    }
  | { ok: false; code: SaveRefusalCode; message: string };

export type SaveRefusalCode =
  | "bad_input"
  | "encryption_unavailable"
  | "invalid_key"
  | "rate_limited"
  | "provider_error"
  | "unreachable"
  | "store_failed";

export type RemoveOutcome = { ok: true; removed: boolean; message: string } | { ok: false; code: "store_failed"; message: string };

const STORE_FAILED_MESSAGE =
  "The key validated, but saving it failed just now, so nothing is stored. The built-in rules keep running — please try again.";

const utcLabelOf = (iso: string): string => `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;

/** Validate, then encrypt, then store — in that order, and only that order. */
export async function saveModelCredential(
  provider: ModelProviderId,
  key: string,
  exec?: Executor,
): Promise<SaveOutcome> {
  const info = MODEL_PROVIDERS[provider];
  if (!info) return { ok: false, code: "bad_input", message: "That provider isn't one Doppel can connect." };
  const trimmed = key.trim();
  if (trimmed.length < 20) {
    return {
      ok: false,
      code: "bad_input",
      message: "That looks too short to be a provider key — paste the whole key and try again. Nothing was saved.",
    };
  }

  const aesKey = encryptionKey();
  if (!aesKey) {
    noteCredentialFailure("encryption_unavailable", MISSING_SECRET_MESSAGE, new Date().toISOString());
    return { ok: false, code: "encryption_unavailable", message: MISSING_SECRET_MESSAGE };
  }

  // 1. The real validation call. A refusal leaves the store untouched.
  const verdict = await validateKey(provider, trimmed);
  if (!verdict.ok) {
    noteCredentialFailure(verdict.code, verdict.message, new Date().toISOString());
    console.error(`[model-credentials] ${provider} key refused at validation (code ${verdict.code}) — nothing stored.`);
    return { ok: false, code: verdict.code, message: verdict.message };
  }

  // 2. Encrypt. 3. Store — Postgres when a database is configured (a failed
  // write is a typed refusal, never a silent memory fallback), memory only for
  // the honest no-database preview.
  const sealed = seal(aesKey, trimmed);
  const nowIso = new Date().toISOString();
  const backend = await backendFor(exec);

  if (backend.kind === "broken") {
    noteCredentialFailure("store_failed", STORE_FAILED_MESSAGE, nowIso);
    return { ok: false, code: "store_failed", message: STORE_FAILED_MESSAGE };
  }

  if (backend.kind === "memory") {
    const store = memoryStore();
    store.rows = store.rows.filter((row) => row.scope !== WORKSPACE_SCOPE);
    store.seq += 1;
    store.rows.push({
      id: String(store.seq),
      scope: WORKSPACE_SCOPE,
      provider,
      model: verdict.model,
      encryptedKey: sealed.data,
      iv: sealed.iv,
      authTag: sealed.tag,
      mask: verdict.mask,
      validatedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    pipelineCache = null;
    lastFailure = null;
    return {
      ok: true,
      state: "connected",
      provider,
      model: verdict.model,
      mask: verdict.mask,
      validatedAt: nowIso,
      validatedAtLabel: utcLabelOf(nowIso),
      where: "memory",
      message: `Connected — ${info.label} answered the validation check on ${utcLabelOf(nowIso)}. Ranking, dates and drafts now run on ${providerTag(provider, verdict.model)}. Stored in this session's in-memory preview only (no database is connected), so it will not survive a restart.`,
    };
  }

  try {
    await ensureSchema(backend.db);
    await backend.db`
      insert into model_credentials (
        scope, provider, model, encrypted_key, iv, auth_tag, mask, validated_at, updated_at
      ) values (
        ${WORKSPACE_SCOPE}, ${provider}, ${verdict.model}, ${sealed.data}, ${sealed.iv}, ${sealed.tag},
        ${verdict.mask}, ${nowIso}::timestamptz, ${nowIso}::timestamptz
      )
      on conflict (scope) do update set
        provider = excluded.provider,
        model = excluded.model,
        encrypted_key = excluded.encrypted_key,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        mask = excluded.mask,
        validated_at = excluded.validated_at,
        updated_at = excluded.updated_at
    `;
    pipelineCache = null;
    lastFailure = null;
    return {
      ok: true,
      state: "connected",
      provider,
      model: verdict.model,
      mask: verdict.mask,
      validatedAt: nowIso,
      validatedAtLabel: utcLabelOf(nowIso),
      where: "database",
      message: `Connected — ${info.label} answered the validation check on ${utcLabelOf(nowIso)}. Ranking, dates and drafts now run on ${providerTag(provider, verdict.model)}.`,
    };
  } catch (err) {
    console.error(failureLogLine(STORE_FAILED_MESSAGE, err, "model credential store"));
    noteCredentialFailure("store_failed", STORE_FAILED_MESSAGE, nowIso);
    return { ok: false, code: "store_failed", message: STORE_FAILED_MESSAGE };
  }
}

/** Remove really removes: a DELETE of the row, the memory copy and the cache. */
export async function removeModelCredential(exec?: Executor): Promise<RemoveOutcome> {
  const backend = await backendFor(exec);
  if (backend.kind === "broken") {
    return {
      ok: false,
      code: "store_failed",
      message:
        "The stored key couldn't be deleted just now, so it is still in place. Nothing was changed — please try again.",
    };
  }
  if (backend.kind === "memory") {
    const store = memoryStore();
    const before = store.rows.length;
    store.rows = store.rows.filter((row) => row.scope !== WORKSPACE_SCOPE);
    pipelineCache = null;
    lastFailure = null;
    const removed = store.rows.length < before;
    return {
      ok: true,
      removed,
      message: removed
        ? "Removed — the stored key was genuinely deleted (not flagged or hidden). Ranking, dates and drafts are back on the built-in rules."
        : "Nothing was stored to remove — the built-in rules keep running.",
    };
  }
  try {
    await ensureSchema(backend.db);
    const deleted = await backend.db`
      delete from model_credentials where scope = ${WORKSPACE_SCOPE} returning id
    `;
    pipelineCache = null;
    lastFailure = null;
    const removed = deleted.length > 0;
    return {
      ok: true,
      removed,
      message: removed
        ? "Removed — the stored key was genuinely deleted (not flagged or hidden). Ranking, dates and drafts are back on the built-in rules."
        : "Nothing was stored to remove — the built-in rules keep running.",
    };
  } catch (err) {
    const message =
      "The stored key couldn't be deleted just now, so it is still in place. Nothing was changed — please try again.";
    console.error(failureLogLine(message, err, "model credential store"));
    return { ok: false, code: "store_failed", message };
  }
}

async function readRow(exec?: Executor): Promise<CredentialRow | null> {
  const backend = await backendFor(exec);
  if (backend.kind === "memory") {
    // The in-memory store always answers, so anything a previously-configured
    // store said about being unreadable is over: this IS the store now.
    readFailed = false;
    return memoryStore().rows.find((row) => row.scope === WORKSPACE_SCOPE) ?? null;
  }
  if (backend.kind === "broken") {
    readFailed = true;
    return null;
  }
  try {
    await ensureSchema(backend.db);
    const rows = await backend.db`
      select * from model_credentials where scope = ${WORKSPACE_SCOPE} order by id desc limit 1
    `;
    readFailed = false;
    return rows.length > 0 ? rowFromSql(rows[0]) : null;
  } catch (err) {
    // A store that cannot be read holds no usable credential: the pipeline
    // falls back (env key, then rules) and the card refuses to describe a row
    // it never saw rather than inventing a state for it.
    console.error(failureLogLine("Reading the stored model credential failed just now.", err, "model credential store"));
    readFailed = true;
    return null;
  }
}


/* -------------------------------------------------------------------------- */
/* The pipeline's half: a validated credential takes precedence over the env   */
/* -------------------------------------------------------------------------- */

export type PipelineProvider = { name: ModelProviderId; model: string; key: string };

let pipelineCache: { signature: string; provider: PipelineProvider } | null = null;

/**
 * The row → engine decision, in one place so it can be tested without a store:
 * a row that was never validated is never used, and a row that cannot be
 * decrypted (the secret changed, say) is never used either. Both fall back —
 * the caller moves on to the env key and then the rules.
 */
export function providerFromStoredRow(row: CredentialRow | null): PipelineProvider | null {
  if (!row) return null;
  // No proof, no use: "connected" only ever means a real validation succeeded.
  if (!row.validatedAt) return null;
  const aesKey = encryptionKey();
  if (!aesKey) return null;
  try {
    const key = open(aesKey, { data: row.encryptedKey, iv: row.iv, tag: row.authTag });
    if (!key) return null;
    return { name: row.provider, model: row.model, key };
  } catch {
    // Decryption failed — most plausibly MODEL_ENCRYPTION_KEY changed. The key
    // is not readable, so it is not usable; say so via the card's decrypt
    // failure (credentialCard) and let the pipeline fall back.
    return null;
  }
}

/**
 * What the triage/date/draft pipeline should use right now: the customer's
 * validated credential first, the platform env key second. Returns null when
 * neither exists (the rules engine runs, labelled as such).
 */
export async function getValidatedCredential(): Promise<PipelineProvider | null> {
  // The cache is authoritative within this process (save and remove both clear
  // it), so a steady pipeline costs no extra store reads.
  if (pipelineCache) return pipelineCache.provider;
  try {
    const row = await readRow();
    if (!row) return null;
    const provider = providerFromStoredRow(row);
    if (provider) {
      pipelineCache = {
        signature: `${row.id}:${row.updatedAt}:${row.provider}:${row.model}:${row.mask}`,
        provider,
      };
    }
    return provider;
  } catch (err) {
    // Never let a credential-store fault break an ingest: fall back (env key,
    // then rules) and say so on the log as a single string.
    console.error(failureLogLine("Reading the stored model credential failed just now.", err, "model credential store"));
    readFailed = true;
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The card's honest state                                                     */
/* -------------------------------------------------------------------------- */

export type CredentialCardState = "not_connected" | "saved_unconfirmed" | "connected" | "failed";

export type ModelCredentialCard = {
  state: CredentialCardState;
  providerId: ModelProviderId | null;
  providerLabel: string | null;
  model: string | null;
  engineTag: string | null;
  mask: string | null;
  savedAtLabel: string | null;
  validatedAtLabel: string | null;
  /** The card's own sentence for its state. */
  message: string;
  /** Present in every state except `connected`: the plain line about what is NOT happening. */
  honesty: string | null;
  /** The last refusal, whatever the state (a refusal to replace doesn't un-connect the old key). */
  failure: { code: string; message: string; atLabel: string } | null;
  /** The single-workspace honesty note — no multi-tenant isolation is implied. */
  scopeNote: string;
};

const NOT_CONNECTED_MESSAGE =
  "No model key is saved. Ranking, dates and drafts run on the built-in rules — everything on this page keeps working.";
const SAVED_UNCONFIRMED_MESSAGE =
  "A key row is stored, but no successful validation is recorded for it, so the pipeline is not using it. Nothing runs on a key until a real validation has succeeded.";
const DECRYPT_FAILED_MESSAGE =
  "The saved key could not be decrypted with the current MODEL_ENCRYPTION_KEY, so it can't be used. The key itself is not lost in any readable form — save it again (or restore the original secret) and it will validate and connect. Until then the built-in rules keep running.";

export const SCOPE_NOTE =
  "This first version keeps one shared connection for the whole workspace — one saved key for the app, not one per account.";

/**
 * The card's state, read from what is actually stored (plus the last recorded
 * refusal). "Connected" is only ever produced by a row carrying a real
 * validation, and the trial decryption below keeps that claim true even after
 * the encryption secret has changed underneath it.
 */
export async function credentialCard(exec?: Executor): Promise<ModelCredentialCard> {
  const row = await readRow(exec);
  const failure = lastFailure
    ? { code: lastFailure.code, message: lastFailure.message, atLabel: utcLabelOf(lastFailure.at) }
    : null;

  // The store would not say what it holds. The card refuses to describe a row
  // it never saw — it cannot claim "not connected" any more than "connected".
  if (!row && readFailed) {
    return {
      state: "failed",
      providerId: null,
      providerLabel: null,
      model: null,
      engineTag: null,
      mask: null,
      savedAtLabel: null,
      validatedAtLabel: null,
      message:
        "Reading the stored model credential failed just now, so the card can't say what is stored. The pipeline falls back to the built-in rules (or the platform key) until the store answers again — please try again in a minute.",
      honesty: "Nothing about the stored key is claimed either way while the store will not answer.",
      failure,
      scopeNote: SCOPE_NOTE,
    };
  }

  if (row && row.validatedAt) {
    const usable = providerFromStoredRow(row);
    const info = MODEL_PROVIDERS[row.provider];
    if (!usable) {
      return {
        state: "failed",
        providerId: row.provider,
        providerLabel: info?.label ?? row.provider,
        model: row.model,
        engineTag: null,
        mask: row.mask || null,
        savedAtLabel: utcLabelOf(row.updatedAt),
        validatedAtLabel: null,
        message: DECRYPT_FAILED_MESSAGE,
        honesty: "The pipeline is NOT using this key right now — the built-in rules (or the platform key, if one is set) are.",
        failure,
        scopeNote: SCOPE_NOTE,
      };
    }
    return {
      state: "connected",
      providerId: row.provider,
      providerLabel: info.label,
      model: row.model,
      engineTag: providerTag(row.provider, row.model),
      mask: row.mask || null,
      savedAtLabel: utcLabelOf(row.updatedAt),
      validatedAtLabel: utcLabelOf(row.validatedAt),
      message: `Connected — ${info.label} answered a real validation check on ${utcLabelOf(row.validatedAt)}. Ranking, dates and drafts now run on ${providerTag(row.provider, row.model)}.`,
      honesty: null,
      failure,
      scopeNote: SCOPE_NOTE,
    };
  }

  if (row && !row.validatedAt) {
    // Defensive: the save flow never writes an unvalidated row, but if a row
    // ever lands without proof, the card must not call it connected.
    const info = MODEL_PROVIDERS[row.provider];
    return {
      state: "saved_unconfirmed",
      providerId: row.provider,
      providerLabel: info?.label ?? row.provider,
      model: row.model,
      engineTag: null,
      mask: row.mask || null,
      savedAtLabel: utcLabelOf(row.updatedAt),
      validatedAtLabel: null,
      message: SAVED_UNCONFIRMED_MESSAGE,
      honesty: "The pipeline is NOT using this key — without a real validation it is never used.",
      failure,
      scopeNote: SCOPE_NOTE,
    };
  }

  if (failure) {
    return {
      state: "failed",
      providerId: null,
      providerLabel: null,
      model: null,
      engineTag: null,
      mask: null,
      savedAtLabel: null,
      validatedAtLabel: null,
      message: failure.message,
      honesty: "Nothing is stored, so nothing is claimed connected — the built-in rules keep running.",
      failure,
      scopeNote: SCOPE_NOTE,
    };
  }

  return {
    state: "not_connected",
    providerId: null,
    providerLabel: null,
    model: null,
    engineTag: null,
    mask: null,
    savedAtLabel: null,
    validatedAtLabel: null,
    message: NOT_CONNECTED_MESSAGE,
    honesty: "The pipeline is on the built-in rules right now — the deterministic keyword and regex engine, clearly labelled on every output.",
    failure: null,
    scopeNote: SCOPE_NOTE,
  };
}

/** The label `aiStatus()` shows when neither a credential nor an env key is usable. */
export const RULES_FALLBACK_HINT =
  "Connect your own model key on this page's Model connection card, or set OPENAI_API_KEY (or ANTHROPIC_API_KEY) in Settings → Secrets, and the same pipeline starts using the model.";
