import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadIfExists(filename, override = false) {
  const fullPath = path.join(__dirname, filename);
  if (!fs.existsSync(fullPath)) return;
  dotenv.config({ path: fullPath, override });
}

const requestedEnv = String(process.env.APP_ENV || process.env.NODE_ENV || "").trim().toLowerCase();

loadIfExists(".env");
if (requestedEnv) {
  loadIfExists(`.env.${requestedEnv}`, true);
}
