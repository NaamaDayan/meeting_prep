# Meeting Prep Extension

This directory contains a Chrome extension (Manifest V3) that augments Google Calendar and Gmail with meeting-preparation workflows. Its main job is to scrape meeting context from the page, inject a `Prep meeting` button, and render a side panel for viewing and editing generated prep. It does **not** talk directly to OpenAI or the persistence layer; those responsibilities are delegated to the local server through the background service worker.

## What The Extension Does

- Injects a `Prep meeting` button into Google Calendar event UIs.
- Scrapes event details from the DOM:
  - title
  - attendee emails
  - attendee display names when possible
  - approximate meeting start time
  - candidate event IDs from URL/DOM/base64 `eid` values
- Uses the background service worker to:
  - fetch Google OAuth tokens
  - call Google Calendar APIs
  - call the backend server
  - cache prep results locally
- Renders a right-side prep panel with editable sections (agenda, participants, meeting briefing):
  - Participants info
  - Meeting agenda
  - Meeting briefing
- Lets the user save section edits back to the server.
- Lets the user open a **briefing preview** tab and send the **Meeting briefing** section via Gmail API, with Gmail compose as a fallback.
- Periodically auto-checks whether an opened event already has prep and, if so, auto-opens the panel.

## Directory Overview

- `manifest.json`: MV3 manifest, permissions, OAuth config, content scripts, service worker.
- `background.js`: service worker; owns auth, Calendar API lookups, backend communication, local cache, and message routing.
- `content.js`: DOM scraper and UI layer injected into Calendar/Gmail pages.
- `options.html` / `options.js`: options page for backend base URL, Gmail OAuth client, and diagnostics.
- `calendarIds.js`: helper utilities for deriving canonical event identifiers from multiple Calendar surfaces.
- `emailTemplates.js`: email subject/body generation for the “Send briefing” flow.
- `briefing-preview.html` / `briefing-preview.css` / `briefing-preview.js`: full-page interactive meeting briefing preview (opened from the sidebar).

## Working Assumptions

- The extension is expected to run mainly against `calendar.google.com`, but the manifest also injects into `mail.google.com`.
- The extension stores separate development and production backend URLs and selects one active mode in the options page.
- Google Calendar’s DOM is unstable and can change often, so the content script uses several fallback selectors instead of relying on one fixed structure.
- The user is signed into Chrome with a Google account and can authorize the extension for Calendar access.
- A meeting can exist in multiple Calendar views and may expose different event identifiers depending on the surface, so the extension maintains alias mappings.
- The server is the source of truth for durable meeting prep. Local storage is only a performance optimization.
- Gmail sending uses a **separate** OAuth flow from Calendar reading. The options page assumes you configured a Google OAuth **Web application** client ID with the exact redirect URI shown there.

## Core Logic

## 1. Button Injection

`content.js` watches the page with a `MutationObserver`, URL listeners, and a periodic timer. On each pass it:

- determines whether a Calendar event editor is open
- finds the visible Save button or toolbar
- injects a single `Prep meeting` button next to it
- resizes the injected button to match the surrounding Calendar UI

If Google’s normal Save button cannot be found, the extension falls back to attaching a styled button into a toolbar-like container.

## 2. Event Scraping

When the user clicks `Prep meeting`, the content script builds a snapshot from the current page:

- `title`
- `attendees[]` as `{ email, displayName }`
- `startIso`
- `calendarEventId`
- identifier hints derived from URL, DOM attributes, and decoded `eid` values

Attendee extraction is intentionally redundant:

- `mailto:` links
- `data-hovercard-id`
- `aria-label` / `title` patterns like `Name <email>`
- full-text email extraction from the page as a fallback

If only an email is available, the local-part is used temporarily as the display name.

## 3. Background Resolution

The content script never calls the server directly. It sends messages to `background.js`, which:

- gets an OAuth token via `chrome.identity`
- optionally resolves the event through Google Calendar API
- merges DOM attendees with API attendees
- removes the organizer from the participant list
- calls the server to generate or fetch prep

The attendee merge prefers UI-derived display names when the Calendar API only provides low-quality names such as an email local-part.

## 4. Prep Panel

On success, the content script opens a side panel and renders:

- editable textareas for the four prep sections
- a `Save edits` action
- `Preview` opens an interactive meeting briefing preview tab; `Send briefing` emails participants from the **Meeting briefing** section

The panel auto-refreshes if the local prep cache changes while it is open.

## 5. Auto-Sync

When a Calendar event opens, the extension tries to auto-load existing prep:

- first from local cache
- then from the backend via the service worker

If prep is found, it auto-opens the panel. If the user dismisses the panel, the extension suppresses reopening for that event until the user navigates away and back.

## Local Cache Behavior

The service worker stores prep in `chrome.storage.local` under `mp_prep_cache_v1`.

Cache behavior:

- up to 200 events are retained
- alias event IDs are mapped to a canonical event ID
- successful prep fetches are cached
- negative results for API-looking event IDs are cached for 2 minutes
- a proactive sync runs on install, startup, and every 30 minutes to prefetch prep for upcoming events within 48 hours

This cache improves perceived speed but is not authoritative.

## Gmail Sending Flow

The `Send briefing` action:

- extracts bullet-like lines from the **Meeting briefing** textarea
- opens a lightweight popover
- lets the user choose recipients
- excludes the current user by default when identity is available
- attempts to send via Gmail API (no compose tab on success)

Requirements:

- a separate Google OAuth **Web application** client ID must be set in options
- the redirect URI must exactly match `chrome.identity.getRedirectURL()`
- the auth flow requests `gmail.send` and `userinfo.email`; the Gmail profile endpoint is not used because `gmail.send` alone does not authorize it (returns 403)

## Edge Cases And Failure Modes

- Unsaved meetings: prep can still be generated, but there is no durable server event ID, so persistence is limited.
- Missing meeting data: if both title and participants are empty, generation is blocked with a `needs_input` error.
- Missing or unstable event IDs: the extension attempts to decode multiple candidate IDs and can fall back to event matching by title, attendees, and time window.
- Calendar DOM changes: multiple selectors and fallback placement logic reduce breakage, but future UI changes may still require scraper updates.
- Duplicate attendees: normalized by lowercase email.
- Organizer in attendee list: filtered out before sending participants for research.
- Dismissed panel: stays dismissed only for the current browser tab/session for that event.
- Backend unavailable: the options page includes a health ping to help diagnose connectivity issues.
- OAuth token expiry: backend calls retry once after clearing the cached token if a `401` is returned.
- Gmail API failure: user sees an alert with setup guidance (compose fallback was removed).
- Slow generation: content waits up to 120 seconds before treating prep generation as timed out.
- Existing user edits plus changed meeting metadata: the server may mark the prep as stale, and the panel displays a warning.

## Permissions Used

- `identity`, `identity.email`: Google sign-in and token acquisition.
- `storage`: extension settings and local prep cache.
- `alarms`: proactive cache refresh.
- host permissions for:
  - Google Calendar
  - Gmail
  - Google APIs
  - local backend URLs

## Configuration

Use the extension options page to configure:

- `Active mode` (`Development` or `Production`)
- `Development backend URL`
- `Production backend URL`
- `Web application client ID` for Gmail sending
- `Ping server health` diagnostics

Default development backend:

```text
http://127.0.0.1:3847
```

## Development Notes

- Load the extension as an unpacked Chrome extension from this `extension` directory.
- Start the local server from `server/` before testing prep generation.
- The extension assumes the backend accepts Google Bearer tokens and exposes the routes implemented in `server/server.js`.
- No automated tests are included in this directory; validation is currently runtime/manual.
