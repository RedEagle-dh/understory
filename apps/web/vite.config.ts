import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    proxy: {
      // Keep the better-auth session cookie first-party in dev.
      "/api": { target: "http://localhost:3001", changeOrigin: false },
      "/ready": { target: "http://localhost:3001", changeOrigin: false },
    },
  },
  preview: {
    // Bind to a literal IPv4 loopback: the build's own prerender step spins
    // up this preview server and fetches its own "/" through Bun's fetch()
    // to render the SPA shell. Left as the bare "localhost" default, the
    // server and Bun's fetch can resolve that hostname to different loopback
    // families (::1 vs 127.0.0.1) inside minimal containers (observed in the
    // Docker build), so the self-fetch gets ECONNREFUSED. A literal IP needs
    // no resolution and sidesteps the mismatch entirely.
    host: "127.0.0.1",
  },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
})

export default config
