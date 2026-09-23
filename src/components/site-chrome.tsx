import { Link } from "@tanstack/react-router";

/**
 * Shared header and footer. Every link here resolves to a real page or a real
 * anchor on one — no placeholders, no dead ends.
 */

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <svg
        aria-hidden
        viewBox="0 0 28 28"
        className="h-7 w-7 text-indigo-600"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="11" cy="14" r="7" />
        <circle cx="17" cy="14" r="7" className="opacity-60" />
      </svg>
      <span className="text-lg font-bold tracking-tight text-slate-900">Doppel</span>
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
        <Link to="/" aria-label="Doppel home">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-7 text-sm font-medium text-slate-600 md:flex">
          <Link to="/" hash="how" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
            How it works
          </Link>
          <Link to="/" hash="features" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
            Features
          </Link>
          <Link to="/pricing" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
            Pricing
          </Link>
        </nav>

        <a
          href="/#waitlist"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          Join the waitlist
        </a>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-600">
              An AI clone that does a business owner's recurring admin as them — starting with the
              inbox.
            </p>
          </div>

          <div>
            <h2 className="text-xs font-semibold tracking-wide text-slate-900 uppercase">
              The product
            </h2>
            <ul className="mt-3 space-y-1 text-sm text-slate-600">
              <li>
                <Link to="/" hash="how" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
                  How it works
                </Link>
              </li>
              <li>
                <Link to="/" hash="features" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
                  What it does
                </Link>
              </li>
              <li>
                <Link to="/pricing" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
                  Pricing
                </Link>
              </li>
              <li>
                <a href="/#waitlist" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
                  Join the waitlist
                </a>
              </li>
              <li>
                <Link to="/app" className="inline-flex min-h-9 items-center transition hover:text-slate-900">
                  Product preview — the inbox wedge
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-xs font-semibold tracking-wide text-slate-900 uppercase">
              Where we are
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              Doppel is in early access and hasn't launched. There's no public product to sign into
              yet and no launch date to promise — the waitlist is the only way in.
            </p>
          </div>
        </div>

        <p className="mt-10 border-t border-slate-200 pt-6 text-xs text-slate-500">
          © {new Date().getFullYear()} Doppel. Early-access pricing shown on this site is what we
          intend to charge at launch; nothing is billed today.
        </p>
      </div>
    </footer>
  );
}
