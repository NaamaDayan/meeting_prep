# Meeting Prep AI — prototype

## Run locally

```bash
cd meeting_prep_prototype
npm run setup
cp server/.env.example server/.env   # optional: add OPENAI_API_KEY
npm run dev
```

Open **http://localhost:5174**. The prototype API listens on **http://127.0.0.1:3851** by default (set `MEETING_PREP_PROTOTYPE_PORT` in `server/.env`; proxied by Vite as `/generate` and `/health`). The main app in `server/` uses **`PORT`** (default **3847**). Do not reuse `PORT` for the prototype, or a shared shell `PORT` can make both servers bind to the same port.

Without `OPENAI_API_KEY`, the server returns a fixed mock briefing JSON so the UI can be exercised end-to-end.

**Sanity check:** open **http://localhost:5174/health** (via Vite proxy). You should see `"service":"meeting_prep_prototype"`, `"version":2`, and `"openai_configured":true`. If you only see `{"ok":true}` or the wrong `service`, the browser is not reaching this prototype API (wrong port or old process).

**If the key is in `server/.env` but you still see the mock:** ensure `openai_configured` is true on that health JSON. The server logs `Loaded env from …` and whether the OpenAI key was found when it starts.
