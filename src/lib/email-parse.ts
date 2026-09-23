/**
 * Turning something that looks like an email into the fields we store.
 *
 * Deliberately small and dependency-free: `parseRawEmail` walks the header block
 * the way a mail client does (folded continuation lines, `Name <addr>` pairs) and
 * falls back to treating the whole text as a body when there are no headers — so
 * pasting just the text of a message still works.
 */

export type ParsedEmail = {
  fromName: string | null;
  fromEmail: string | null;
  /** What we show in the list: "Name <addr>", or whichever part we have. */
  fromLabel: string;
  subject: string;
  body: string;
  receivedAt: string;
};

const EMAIL_RE = /[^\s<>()"']+@[^\s<>()"']+\.[^\s<>()"']{2,}/;

const clean = (value: string | undefined | null): string => (value ?? "").replace(/\s+/g, " ").trim();

/** `"Dana Whitfield" <dana@example.com>` → name + address. */
export function parseAddressHeader(value: string): { name: string | null; email: string | null } {
  const raw = clean(value);
  if (!raw) return { name: null, email: null };
  const angled = raw.match(/^(.*?)<\s*([^>]+)\s*>\s*$/);
  if (angled) {
    const name = clean(angled[1]).replace(/^["']|["']$/g, "");
    return { name: name || null, email: clean(angled[2]).toLowerCase() || null };
  }
  const found = raw.match(EMAIL_RE);
  if (found && clean(found[0]) === raw) return { name: null, email: raw.toLowerCase() };
  return { name: raw || null, email: found ? found[0].toLowerCase() : null };
}

function headerBlock(text: string): { headers: Map<string, string>; body: string } {
  const normalised = text.replace(/\r\n/g, "\n");
  const splitAt = normalised.indexOf("\n\n");
  const head = splitAt === -1 ? normalised : normalised.slice(0, splitAt);
  const body = splitAt === -1 ? "" : normalised.slice(splitAt + 2);

  const headerNames = /^(from|to|cc|bcc|subject|date|reply-to|sender|return-path)\s*:/im;
  if (!headerNames.test(head)) {
    // Not a header block at all — the whole thing is the message.
    return { headers: new Map(), body: normalised.trim() };
  }

  // Unfold continuation lines (a header continued with leading whitespace).
  const lines = head.split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }

  const headers = new Map<string, string>();
  for (const line of unfolded) {
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!headers.has(key)) headers.set(key, match[2].trim());
  }
  return { headers, body: body.trim() };
}

/** Parse an RFC822-ish message. Tolerates plain text with no headers at all. */
export function parseRawEmail(raw: string, receivedAt?: string): ParsedEmail {
  const text = (raw ?? "").replace(/\0/g, "");
  const { headers, body } = headerBlock(text);

  const from = parseAddressHeader(headers.get("from") ?? "");
  const subject = clean(headers.get("subject")) || "(no subject)";

  return {
    fromName: from.name,
    fromEmail: from.email,
    fromLabel: from.name && from.email ? `${from.name} <${from.email}>` : (from.name ?? from.email ?? "Unknown sender"),
    subject: subject.slice(0, 300),
    body: normaliseBody(body || text.trim()),
    receivedAt: isoOrNow(receivedAt, headers.get("date") ?? ""),
  };
}

/** Build the fields from structured input (the inbound-email API, samples). */
export function fromStructured(input: {
  from?: string;
  subject?: string;
  text?: string;
  receivedAt?: string;
}): ParsedEmail {
  const parsed = parseAddressHeader(input.from ?? "");
  const subject = clean(input.subject) || "(no subject)";
  return {
    fromName: parsed.name,
    fromEmail: parsed.email,
    fromLabel:
      parsed.name && parsed.email
        ? `${parsed.name} <${parsed.email}>`
        : (parsed.name ?? parsed.email ?? "Unknown sender"),
    subject: subject.slice(0, 300),
    body: normaliseBody(input.text ?? ""),
    receivedAt: isoOrNow(input.receivedAt, ""),
  };
}

/** Collapse excessive blank lines but keep the paragraphs an owner wrote. */
function normaliseBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isoOrNow(value: string | undefined, fallbackDateHeader: string): string {
  for (const candidate of [value, fallbackDateHeader]) {
    if (!candidate) continue;
    const t = Date.parse(candidate);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/** First line or two of the body, for the inbox list. */
export function snippetOf(body: string, limit = 160): string {
  const flat = clean(body.replace(/^>.*$/gm, ""));
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}
