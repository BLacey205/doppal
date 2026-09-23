import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SiteFooter, SiteHeader } from "~/components/site-chrome";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Doppel — the AI clone that does your business admin" },
      {
        name: "description",
        content:
          "Doppel is an AI clone for business owners: it ranks your inbox by importance, turns dates in emails into calendar events, and drafts your replies in your voice. Early access — join the waitlist.",
      },
      { name: "color-scheme", content: "light" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: NotFound,
  component: RootComponent,
});

function NotFound() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col items-start px-5 py-20 sm:px-8">
      <p className="text-xs font-semibold tracking-wide text-indigo-600 uppercase">
        Page not found
      </p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
        That page doesn't exist.
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-slate-600">
        The link may be old, or the page may not be built yet — Doppel is still in early access.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          to="/"
          className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          Back to the home page
        </Link>
        <a
          href="/#waitlist"
          className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-800 transition hover:border-slate-400"
        >
          Join the waitlist
        </a>
      </div>
    </main>
  );
}

function RootComponent() {
  return (
    <RootDocument>
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <div className="flex-1">
          <Outlet />
        </div>
        <SiteFooter />
      </div>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
