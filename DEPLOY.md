# Meeting Prep — Deployment and configuration

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP port (default `3847`). |
| `OPENAI_API_KEY` | No | If unset or empty, prep and person enrichment use **mock placeholder text** (no OpenAI calls). Set for real AI output. |
| `OPENAI_MODEL` | No | Model name (default `gpt-4o-mini`). |
| `TAVILY_API_KEY` | No* | Tavily search API for participant research. |
| `SERPAPI_KEY` | No* | SerpAPI fallback if Tavily is not set. |
| `PERSISTENCE` | No | `file` (default) or `dynamo`. |
| `MEETING_PREP_DEV_FILE` | No | Path to JSON file store (default `data/preps.json` under `server/`). |
| `AWS_REGION` | For Dynamo | AWS region. |
| `DYNAMODB_TABLE_NAME` | For Dynamo | DynamoDB table name. |
| `ADMIN_TOKEN` | No | If set, required as `X-Admin-Token` for `POST /admin/clear-prep-cache`. |

\* Without search keys, the server still runs but uses placeholder search context; real LinkedIn/company resolution works best with Tavily or SerpAPI.

## Local development

1. Copy `server/.env.example` to `server/.env` and set `OPENAI_API_KEY`.
2. From `server/`: `npm install` then `npm start` (or run `node server/server.js` from the repo root — `env.js` loads `server/.env` next to `server.js`, so the working directory does not matter).
3. In Chrome, load the `extension/` folder as an unpacked extension.
4. In **Google Cloud Console**, create an **OAuth 2.0 Client ID** of type **Chrome extension** and paste its ID into `extension/manifest.json` (`oauth2.client_id`).
5. Add the OAuth extension ID to the client’s authorized origins if needed.
6. Open the extension **Options** page and set the backend base URL to `http://127.0.0.1:3847` (or your host/port).
7. If the backend is not on `localhost` / `127.0.0.1`, add that origin’s URL pattern to `extension/manifest.json` under `host_permissions` (MV3 does not allow arbitrary HTTPS origins without listing them).

## DynamoDB (production)

Create a table with:

- **Partition key**: `pk` (String).

The application stores items with `pk = `${userSub}#${encodeURIComponent(eventId)}`` (plus attributes such as `userSub`, `calendarEventId`, `prep`, `userEdits`, etc.).

Set `PERSISTENCE=dynamo` and `DYNAMODB_TABLE_NAME` (and IAM credentials via the usual AWS environment or instance role).

## Extension OAuth

- Scopes: `calendar.readonly`, `openid`, `userinfo.email`, `userinfo.profile` (see `manifest.json`).
- The backend validates the same Google OAuth **access token** the extension sends in `Authorization: Bearer <token>` via `https://www.googleapis.com/oauth2/v3/userinfo`.

### Chrome extension client (required)

`chrome.identity.getAuthToken` only works with an OAuth client whose **type** is **Chrome extension** in Google Cloud. A **Web application** or **Desktop** client ID in `manifest.json` will often produce:

`OAuth2 request failed: … 'bad client id'`.

Do this:

1. Open `chrome://extensions`, turn on **Developer mode**, load this extension **unpacked**.
2. Copy the **Extension ID** (32 characters, e.g. `abcdefghijklmnopqrstuvwxyzabcdef`).
3. In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**.
4. If prompted, configure the **OAuth consent screen** (External + test users if in testing).
5. Application type: **Chrome extension**.
6. **Item ID** (or “Extension ID”): paste the ID from step 2 exactly.
7. Create, then copy the **Client ID** (ends with `.apps.googleusercontent.com`).
8. Put it in `extension/manifest.json` under `oauth2.client_id`.
9. Click **Reload** on the extension card in `chrome://extensions`.

If you change the unpacked folder or install a different build, the Extension ID can change—create a new Chrome-extension OAuth client or edit the existing one so the Item ID matches the current ID.

### APIs to enable

In the same Google Cloud project, enable **Google Calendar API** (for Calendar reads from the background script).

## Health check

`GET /health` returns `{ ok: true, ... }` without authentication.
