/**
 * Live owner-alert check — the one script that talks to the real Knock API.
 *
 *   bun run scripts/alert-live-check.ts
 *
 * Nothing is stubbed here (unlike the app self-test, which never opens a socket). It
 * answers two questions against the network and prints what it actually observed:
 *
 *   1. **Does the `doppel-important-mail` workflow exist in this Knock account?**
 *      It probes with the app's own check: a trigger in `sandbox_mode`, which makes
 *      Knock generate the message and deliver nothing to anyone.
 *   2. **Does the app's own intake path really alert the owner?** It posts a message
 *      that crosses the bar through `handleInboundEmailPost()` — the same function
 *      `POST /api/inbound-email` runs — and reports the exact alert outcome. This
 *      second trigger is **not** sandboxed, so once the workflow exists it will send
 *      the message to the owner's own inbox on purpose. Re-run it after creating the
 *      workflow to see the alert land.
 *
 * Ground rules it keeps: the only recipient it ever names is our own inbox
 * (`OWNER_ALERT_EMAIL`, default `doppel-cae2e184@ctomail.io`), never a third party;
 * the API key is never printed; and a refusal is reported as the exact status and
 * response body rather than interpreted away.
 */
import {
  KNOCK_API_KEY_ENV,
  alertConfig,
  notifyImportantEmail,
  probeAlerting,
  shouldAlert,
  type AlertResult,
} from "../src/lib/notify";
import { handleInboundEmailPost } from "../src/lib/inbound-request";
import { INBOUND_TOKEN_ENV, resetRateLimits } from "../src/lib/inbound-guard";

const RULE = "─".repeat(72);

/** A message that scores above the alert bar on the built-in rules. */
const MESSAGE = {
  from: "Marcus Bell <marcus@example.com>",
  subject: "URGENT — Thursday's site visit has to move",
  text: "The tenant has locked us out on Thursday. The only slot is tomorrow at 2:30pm. This is urgent and there is a £1,200 late fee — can you confirm by the end of the day today?",
  receivedAt: new Date().toISOString(),
};

async function main() {
  const config = alertConfig();
  console.log(RULE);
  console.log("Live owner-alert check");
  console.log(RULE);
  console.log(`workflow key      : ${config.workflowKey}`);
  console.log(`alert recipient   : ${config.ownerEmail}`);
  console.log(`link back to /app : ${config.siteUrl}`);
  console.log(
    `Knock API key     : ${config.hasKey ? `present (${KNOCK_API_KEY_ENV})` : `MISSING (${KNOCK_API_KEY_ENV})`}`,
  );

  console.log(`\n1. Does the workflow exist? (sandboxed trigger — nothing is delivered)`);
  const probe = await probeAlerting();
  console.log(`   state : ${probe.state}  (source: ${probe.source})`);
  console.log(`   line  : ${probe.label}`);
  if (probe.note) console.log(`   note  : ${probe.note}`);

  console.log(`\n2. The app's own intake path, with a message that crosses the bar`);
  const token = process.env[INBOUND_TOKEN_ENV] ?? "alert-live-check-token";
  process.env[INBOUND_TOKEN_ENV] = token;
  resetRateLimits();

  let pending: Promise<AlertResult> | undefined;
  const response = await handleInboundEmailPost(
    new Request("http://localhost/api/inbound-email", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(MESSAGE),
    }),
    {
      // The route hands the alert off in the background; capture it so this script can
      // report the real outcome instead of guessing at it.
      notify: (email) => {
        pending = notifyImportantEmail(email);
        return pending;
      },
    },
  );

  const body = (await response.json()) as {
    ok?: boolean;
    email?: { importance?: { score: number; reason: string; needsReply: boolean } };
    note?: string;
  };
  console.log(`   HTTP ${response.status}`);
  console.log(`   ingested : ${body.ok === true ? "yes" : "no"} — ${body.note ?? ""}`);
  console.log(
    `   triage   : score ${body.email?.importance?.score}/100, needs reply ${body.email?.importance?.needsReply} — ${body.email?.importance?.reason}`,
  );

  const bar = shouldAlert({
    source: "api",
    importance: body.email?.importance ?? { score: 0, reason: "", needsReply: false },
  });
  console.log(`   above the alert bar? ${bar.alert ? "yes" : "no"} — ${bar.why}`);

  const result = pending ? await pending : null;
  console.log(`\n   alert outcome (verbatim):`);
  console.log(JSON.stringify(result, null, 2));

  console.log(`\n${RULE}`);
  if (result?.outcome === "sent") {
    console.log(
      `Knock ACCEPTED the alert run${result.workflowRunId ? ` (${result.workflowRunId})` : ""}. Delivery to\n` +
        `${config.ownerEmail} can only be confirmed by looking in that inbox —\n` +
        "nothing on this side can see whether the mail arrived.",
    );
  } else {
    console.log(
      `NO alert went out. Outcome "${result?.outcome ?? "unknown"}": ${result?.message ?? "no result"}\n` +
        "Nothing was sent to anyone, and the ingested message is still in the inbox.",
    );
  }
  console.log(RULE);
}

await main();
