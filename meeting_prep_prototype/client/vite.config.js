import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeServerEnvDir = path.join(__dirname, "../server");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, prototypeServerEnvDir, "MEETING_PREP_PROTOTYPE_");
  const apiPort = Number(env.MEETING_PREP_PROTOTYPE_PORT) || 3851;

  return {
    plugins: [react()],
    server: {
      port: 5174,
      proxy: {
        "/generate": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
        "/health": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});
