/**
 * Tier table for the early-access pricing page.
 *
 * One source of copy, two layouts: a stacked card per tier on phones (a wide
 * table is unusable there) and a real comparison <table> from `md` up. Every CTA
 * points at the waitlist — nothing is purchasable yet, and we say so.
 */

type Tier = {
  id: string;
  name: string;
  price: string;
  tagline: string;
  cta: string;
  highlighted?: boolean;
  features: string[];
};

const TIERS: Tier[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    tagline: "For getting the inbox under control before you pay us anything.",
    cta: "Get started free",
    features: [
      "Inbox triage — every message ranked by importance",
      "Dates and times in an email become calendar events, with reminders",
      "One connected inbox",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$29",
    tagline: "The clone does the writing as well as the sorting.",
    cta: "Join the waitlist",
    highlighted: true,
    features: [
      "Everything in Free",
      "Reply drafts in your voice, ready to edit and send",
      "Lead finding",
      "Proposal drafting",
      "Workflow automations you configure",
      "Three connected channels",
    ],
  },
  {
    id: "business",
    name: "Business",
    price: "$99",
    tagline: "For a business with more than one channel and more than one person.",
    cta: "Join the waitlist",
    features: [
      "Everything in Pro",
      "Multi-channel, plus CRM and ads analytics",
      "One dashboard for the whole business",
      "Shared team workspace",
      "Priority support",
    ],
  },
];

/** Feature-by-feature comparison. `true` renders a tick, a string renders as-is. */
const MATRIX: { label: string; free: string | boolean; pro: string | boolean; business: string | boolean }[] =
  [
    { label: "Inbox triage — ranked by importance", free: true, pro: true, business: true },
    { label: "Emails become calendar events with reminders", free: true, pro: true, business: true },
    { label: "Connected inboxes and channels", free: "1 inbox", pro: "3 channels", business: "3 channels" },
    { label: "Reply drafts in your voice", free: false, pro: true, business: true },
    { label: "Lead finding", free: false, pro: true, business: true },
    { label: "Proposal drafting", free: false, pro: true, business: true },
    { label: "Workflow automations", free: false, pro: true, business: true },
    { label: "CRM and ads analytics", free: false, pro: false, business: true },
    { label: "One business dashboard", free: false, pro: false, business: true },
    { label: "Shared team workspace", free: false, pro: false, business: true },
    { label: "Priority support", free: false, pro: false, business: true },
  ];

function Tick() {
  return (
    <span className="text-indigo-600" aria-label="included">
      ✓
    </span>
  );
}

function Dash() {
  return (
    <span className="text-slate-300" aria-label="not included">
      —
    </span>
  );
}

function Cell({ value }: { value: string | boolean }) {
  if (value === true) return <Tick />;
  if (value === false) return <Dash />;
  return <span className="text-slate-700">{value}</span>;
}

export function TierTable() {
  return (
    <div>
      <p className="max-w-2xl text-sm text-slate-600">
        <span className="font-semibold text-slate-900">Early-access launch pricing.</span> These are
        the prices we intend to charge at launch, in USD per month. Nothing is billed today — the
        only thing open is the waitlist.
      </p>

      {/* Phones: one card per tier. */}
      <div className="mt-8 md:hidden">
        <TierGrid />
      </div>

      {/* Tablet and up: a real comparison table. */}
      <div className="mt-8 hidden md:block">
        <table className="w-full border-separate border-spacing-0 text-left text-sm">
          <caption className="sr-only">
            Doppel early-access tiers: Free, Pro and Business, with the capabilities planned for each.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-2/5 border-b border-slate-200 pb-4 align-bottom">
                <span className="sr-only">Capability</span>
              </th>
              {TIERS.map((tier) => (
                <th
                  key={tier.id}
                  scope="col"
                  className={
                    tier.highlighted
                      ? "w-1/5 border-b-2 border-indigo-500 bg-indigo-50/50 px-4 pb-4 align-bottom"
                      : "w-1/5 border-b border-slate-200 px-4 pb-4 align-bottom"
                  }
                >
                  <span className="block text-base font-semibold text-slate-900">{tier.name}</span>
                  <span className="mt-1 block">
                    <span className="text-2xl font-bold tracking-tight text-slate-900">
                      {tier.price}
                    </span>
                    <span className="text-xs text-slate-500">/month</span>
                  </span>
                  <a
                    href="/#waitlist"
                    className={
                      tier.highlighted
                        ? "mt-3 inline-block rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
                        : "mt-3 inline-block rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 transition hover:border-slate-400"
                    }
                  >
                    {tier.cta}
                  </a>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MATRIX.map((row) => (
              <tr key={row.label}>
                <th scope="row" className="border-b border-slate-100 py-3 pr-4 font-normal text-slate-700">
                  {row.label}
                </th>
                <td className="border-b border-slate-100 px-4 py-3 text-center">
                  <Cell value={row.free} />
                </td>
                <td className="border-b border-slate-100 bg-indigo-50/50 px-4 py-3 text-center">
                  <Cell value={row.pro} />
                </td>
                <td className="border-b border-slate-100 px-4 py-3 text-center">
                  <Cell value={row.business} />
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="py-4 pr-4 font-normal text-slate-500">
                What it's for
              </th>
              {TIERS.map((tier) => (
                <td key={tier.id} className="px-4 py-4 align-top text-xs leading-relaxed text-slate-500">
                  {tier.tagline}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-slate-500">
        Everything in the table is planned, not shipped: Doppel is in early access, and the order we
        build it in follows the waitlist. Prices may change before launch.
      </p>
    </div>
  );
}

export function TierGrid() {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3">
      {TIERS.map((tier) => (
        <div
          key={tier.id}
          className={
            tier.highlighted
              ? "flex flex-col rounded-2xl border-2 border-indigo-500 bg-white p-6 shadow-sm"
              : "flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          }
        >
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-lg font-semibold text-slate-900">{tier.name}</h3>
            {tier.highlighted ? (
              <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                Most complete
              </span>
            ) : null}
          </div>
          <p className="mt-3">
            <span className="text-3xl font-bold tracking-tight text-slate-900">{tier.price}</span>
            <span className="text-sm text-slate-500">/month</span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">{tier.tagline}</p>
          <ul className="mt-5 flex-1 space-y-2.5">
            {tier.features.map((feature) => (
              <li key={feature} className="flex gap-2.5 text-sm text-slate-700">
                <span aria-hidden className="mt-0.5 text-indigo-600">
                  ✓
                </span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <a
            href="/#waitlist"
            className={
              tier.highlighted
                ? "mt-6 block rounded-lg bg-indigo-600 px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-indigo-500"
                : "mt-6 block rounded-lg border border-slate-300 px-4 py-3 text-center text-sm font-semibold text-slate-800 transition hover:border-slate-400"
            }
          >
            {tier.cta}
          </a>
        </div>
      ))}
    </div>
  );
}
