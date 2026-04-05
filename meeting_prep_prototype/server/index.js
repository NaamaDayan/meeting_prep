import "./loadEnv.js";
import { createApp } from "./app.js";

/** Dedicated var so a shell `PORT` (e.g. 3847 for the main server) never collides. */
const PORT = Number(process.env.MEETING_PREP_PROTOTYPE_PORT) || 3851;

const app = createApp();

app.listen(PORT, () => {
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasSerp = Boolean(process.env.SERPAPI_KEY?.trim());
  console.log(`Meeting prep prototype API http://localhost:${PORT}`);
  console.log(
    hasKey
      ? "OpenAI: API key loaded from server/.env"
      : "OpenAI: no API key — briefings use mock JSON"
  );
  console.log(
    hasSerp
      ? "SerpAPI: SERPAPI_KEY set — enrichment enabled"
      : "SerpAPI: no SERPAPI_KEY — enrichment skipped (see health / UI banner)"
  );
});
