<div align="center">

<img src="web/public/og.jpg" alt="Splitup — split expenses with friends" width="760" />

<br/><br/>

[![React](https://img.shields.io/badge/React_19-20232a?style=for-the-badge&logo=react&logoColor=61dafb)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-646cff?style=for-the-badge&logo=vite&logoColor=white)](https://vite.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_v4-06b6d4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Hono](https://img.shields.io/badge/Hono-e36002?style=for-the-badge&logo=hono&logoColor=white)](https://hono.dev)
[![SQLite](https://img.shields.io/badge/SQLite-003b57?style=for-the-badge&logo=sqlite&logoColor=white)](https://sqlite.org)
[![PWA](https://img.shields.io/badge/PWA-5a0fc8?style=for-the-badge&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![License: MIT](https://img.shields.io/badge/MIT-green?style=for-the-badge&label=license)](LICENSE)

A self-hosted Splitwise alternative — an installable, offline-capable PWA<br/>for
splitting expenses with friends, built to be safe, precise, and pleasant to use.

**[splitup.sunnydx.dev](https://splitup.sunnydx.dev)**

[Features](#features) · [Architecture](#architecture) · [Getting started](#getting-started) · [Deployment](#deployment) · [Security](#security)

</div>

---

## Features

- **Groups and friends** — multi-user groups with shareable invite links, plus direct friend-to-friend expenses outside any group.
- **Four split modes** — equal, unequal, percent, or shares, with largest-remainder rounding so the cents always add up to the total.
- **Simplified debts** — balances are netted per group and settle-up suggests the minimum set of transfers, so settling through one person never creates phantom debts.
- **Multi-currency** — each group locks its currency; totals are reported per currency, never converted behind your back.
- **Offline-ready** — data is readable offline, installed or in the browser; edits require a connection by design, so there are no stale writes and no conflict surprises.
- **Themes** — light, dark, and AMOLED, system-following, with a view-transition theme toggle.
- **Everyday utilities** — activity feed, CSV export, and payment reminders.
- **Receipt scanning** (optional) — snap a bill and get a prefilled draft expense; you still check the numbers, pick the split, and save.
- **Privacy-first authentication** — Google sign-in via [shoo.dev](https://shoo.dev); no passwords stored, no tracking.

## Architecture

A single read endpoint drives the application: `GET /api/sync` returns the caller's
entire visible dataset as one snapshot. Every balance, ledger, and activity view is
derived client-side by pure functions over that snapshot. Money is handled as integer
minor units end to end, so the arithmetic is exact and works offline.

```mermaid
flowchart LR
    subgraph client [React 19 PWA]
        UI[Screens] --> Q[TanStack Query]
        Q --> M["balances.ts / money.ts<br/>pure integer-cent math"]
        Q <--> IDB[("IndexedDB<br/>offline cache")]
    end
    subgraph server [Hono, port 8790]
        API["/api/sync and mutations"] --> DB[("SQLite<br/>WAL mode")]
    end
    Q -- "sync snapshot / optimistic mutations" --> API
    SHOO["shoo.dev<br/>Google sign-in"] -. "id_token verified once (JWKS, ES256),<br/>then a first-party session cookie" .-> API
```

| Package | Stack |
|---------|-------|
| `web/` | React 19, Vite, TypeScript, Tailwind CSS v4, shadcn (base-nova on [Base UI](https://base-ui.com)), TanStack Query, `vite-plugin-pwa` |
| `server/` | [Hono](https://hono.dev), better-sqlite3, `jose`, Zod, executed with `tsx` |

The shoo id_token is verified server-side once (issuer and audience pinned) and
immediately discarded; the application then runs on its own random httpOnly session
cookie, SHA-256 hashed at rest with a 30-day sliding expiry. shoo's `client_id` is
derived from the application origin, so no dashboard or registration is required.

## Getting started

Requires Node.js 20 or later.

```bash
npm install --prefix web
npm install --prefix server
npm install                # root (concurrently)

npm run dev                # API on :8790, web on :5173 (proxies /api to :8790)
```

Open http://localhost:5173. Sign-in is Google-only through shoo.dev; in development
the origin is `http://localhost:5173`.

## Deployment

**Single origin** — the server serves the built web application and the API together:

```bash
npm run build              # builds web/dist
APP_ORIGIN=https://your.domain npm start   # serves web/dist and /api on :8790
```

**Docker** — the included multi-stage `Dockerfile` builds the web bundle and runs the
server on port 8790:

```bash
docker build -t splitup .
docker run -d -p 8790:8790 \
  -e APP_ORIGIN=https://your.domain \
  -e DB_PATH=/data/splitup.db \
  -v splitup_data:/data \
  splitup
```

> [!IMPORTANT]
> Mount a volume for the database. The server checkpoints the WAL hourly and on
> shutdown, and writes a consistent daily snapshot to `backups/` next to the database
> (newest 7 kept). Copy those snapshots off the host for real backups.

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `APP_ORIGIN` | `http://localhost:5173` | shoo JWT audience (`origin:<APP_ORIGIN>`), CSRF origin check, invite-link base |
| `DB_PATH` | `server/data/splitup.db` | SQLite file, created on first run |
| `PORT` | `8790` | API/server port |
| `NODE_ENV` | – | `production` enables Secure cookies, CSP, and static serving of `web/dist` |
| `TRUST_PROXY` | – | `1`/`true` when behind a reverse proxy: rate limits key on the rightmost `X-Forwarded-For` entry (then `X-Real-IP`) instead of the proxy's socket address. Leave unset when directly exposed, or clients can spoof their IP |
| `RECEIPT_SCAN` | auto | `0` disables receipt scanning, `1` forces it on. Auto = on when the `codex` binary resolves **and** `$CODEX_HOME/auth.json` exists (checked per request, so a fresh login takes effect without a restart) |
| `CODEX_HOME` | `/codex` in Docker, else `~/.codex` | Codex CLI state dir holding `auth.json`. Mount a volume here |
| `CODEX_BIN` | `codex` | Codex CLI executable (name on `PATH` or absolute path) |
| `RECEIPT_MODEL` | `gpt-5.6-luna` | Model passed to `codex exec -m` |
| `RECEIPT_EFFORT` | `low` | `model_reasoning_effort` for the scan |

### Receipt scanning

The "Scan receipt" button in **Add expense** sends a downscaled photo (≤1600 px JPEG)
to `POST /api/receipts/scan`. The server runs the official
[Codex CLI](https://github.com/openai/codex) (`codex exec`, read-only sandbox, strict
JSON output schema, 90 s timeout, no shell) signed in with the **owner's ChatGPT
plan**, then validates the result and returns a draft: merchant, date, currency,
total, tax/tip/discount, line items, category, and warnings when the numbers don't
add up. Nothing is saved until the user reviews the form and presses Save. A receipt
in a different currency than the group is never converted — only the description and
date are prefilled.

The Docker image ships the Codex CLI (pinned, linux binary only, ~280 MB). Sign it in
once — the login is stored in `$CODEX_HOME` (`/codex`), so mount a volume there:

```bash
docker exec -it splitup codex login --device-auth   # follow the device-code prompt
# …or copy an existing auth.json from a machine where you ran `codex login`:
docker cp ~/.codex/auth.json splitup:/codex/auth.json
```

Prefer the device login: a copied `auth.json` shares one refresh token between two
machines, and when one side refreshes it the other may be signed out.

Each scan uses the owner's ChatGPT plan quota (roughly 0.1 credit per scan with
Luna; about 10–15 s each). Limits: 2 concurrent scans server-wide, 20 per user per hour and 60 per
day; images up to 3 MB (JPEG, PNG, or WebP). Images are written to a private temp dir
for the duration of the scan, deleted afterwards, never logged, and the Codex session
is ephemeral. With no `auth.json`, the feature is simply hidden.

## Security

- The shoo id_token is verified server-side against shoo's JWKS (ES256, issuer and audience pinned); the JWT is never stored and never reused.
- Sessions are random 32-byte httpOnly cookies, SHA-256 hashed at rest, with a 30-day sliding expiry.
- CSRF protection requires a custom `X-CSRF` header on every mutation, plus an `Origin` allowlist check.
- Per-session rate limiting (300/min general, 20/min on auth), a 64 KB body cap (4 MB on the receipt-scan route only), and strict CSP and security headers on HTML.
- Every input is Zod-validated, all SQL uses prepared statements, and money is integer minor units end to end.
- Non-members receive `404` (never `403`), so resource existence never leaks.

## Testing

```bash
npm run typecheck          # web and server
npm test                   # server (node:test) and web (Vitest) unit tests
```

## Design

The visual system — a warm cream canvas, ink pills, and a single signal orange that is
never a call-to-action color — is documented in [DESIGN.md](DESIGN.md).

## License

Released under the [MIT License](LICENSE).
