import { createFileRoute } from "@tanstack/react-router";

import { TierTable } from "~/components/tier-table";
import { WaitlistForm } from "~/components/waitlist-form";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Doppel early access" },
      {
        name: "description",
        content:
          "Doppel's early-access tiers: Free ($0) for inbox triage, calendar and reminders; Pro ($29/mo) for reply drafts, lead finding and proposals; Business ($99/mo) for multi-channel, CRM and ads analytics. Nothing is billed today.",
      },
    ],
  }),
  component: Pricing,
});

const QUESTIONS = [
  {
    q: "When does this launch?",
    a: "We don't know yet, and we'd rather not pretend. Doppel is in early access and hasn't shipped; there's no launch date to give you. Waitlist invitations go out in waves, smallest first.",
  },
  {
    q: "What can I use today?",
    a: "Nothing — there's no product to sign into yet. This page exists so you can see what's planned, decide whether it's worth your inbox, and get in the queue.",
  },
  {
    q: "Will I be billed when a tier opens?",
    a: "No. Nothing on this page takes a payment, and there's no card on file. If you're invited in, you'll see exactly what the version you're getting does before you pay for anything.",
  },
  {
    q: "Will Doppel send replies on its own?",
    a: "Not in the first version. It drafts; you read, edit and send. Automations that act without you are a Pro feature we'll build after triage has been proven on real mail — and you'll always be able to turn them off.",
  },
  {
    q: "Which channels come first?",
    a: "Email, always. Gmail or Outlook, or a forwarding address if you'd rather not authorise anything. Social channels, ads and CRM data come after the inbox works properly.",
  },
];

function Pricing() {
  return (
    <main>
      <section className="border-b border-slate-200 bg-gradient-to-b from-indigo-50/70 to-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
          <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs font-semibold text-indigo-700">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
            Early access — waitlist open
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl leading-tight font-bold tracking-tight text-slate-900 sm:text-5xl">
            Plans and early-access pricing
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-700 sm:text-lg">
            Three tiers: one to get your inbox under control for nothing, one for the clone doing the
            writing, one for a business with several channels and more than one person in it.
          </p>
        </div>
      </section>

      <section className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
          <TierTable />
        </div>
      </section>

      <section className="border-y border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-16">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Straight answers
          </h2>
          <dl className="mt-8 space-y-6">
            {QUESTIONS.map((item) => (
              <div key={item.q} className="rounded-2xl border border-slate-200 bg-white p-6">
                <dt className="text-base font-semibold text-slate-900">{item.q}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-slate-600">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="scroll-mt-20">
        <div className="mx-auto grid grid-cols-1 max-w-6xl gap-10 px-5 py-14 sm:px-8 sm:py-16 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Join the waitlist
            </h2>
            <p className="mt-3 max-w-lg text-base leading-relaxed text-slate-700">
              Any tier starts here. You'll pick the plan when early access opens, not now — and the
              Free tier is free, so there's nothing to commit to either way.
            </p>
          </div>
          <div>
            <WaitlistForm />
          </div>
        </div>
      </section>
    </main>
  );
}
