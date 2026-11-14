# Mytinerary

An end-to-end trip planner: get inspired, plan around a few anchor activities per day, follow the plan on the trip, and look back afterward.

The app is one file, `mytinerary/index.html`. It runs three ways:

- **Hosted (Railway):** `server/main.ts` serves the app and handles Claude, Google Places and sign-in by emailed link (Resend). Only addresses in `ALLOWED_EMAILS` can sign in.
- **claude.ai artifact:** paste the file into claude.ai. It uses Claude through the artifact runtime and can read Gmail and Calendar through your connectors.
- **Demo (GitHub Pages):** always uses sample data.

## Server environment

| Variable | What it's for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API |
| `GOOGLE_MAPS_API_KEY` | Google Places API (New): real hours, ratings, photos and locations |
| `RESEND_API_KEY` | Sends the sign-in emails (`RESEND_FROM` overrides the sender) |
| `ALLOWED_EMAILS` | Comma-separated list of who can sign in |
| `SESSION_SECRET` | Signs sign-in links and session cookies. Keep it stable. |
| `CLAUDE_MODEL` | Optional, defaults to `claude-opus-5-5` |
| `DAILY_CLAUDE_CALLS`, `DAILY_PLACES_CALLS`, `DAILY_PHOTO_CALLS` | Optional per-person daily limits (80 / 400 / 400) |

## Run locally

```
npm install
cp .env.example .env   # fill in the keys
npm run dev            # http://localhost:4321
```

Without `RESEND_API_KEY`, sign-in links are printed in the server log. For the UI on sample data, run `python3 -m http.server 8765 -d mytinerary` and open http://localhost:8765/?mock
