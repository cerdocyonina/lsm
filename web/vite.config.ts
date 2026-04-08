import dotenv from "dotenv";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

dotenv.config({ path: ".env", quiet: true });

const adminPath = process.env.ADMIN_PATH?.trim().replace(/^\/+|\/+$/g, "");

if (!adminPath || !/^[A-Za-z0-9_-]{12,}$/.test(adminPath)) {
  throw new Error(
    "ADMIN_PATH must be set in .env and contain at least 12 characters using only letters, numbers, underscores, or hyphens.",
  );
}

const adminBasePath = `/${adminPath}/`;
const adminApiPrefix = `${adminBasePath.slice(0, -1)}/api`;
const adminPort = process.env.ADMIN_PORT?.trim();

if (!adminPort || !/^\d+$/.test(adminPort)) {
  throw new Error("ADMIN_PORT must be set in .env to a valid numeric port.");
}

export default defineConfig({
  root: "web",
  base: adminBasePath,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${adminPort}`,
        changeOrigin: true,
        rewrite: (path) => `${adminApiPrefix}${path.slice(4)}`,
      },
    },
  },
});
