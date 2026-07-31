import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The API is proxied rather than called cross-origin.
 *
 * The server sets permissive CORS, so a direct call would work — but proxying
 * means the client ships with no base URL to configure and no environment
 * variable to forget. `npm run dev` in a fresh clone reaches the API with no
 * setup, which is exactly the step the clean-clone test checks.
 *
 * VITE_API_URL overrides the target for anyone running the API on another port.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: process.env["VITE_API_URL"] ?? "http://localhost:4000",
                changeOrigin: true,
            },
        },
    },
});
