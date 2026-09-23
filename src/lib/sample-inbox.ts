/**
 * The sample inbox. Five realistic messages, so triage, date extraction and
 * drafting are all demonstrable with zero setup — no mail account, no database,
 * no model key.
 *
 * They deliberately exercise every branch:
 *   1. a client asking for a quote who names a day and a time,
 *   2. a supplier invoice with a due date and money in it,
 *   3. a newsletter (bulk mail → should rank bottom, and needs no reply),
 *   4. an urgent reschedule naming two days and a time,
 *   5. a lead enquiry asking for a call.
 *
 * Dates are relative ("tomorrow", "Friday") or computed from `now`, so the sample
 * never goes stale and always lands in the future.
 */

export type SampleEmail = {
  /** Stable slug — also how we avoid inserting the same sample twice. */
  slug: string;
  subject: string;
  raw: string;
};

const longDate = (d: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);

export function buildSampleInbox(now = new Date()): SampleEmail[] {
  const dueAt = new Date(now.getTime() + 30 * 86_400_000);

  return [
    {
      slug: "quote-windows",
      subject: "Quote for 12 replacement windows — and a site visit?",
      raw: `From: "Priya Raghunathan" <priya@brightlarkstudio.co.uk>
Subject: Quote for 12 replacement windows — and a site visit?

Hi,

We're refurbishing the top floor of our studio and need 12 replacement windows
(6 fixed, 6 opening). Could you put together a quote with your lead time and
whether the frames are included?

I'm on site every day this week, and Friday at 9am suits me if you'd like to
measure up. Next Monday afternoon is the back-up if that's no good.

Thanks,
Priya
Bright Lark Studio
0117 496 0021`,
    },
    {
      slug: "invoice-timber",
      subject: "Invoice NG-8841 — September timber order",
      raw: `From: "Northgate Timber Accounts" <accounts@northgate-timber.co.uk>
Subject: Invoice NG-8841 — September timber order

Hello,

Please find invoice NG-8841 attached for the September timber order, £2,480.00.

Payment terms are 30 days, so the invoice falls due on ${longDate(dueAt)}.
Our remittance details are unchanged. Shout if you need the delivery notes again.

Kind regards,
Northgate Timber — Accounts
01432 555 118`,
    },
    {
      slug: "newsletter",
      subject: "5 ways to win more repeat business in 2026",
      raw: `From: "Trade Monthly" <newsletter@trademonthly.example>
Subject: 5 ways to win more repeat business in 2026

You're receiving this because you subscribed to Trade Monthly updates.
View this email in your browser.

This month: the pricing mistake that quietly costs you repeat work, how one
three-van operation went from word of mouth to a six-week waiting list, and the
one question to ask at every handover.

Read the full issue →
Unsubscribe · Manage preferences · Privacy policy`,
    },
    {
      slug: "urgent-reschedule",
      subject: "URGENT — Thursday's site visit has to move",
      raw: `From: "Marcus Bell" <marcus.bell@hallworthpm.co.uk>
Subject: URGENT — Thursday's site visit has to move

Sorry for the short notice on this one.

The tenant has locked us out of the building on Thursday, so our visit can't go
ahead as planned. The only slot they can offer now is tomorrow at 2:30pm.

This is urgent — the handover paperwork has a deadline at the end of the month
and we can't sign it off without your inspection.

Can you confirm by the end of the day today?

Marcus
Hallworth Property Management
07700 900 412`,
    },
    {
      slug: "lead-studios",
      subject: "New enquiry — maintenance across three studios",
      raw: `From: "Sofia Almeida" <sofia@almeidafitness.co.uk>
Subject: New enquiry — maintenance across three studios

Hi there,

I run three fitness studios and I'm looking for someone reliable to take on the
maintenance across all of them — roughly two call-outs a month plus the annual
servicing.

Could you quote for a monthly contract? I'd rather sort it before the new year.

Happy to talk it through on a call: are you free next Wednesday at 3pm?

Sofia
Almeida Fitness`,
    },
  ];
}
