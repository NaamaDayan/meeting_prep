import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load server/.env only when running outside Lambda (local dev). */
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const envPath = path.join(__dirname, ".env");
  const envResult = dotenv.config({
    path: envPath,
    override: true,
  });
  if (envResult.error) {
    console.warn("[meeting_prep_prototype] Could not load .env:", envResult.error.message);
  } else {
    console.log("[meeting_prep_prototype] Loaded env from", envPath);
  }
}
