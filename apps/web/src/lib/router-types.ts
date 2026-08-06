import "@tanstack/react-router"

/**
 * Per-route static metadata. `crumb` drives the app-shell breadcrumb trail
 * (see components/app-shell/breadcrumbs.tsx) — set it in a route's
 * `staticData` when the route should appear in the trail. Routes with
 * dynamic segments (eg. `$projectId`) omit it and the breadcrumb falls back
 * to the raw param value.
 */
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    crumb?: string
  }
}
