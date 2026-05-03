import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import NavBar from "~/components/nav/NavBar";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&family=Source+Sans+3:wght@300;400;600;700&family=Poppins:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Radix Labor Analysis</title>
        <Meta />
        <Links />
      </head>
      <body className="bg-dash-bg text-dash-text font-body">
        <NavBar />
        <main>{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <div className="pt-16 p-4 container mx-auto">
      <h1 className="text-2xl font-heading font-bold">{message}</h1>
      <p className="mt-2">{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto mt-4 bg-dash-surface rounded-lg border border-dash-border">
          <code className="font-mono text-sm">{stack}</code>
        </pre>
      )}
    </div>
  );
}
