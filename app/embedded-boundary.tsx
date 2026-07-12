// Shared error boundary for embedded admin routes.
//
// The FIRST client-side navigation after a cold embedded load can race App
// Bridge's session-token boot: the route's .data fetch goes out with no
// id_token (server logs the auth as {shop: null}), the auth bounce surfaces as
// a 404/410 route error, and a plain document reload always recovers (document
// loads run the token exchange up front). Every route-level boundary must use
// THIS component — the first fix (2026-07-10) only patched the app.tsx parent
// boundary, but child routes exporting their own ErrorBoundary caught the
// error first and still stranded the merchant on "404 Not Found".
import { isRouteErrorResponse, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export function EmbeddedErrorBoundary() {
  const error = useRouteError();
  if (
    typeof window !== "undefined" &&
    isRouteErrorResponse(error) &&
    (error.status === 404 || error.status === 410)
  ) {
    const last = Number(sessionStorage.getItem("shq-auth-retry") || 0);
    // Timestamp guard: retry at most once per 10s so a genuine 404 can't loop.
    if (Date.now() - last > 10_000) {
      sessionStorage.setItem("shq-auth-retry", String(Date.now()));
      window.location.reload();
      return null;
    }
  }
  return boundary.error(error);
}
