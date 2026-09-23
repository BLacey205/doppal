import { createFileRoute, Link } from "@tanstack/react-router";

import { TierGrid } from "~/components/tier-table";
import { WaitlistForm } from "~/components/waitlist-form";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Doppel — the AI clone that does your business admin" },
      {
        name: "description",
        content:
          "Doppel is an AI clone for business owners: it ranks your inbox by importance, turns dates in emails into calendar events with reminders, and drafts replies in your voice. Early access — join the waitlist.",
      },
    ],
  }),
  component: Home,
});

const STEPS = [
  {
    title: "Connect your inbox",
    body: "Authorise Gmail or Outlook, or forward your mail to an address we give you if that's easier to start with. Email is the first channel; the others come after triage works on real mail.",
  },
  {
    title: "See what actually matters",
    body: "Every message is ranked by importance, so the customer waiting on a quote sits above the newsletter. Dates and times written inside a message become calendar events with reminders attached.",
  },
  {
    title: "The reply, the event and the follow-up are already drafted",
    body: "A reply in your voice, ready to edit and send. The appointment already on your calendar. The follow-up queued for the right day. You approve everything that leaves your account.",
  },
];

const FEATURES = [
  {
    tier: "Free",
    title: "Inbox triage",
    body: "Every message ranked by importance, so the thing that needs you today is at the top instead of the newest thing.",
  },
  {
    tier: "Free",
    title: "Dates become events",
    body: "\"Can you come Thursday at 2?\" becomes a calendar event with a reminder — no re-typing it out.",
  },
  {
    tier: "Pro",
    title: "Reply drafts in your voice",
    body: "Doppel learns how you actually write — your tone, your sign-off, your prices — and drafts the reply for you to edit and send.",
  },
  {
    tier: "Pro",
    title: "Lead finding",
    body: "It goes back through the inbox for the people who asked a question and never got an answer, so leads stop dying in a crowded tab.",
  },
  {
    tier: "Pro",
    title: "Proposal drafting",
    body: "Scope, price and terms pulled from the thread you already had, drafted as a proposal you can send after one read.",
  },
  {
    tier: "Pro",
    title: "Workflow automations",
    body: "Rules you set for the recurring jobs: when this kind of email arrives from this kind of sender, do this, and tell me after.",
  },
  {
    tier: "Pro",
    title: "Three connected channels",
    body: "Email, plus the social and ad accounts you actually get enquiries through — connected into the same view.",
  },
  {
    tier: "Business",
    title: "CRM and ads analytics",
    body: "What your sales pipeline and your ad spend are doing, on the same screen as the inbox they came from.",
  },
  {
    tier: "Business",
    title: "One business dashboard",
    body: "The whole business on one page, with a shared workspace so someone other than you can see it.",
  },
];

function Home() {
  return (
    <main>
      {/* Hero */}
      <section className="border-b border-slate-200 bg-gradient-to-b from-indigo-50/70 to-white">
        <div className="mx-auto grid grid-cols-1 max-w-6xl items-center gap-12 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-2">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs font-semibold text-indigo-700">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              Early access — waitlist open
            </p>
            <h1 className="mt-5 text-4xl leading-tight font-bold tracking-tight text-slate-900 sm:text-5xl">
              The recurring admin of your business, done as you.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-700 sm:text-lg">
              Doppel is an AI clone that connects to your email and the tools you already run on. It
              ranks the inbox by what actually matters, turns the dates inside emails into calendar
              events with reminders, and drafts your replies in your voice.
            </p>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-600">
              Doppel has not launched. There is nothing to sign into yet — early access opens in
              waves from the waitlist.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                to="/app"
                search={{ demo: "sample" }}
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-indigo-600 px-6 py-3 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
              >
                See it work on sample mail
              </Link>
              <a
                href="#waitlist"
                className="inline-flex min-h-12 items-center justify-center rounded-lg border border-slate-300 bg-white px-6 py-3 text-center text-sm font-semibold text-slate-800 transition hover:border-slate-400"
              >
                Join the waitlist
              </a>
            </div>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-600">
              The button opens the demo inbox with five sample messages ready — no account, no mail
              account to connect, nothing sent and nothing saved.
            </p>
            <p className="mt-1">
              <a href="#how" className="inline-flex min-h-11 items-center font-semibold text-indigo-600 hover:underline">
                See how it works
              </a>
            </p>
          </div>

          {/* Illustration of the triage view we are building — labelled as such. */}
          <figure className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">Today</p>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                Ranked by importance
              </span>
            </div>
            <ul className="mt-4 space-y-3">
              <li className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-semibold text-slate-900">
                    Quote for the Henderson kitchen
                  </p>
                  <span className="shrink-0 rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-semibold text-white">
                    Needs you
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  Wants a date — Thu 2pm works. Draft reply ready · event on your calendar with a
                  reminder.
                </p>
              </li>
              <li className="rounded-xl border border-slate-200 p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-slate-800">
                    Invoice question from Riverside Clinic
                  </p>
                  <span className="shrink-0 text-xs text-slate-500">Today</span>
                </div>
              </li>
              <li className="rounded-xl border border-slate-200 p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-slate-400">
                    Supplier newsletter
                  </p>
                  <span className="shrink-0 text-xs text-slate-400">Later</span>
                </div>
              </li>
            </ul>
            <figcaption className="mt-4 text-xs leading-relaxed text-slate-500">
              An illustration of the triage view, not a screenshot and not a real customer — the live
              demo you can click through today runs on the sample inbox.
            </figcaption>
          </figure>
        </div>
      </section>

      {/* See it working — the demo is the front door. */}
      <section id="demo" className="scroll-mt-20 border-b border-slate-800 bg-slate-900">
        <div className="mx-auto grid grid-cols-1 max-w-6xl gap-10 px-5 py-14 sm:px-8 sm:py-16 lg:grid-cols-[1.15fr_1fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold tracking-wide text-indigo-300 uppercase">
              Try it now — no sign-in, no mail account
            </p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              See it working on sample mail
            </h2>
            <ul className="mt-6 space-y-3 text-sm leading-relaxed text-slate-200 sm:text-base">
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                <span>
                  One click loads five realistic messages into the demo inbox — nothing to install and
                  nothing to connect.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                <span>
                  Every message is scored and ranked worst-first with a one-line reason, so an urgent
                  reschedule sits above a supplier newsletter.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                <span>
                  The dates and times written inside them are pulled out, and one click puts one on the
                  calendar with a reminder.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                <span>
                  And a reply is already drafted for you to edit and copy. Doppel never sends it.
                </span>
              </li>
            </ul>
            <div className="mt-8">
              <Link
                to="/app"
                search={{ demo: "sample" }}
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
              >
                Open the sample inbox →
              </Link>
            </div>
            <p className="mt-4 max-w-xl text-xs leading-relaxed text-slate-400">
              Early access and a demo: it runs on built-in rules — no model key connected yet — and
              nothing is saved, so the messages are gone when the server restarts. You can also paste
              an email of your own.
            </p>
          </div>

          <ol className="grid grid-cols-1 gap-3">
            {["Ranked worst-first", "Dates found", "Reply drafted"].map((step, index) => (
              <li
                key={step}
                className="flex items-center gap-4 rounded-xl border border-slate-700 bg-slate-800/60 p-4"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-sm font-semibold text-white">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{step}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                    {index === 0
                      ? "5 messages · a score out of 100 and the reason"
                      : index === 1
                        ? "3 dates in the top message, each with its reminder"
                        : "One click to edit, one to copy — nothing sent"}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            How it works
          </h2>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
            Three steps, and the third one is the point: by the time you open your mail, the work
            has already been done for you to approve.
          </p>
          <ol className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="rounded-2xl border border-slate-200 bg-white p-6">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20 border-y border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            What Doppel does
          </h2>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
            This is the plan, in the order we're building it — not a list of finished features.
            The tag on each one is the tier it's planned for.
          </p>
          <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6"
              >
                <span className="self-start rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                  {feature.tier}
                </span>
                <h3 className="mt-3 text-base font-semibold text-slate-900">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{feature.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
            <h3 className="text-base font-semibold text-slate-900">
              What Doppel does not do yet — so you know what you're signing up for
            </h3>
            <ul className="mt-4 grid grid-cols-1 gap-3 text-sm leading-relaxed text-slate-600 sm:grid-cols-2">
              <li>
                It drafts replies; it does not send them on its own. In the first version you approve
                everything that leaves your account.
              </li>
              <li>
                It starts with email. Social channels, ads and CRM data come after triage has been
                proven on real mail.
              </li>
              <li>
                There are no team accounts and no analytics dashboard in the first version — those
                sit in the Business tier, planned for later.
              </li>
              <li>
                We'll tell you what it can and can't do before you pay anything. No trial that
                quietly becomes a subscription.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            Early-access pricing
          </h2>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
            Three tiers, priced for what we intend to ship. Nothing is billed today — the Free tier
            covers triage, calendar and reminders, and every paid tier is waitlist-only for now.
          </p>
          <div className="mt-10">
            <TierGrid />
          </div>
          <p className="mt-8">
            <Link
              to="/pricing"
              className="inline-flex min-h-11 items-center text-sm font-semibold text-indigo-700 underline decoration-indigo-300 underline-offset-4 transition hover:text-indigo-900"
            >
              See the full tier comparison →
            </Link>
          </p>
        </div>
      </section>

      {/* Waitlist */}
      <section id="waitlist-section" className="scroll-mt-20 border-t border-slate-200 bg-indigo-50/50">
        <div className="mx-auto grid grid-cols-1 max-w-6xl gap-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Get on the list
            </h2>
            <p className="mt-3 max-w-lg text-base leading-relaxed text-slate-700">
              Early access opens in waves, smallest first — service businesses with a real inbox and
              real work orders go first, because that's the mail we most need to see triage work on.
            </p>
            <p className="mt-4 max-w-lg text-sm leading-relaxed text-slate-600">
              Two fields are enough. We'll email you once when it's your turn, and nothing else. We
              can't give you a launch date yet — we'd rather keep this honest than put a countdown on
              it.
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
