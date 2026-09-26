/**
 * The one network seam for every call that carries a model credential.
 *
 * `src/lib/ai.ts` (triage/dates/drafts) and `src/lib/model-credentials.ts`
 * (the save-time validation call) both go through here, so the app self-test
 * can stub the provider upstream in one place and prove — hermetically — what
 * the real pipeline does, including the exact `Authorization` header it sends.
 *
 * Same shape as the alerting `Transport` in `~/lib/notify`: a request object in,
 * `{ status, body }` out. The default transport is plain `fetch` with a timeout.
 */

export type ModelTransportRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type ModelTransportResponse = { status: number; body: string };

export type ModelTransport = (request: ModelTransportRequest) => Promise<ModelTransportResponse>;

export const fetchModelTransport: ModelTransport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const res = await fetch(request.url, {
      method: request.method,
      signal: controller.signal,
      headers: request.headers,
      body: request.method === "GET" ? undefined : request.body,
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
};

let active: ModelTransport = fetchModelTransport;

/** What the pipeline and the validation call actually use right now. */
export function modelTransport(): ModelTransport {
  return active;
}

/**
 * Test seam only (the app self-test stubs the provider with this). Passing null
 * restores the real fetch transport. Never call this from product code — the
 * pipeline must always talk to the real provider in production.
 */
export function setModelTransportForTests(transport: ModelTransport | null): void {
  active = transport ?? fetchModelTransport;
}
