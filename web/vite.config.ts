import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is served from the same origin in the browser's eyes, so the session cookie stays SameSite=Strict.
    proxy: { "/api": "http://localhost:4000" },
  },
});
