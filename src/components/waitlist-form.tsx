import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { joinWaitlist } from "~/lib/waitlist";

const BUSINESS_TYPES = [
  "Trades / home services",
  "Agency / consulting",
  "Clinic / health practice",
  "Creator / coaching",
  "E-commerce / retail",
  "Something else",
];

type FormState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; status: "joined" | "already"; email: string }
  | { kind: "problem"; message: string };

export function WaitlistForm() {
  const submit = useServerFn(joinWaitlist);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [state, setState] = useState<FormState>({ kind: "idle" });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind === "submitting") return;
    setState({ kind: "submitting" });
    const submittedEmail = email.trim();
    try {
      const result = await submit({
        data: {
          email: submittedEmail,
          name: name.trim() || undefined,
          businessType: businessType || undefined,
        },
      });
      if (result.status === "joined" || result.status === "already") {
        setState({ kind: "done", status: result.status, email: submittedEmail });
      } else {
        setState({ kind: "problem", message: result.message });
      }
    } catch (err) {
      // A network failure must still read like a sentence, not a stack trace.
      console.error("[waitlist] submit failed:", err);
      setState({
        kind: "problem",
        message:
          "We couldn't reach the server just then. Nothing was saved — please try again in a moment.",
      });
    }
  }

  if (state.kind === "done") {
    return (
      <div
        id="waitlist"
        className="scroll-mt-24 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-6 sm:p-8"
      >
        <div aria-live="polite">
          <p className="text-xs font-semibold tracking-wide text-emerald-700 uppercase">
            {state.status === "joined" ? "You're on the list" : "Already on the list"}
          </p>
          <h3 className="mt-2 text-xl font-semibold text-slate-900 sm:text-2xl">
            {state.status === "joined"
              ? `Thanks — we've got ${state.email}.`
              : `You're already on the list as ${state.email}.`}
          </h3>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-700">
            {state.status === "joined"
              ? "We'll email you when early access opens and it's your turn. There's no launch date to give you yet — we'd rather hand you something that works than a date we can't keep."
              : "Nothing more to do — your spot is unchanged. We'll email you when early access opens."}
          </p>
          <button
            type="button"
            onClick={() => {
              setState({ kind: "idle" });
              setEmail("");
            }}
            className="mt-5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
          >
            Add a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      id="waitlist"
      onSubmit={onSubmit}
      noValidate={false}
      className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label
            htmlFor="waitlist-email"
            className="block text-sm font-medium text-slate-800"
          >
            Work email <span className="text-rose-600">*</span>
          </label>
          <input
            id="waitlist-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@yourbusiness.com"
            className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        <div>
          <label htmlFor="waitlist-name" className="block text-sm font-medium text-slate-800">
            Your name <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <input
            id="waitlist-name"
            name="name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Sam Patel"
            className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        <div>
          <label
            htmlFor="waitlist-business"
            className="block text-sm font-medium text-slate-800"
          >
            What kind of business?{" "}
            <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <select
            id="waitlist-business"
            name="businessType"
            value={businessType}
            onChange={(event) => setBusinessType(event.target.value)}
            className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          >
            <option value="">Prefer not to say</option>
            {BUSINESS_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.kind === "problem" ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {state.message}
        </p>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={state.kind === "submitting"}
          className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus:ring-2 focus:ring-indigo-300 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.kind === "submitting" ? "Adding you…" : "Join the waitlist"}
        </button>
        <p className="text-xs leading-relaxed text-slate-500">
          One email when early access opens. No newsletter, no launch-date promises.
        </p>
      </div>
    </form>
  );
}
