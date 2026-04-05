# Meeting Prep Server

This directory contains the local backend for the Meeting Prep extension. It authenticates requests using Google access tokens, resolves meeting participants, generates meeting-prep content, and persists per-user prep for saved Calendar events.

## What The Server Does

- Verifies Google Bearer tokens and derives a stable user identity from Google `sub`.
- Accepts meeting snapshots from the extension.
- Resolves attendees into richer participant profiles.
- Generates structured prep content using OpenAI.
- Persists meeting prep per user and per Calendar event ID.
- Stores user edits separately from generated prep, then merges them on read.
- Supports manual participant corrections and regenerates prep after a fix.

## Runtime Overview

- HTTP framework: Express
- Auth source: Google `userinfo` endpoint
- AI provider: OpenAI
- Search provider:
  - Tavily if `TAVILY_API_KEY` is set
  - SerpAPI if `SERPAPI_KEY` is set
  - placeholder/fallback context if neither is set
- Persistence:
  - local JSON file by default
  - DynamoDB when `PERSISTENCE=dynamo`

## File Map

- `server.js`: Express app, routes, and local HTTP entrypoint.
- `lambda.js`: AWS Lambda handler for API Gateway.
- `config.js`: runtime mode, persistence, AWS, and CORS configuration.
- `auth.js`: Google token validation middleware.
- `openai.js`: participant enrichment and prep generation.
- `search.js`: external web search adapter.
- `scorer.js`: heuristic scoring for candidate search hits.
- `resolvePerson.js`: person-resolution pipeline.
- `resolver.js`: resolves all participants in a meeting.
- `cache.js`: in-memory LRU cache.
- `persistence/index.js`: persistence adapter selection.
- `persistence/fileAdapter.js`: JSON-file persistence for local/dev use.
- `persistence/dynamoAdapter.js`: DynamoDB persistence for production-like use.
- `env.js`: loads environment variables from `.env` and `.env.<APP_ENV>`.
- `data/preps.json`: local persisted data when file storage is enabled.

## Environment Variables

The server loads `.env` automatically from this directory, and also loads `.env.<APP_ENV>` if present.

Expected variables:

- `PORT`: server port. Default `3847`.
- `APP_ENV`: `development` or `production`. Defaults to `development` locally and `production` on Lambda.
- `OPENAI_API_KEY`: required for real AI generation.
- `OPENAI_API_KEY` may be either the raw secret value or an SSM parameter path such as `/openai/api_key_meeting_prep`.
- `OPENAI_MODEL`: optional model override. Default `gpt-4o-mini`.
- `TAVILY_API_KEY`: optional; preferred search provider.
- `SERPAPI_KEY`: optional fallback search provider.
- `TAVILY_API_KEY` and `SERPAPI_KEY` may also be provided as SSM parameter paths.
- `PERSISTENCE`: `file` or `dynamo`. Default `file`.
- `MEETING_PREP_DEV_FILE`: JSON file path for local persistence. Default `data/preps.json`.
- `AWS_REGION`: used when `PERSISTENCE=dynamo`.
- `AWS_REGION`: optional. Lambda usually provides it automatically, and the code falls back to `us-east-1`.
- `DYNAMODB_TABLE_NAME`: required when `PERSISTENCE=dynamo`.
- `CORS_ALLOWED_ORIGINS`: comma-separated explicit production origins, such as `chrome-extension://<id>`.
- `CORS_ALLOW_CHROME_EXTENSION_IN_DEV`: defaults to `true` for easier local extension testing.
- `ADMIN_TOKEN`: optional token for the admin cache-clear route.

## Important Assumptions

- Every authenticated request belongs to a single Google account, identified by Google `sub`, not by email.
- Saved meetings have stable Calendar event IDs and can be persisted durably.
- Unsaved meetings may still be generated, but cannot be treated as durable records because they do not have a reliable server-side event ID.
- Participant resolution quality depends heavily on search results and available attendee information.
- User edits must win over generated sections during reads.
- Meeting prep is tenant-scoped: one user’s prep is not visible to another user, even for the same event ID.
- The server trusts the extension to send a meaningful meeting snapshot, but still enforces auth and basic validation.

## Request Flow

## 1. Authentication

All non-health routes pass through `authMiddleware()`:

- reads `Authorization: Bearer <token>`
- calls Google `userinfo`
- extracts:
  - `sub`
  - `email`
  - `name`
- attaches the user to `req.user`

If token validation fails, the request is rejected with `401`.

## 2. Prep Generation

Main route: `POST /manual-prep`

Input fields used:

- `calendarEventId`
- `title`
- `participants[]`
- `startIso`

Behavior:

- if both title and participant emails are empty, returns `400`
- if `calendarEventId` is missing:
  - resolves participants
  - generates prep
  - returns a non-persisted result with `eventId: null`
- if `calendarEventId` exists:
  - loads any existing persisted prep for that user and event
  - compares current `title` and sorted participant emails against stored metadata
  - if unchanged, reuses stored prep and reapplies user edits
  - if changed, regenerates prep and preserves existing user edits

The server stores generated prep and user edits separately, then returns a merged representation to the client.

## 3. Participant Resolution

Participant resolution is a best-effort pipeline:

1. Normalize attendee email and display name.
2. Apply manual overrides first, if available.
3. Search the web for likely profile matches.
4. Score results heuristically, favoring name matches and LinkedIn URLs.
5. Ask OpenAI to produce:
   - `linkedinUrl`
   - `company`
   - `summary`
6. Assign a coarse confidence level: `high`, `medium`, or `low`.

If resolution fails for a participant, the server still returns a low-confidence unresolved record rather than failing the whole meeting.

## 4. Prep Generation Model

`generateMeetingPrep()` asks OpenAI for JSON with four sections:

- `participantsInfo`
- `agenda`
- `questionsBefore`
- `questionsInMeeting`

If `OPENAI_API_KEY` is missing, the server returns mock placeholder content instead of failing. This makes local development possible, but the output is intentionally synthetic.

## Persistence Model

Each persisted record contains:

- `userSub`
- `calendarEventId`
- `title`
- `emailsSorted`
- `startIso`
- `prep`
- `userEdits`
- `manualParticipantResolutions`
- `participantsResolved`
- `updatedAt`
- `prepVersion`
- `meta`

### Merge Rules

Generated prep and user edits are merged section-by-section:

- if a user-edited section is non-empty, it wins
- otherwise the generated section is used

This lets regeneration update untouched sections without discarding manual edits.

### Stale Edit Signaling

If a meeting is regenerated because title or attendee metadata changed and prior user edits existed, the server sets:

```json
{ "editStale": true }
```

The extension uses that flag to warn the user that meeting details changed since the last edit.

## Routes

- `GET /health`
  - simple health probe
- `POST /admin/clear-prep-cache`
  - clears in-memory cache and persistent prep
  - protected by `X-Admin-Token` only if `ADMIN_TOKEN` is configured
- `POST /resolve-person`
  - resolves a single person from `displayName` and `email`
- `POST /manual-prep`
  - generate or reuse meeting prep
- `GET /get-prep/:eventId`
  - load persisted prep for a user/event
- `GET /prep/:eventId/combined`
  - load only merged sections + metadata
- `PUT /prep/:eventId/edits`
  - persist user edits
- `PUT /prep/:eventId/participant-fix`
  - persist a manual participant identity fix and regenerate prep

## Caching

The server keeps a small in-memory LRU cache, mainly for person resolution artifacts. This cache is:

- fast
- process-local
- non-durable

It is an optimization only. Persistent prep always comes from the configured persistence adapter.

## Edge Cases And Failure Modes

- Missing bearer token: request fails with `401`.
- Invalid/expired Google token: request fails with `401`.
- Empty title and empty participant list: prep generation fails with `400`.
- Unsaved meeting: generation succeeds but is not durably persisted.
- Search API not configured: participant resolution uses placeholder search context.
- OpenAI key missing: mock participant summaries and mock prep are returned.
- Search failure for one participant: the participant is returned as unresolved/low-confidence rather than aborting the entire meeting.
- Existing prep with same title and same sorted emails: prep is reused.
- Existing prep with changed title or attendee emails: prep is regenerated.
- Participant fix for someone not in the stored event: request fails with `400`.
- Persistence adapter failure: routes return `500`.
- Admin clear route without matching token when configured: returns `403`.

## Local Development

Install dependencies and start the server:

```bash
npm install
npm run dev
```

Production-style start:

```bash
npm start
```

Default local URL:

```text
http://127.0.0.1:3847
```

## Local File Persistence

With the default `file` mode, data is stored in `data/preps.json`.

Key properties of this mode:

- simple and easy to inspect
- durable across server restarts
- not appropriate for concurrent multi-instance deployment
- useful for local development and debugging

## DynamoDB Persistence

When `PERSISTENCE=dynamo`, the server expects a table where records are keyed by:

```text
pk = "<google_sub>#<encoded_event_id>"
```

This keeps records tenant-scoped and event-scoped in one key.

## Logging

The server emits structured JSON logs with fields such as:

- route
- request path
- status
- latency
- hashed user ID
- event ID when relevant

User identity is intentionally hashed in logs rather than printed directly.

## Operational Notes

- CORS is permissive for localhost and chrome-extension origins in development, and explicit in production via `CORS_ALLOWED_ORIGINS`.
- Request bodies are capped at `2mb`.
- The auth dependency on Google `userinfo` means server auth depends on Google availability.
- There are currently no automated tests in this directory, so validation is manual/runtime-based.
