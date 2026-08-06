import { treaty } from "@elysiajs/eden"
import type { AppEden } from "@workspace/api"

export { ApiError, unwrap } from "./api-error"

/**
 * Typed Eden treaty client. Same-origin in the browser (vite proxies /api to
 * the API in dev; production serves SPA + API from one origin), env-driven on
 * the server (only relevant for prerendering, which fetches nothing).
 */
const baseUrl =
  typeof window === "undefined"
    ? (process.env.API_URL ?? "http://localhost:3001")
    : window.location.origin

export const api = treaty<AppEden>(baseUrl, {
  fetch: { credentials: "include" },
})
