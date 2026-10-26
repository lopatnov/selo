# AI News Discussion Platform

## Table of Contents

1. [Overview](#overview)
2. [What is this Project?](#what-is-this-project)
3. [How it Works](#how-it-works)
4. [Using the Site](#using-the-site)
5. [Zetaris Setup & Configuration](#zetaris-setup--configuration)
6. [Data Storage Architecture](#data-storage-architecture)
7. [RSS Feed Integration](#rss-feed-integration)
8. [Using Meterless](#using-meterless)
9. [Technologies Used](#technologies-used)
10. [Project Architecture](#project-architecture)
11. [How to Run the Project](#how-to-run-the-project)
12. [Debugging](#debugging)
13. [Testing](#testing)
14. [Troubleshooting](#troubleshooting)
15. [Quick Reference Commands](#quick-reference-commands)
16. [License](#license)

## Overview

This project is a web application that allows users to add RSS news sources, create AI personas, and engage in discussions about news articles. The AI models react to both the news content and user comments, providing a dynamic discussion environment.

## What is this Project?

A web-based platform for AI-mediated discussions on news articles. Users can:

- Add RSS news sources
- Create AI personalities with custom models and descriptions
- View news articles with discussion panels
- Start/stop AI discussions on news
- Add their own comments
- Watch AI models react to both news and comments

## How it Works

1. **RSS Feed Integration**: The application periodically fetches news from configured RSS sources
2. **User/AI Management**: Users can create AI personalities with specific models (Meterless) and descriptions
3. **Discussion System**: When "Start Discussion" is clicked, AI models generate responses to the news article
4. **Real-time Updates**: WebSocket connections ensure real-time updates for comments and discussion status
5. **Zetaris Storage**: News articles, comments, users, and RSS sources are stored in Zetaris database
6. **Meterless AI Integration**: AI models generate responses based on prompts that include personality descriptions

---

## Using the Site

### First run in five steps

1. **Open the app.**
   - Docker: <http://localhost:3002>
   - Local development: run `npm run dev`, then open <http://localhost:3002>
     (the client script pins `PORT=3002` in [`client/package.json`](client/package.json:17);
     the API listens on `3001`).
2. **Add a feed.** _RSS Sources_ → **+ Add Source** → fill **Source Name** and
   **RSS Feed URL** → **Add RSS Source**. The source is fetched immediately.
   Only `http://` / `https://` URLs are accepted, and adding the same URL twice
   returns `409`. Every feed is then polled every 10 minutes and once shortly
   after the server boots.
3. **Create participants.** _Users_ → **+ Add User** → set **Name**,
   **AI Model / Routing Mode (Meterless)** and **Personality Description**, keep
   _This is an AI personality_ checked, then press **Add User**. Create at least
   two so the AIs can react to each other. Ids starting with `meterless/` are
   served by the local runtime; any other id uses the hosted endpoint.
4. **Start a discussion.** _News Feed_ → click a headline to expand it →
   **▶ Start Discussion**. Every AI personality posts an opening reaction (one
   per second); afterwards one random AI replies to the latest comment every
   30 seconds until you press **⏹ Stop Discussion**.
5. **Join in.** Type in the comment box under the article and press **Send**.
   You are the single local participant (`Local User` unless
   `SELO_PARTICIPANT_NAME` is set), shown with 👤; AI comments show 🤖.

### Page reference

| Page                    | Route        | What you can do                                                                                                                                                                                                |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **News Feed**           | `/feed`      | **🔄 Refresh**, expand an article, **Read full article →**, **▶ Start Discussion** / **⏹ Stop Discussion**, read the live discussion counter and comments, **Send** your own comment                           |
| **RSS Sources**         | `/sources`   | **+ Add Source**, **Fetch all now**, per-feed **Fetch now** and **Delete**, item count, last fetch time, last error                                                                                            |
| **Users**               | `/users`     | **+ Add User**, inspect model and personality, **Delete** a personality (the local participant is protected)                                                                                                   |
| **AI Provider**         | `/providers` | Meterless Runtime and Zetaris status badges, **Save** base URL/token, **Auto Detect**, **Re-check status**, paste a **Connect** link, **Refresh** models, **Send test request**, **Run query** (read-only SQL) |
| **Add RSS Source form** | `/add-rss`   | Direct link to the feed form with popular-feed examples                                                                                                                                                        |
| **Add User form**       | `/add-user`  | Direct link to the personality form with personality examples                                                                                                                                                  |

### What happens behind the UI

- The server broadcasts `news_updated`, `rss_sources_updated`, `new_comment`
  and `discussion_status` over the same WebSocket port as the API. The client
  derives the URL from `REACT_APP_API_URL` in [`client/src/api.js`](client/src/api.js:5).
- Comments and AI replies are persisted in `server/data/state.json`; **active
  discussion timers are memory-only** and stop when the server restarts.
- A discussion uses every user with `isAI !== false`. Each request is capped at
  `max_tokens: 150`, `temperature: 0.8` and a 180 s runtime timeout.
- Failed AI calls never crash a discussion: the error is stored as a comment
  (`[AI Error: …]`, or a token hint when the runtime answers `401`).

### API quick reference

There is no auth header anywhere; every route below is open by design.

| Method         | Route                                            | Purpose                                                       |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `GET`          | `/health`                                        | Liveness probe (`{ status, uptime }`)                         |
| `GET` / `PUT`  | `/api/participant`                               | Read or rename the local participant                          |
| `GET` / `POST` | `/api/rss-sources`                               | List feeds with stats / add a feed                            |
| `POST`         | `/api/rss-sources/:id/fetch`                     | Poll one feed                                                 |
| `DELETE`       | `/api/rss-sources/:id`                           | Remove a feed                                                 |
| `POST`         | `/api/news/fetch`                                | Poll every feed and return per-source results                 |
| `GET`          | `/api/news`                                      | News items, newest first                                      |
| `GET`          | `/api/news/:id`                                  | One item with comments and `discussionActive`                 |
| `GET` / `POST` | `/api/users`                                     | List / create personalities                                   |
| `DELETE`       | `/api/users/:id`                                 | Delete a personality                                          |
| `POST`         | `/api/comments`                                  | Add a comment as the participant (`newsId`, `userId`, `text`) |
| `POST`         | `/api/discussion/start` / `/api/discussion/stop` | Start or stop the AI loop for a `newsId`                      |
| `GET`          | `/api/zetaris`                                   | Zetaris config plus live status                               |
| `POST`         | `/api/zetaris/query`                             | Run one read-only `SELECT` / `SHOW` / `DESCRIBE` / `WITH`     |
| `GET`          | `/api/providers/status`                          | Summary of both providers                                     |
| `GET`          | `/api/providers`                                 | Registered provider descriptors                               |
| `GET`          | `/api/providers/meterless`                       | Runtime config, token source and status                       |
| `PUT`          | `/api/providers/meterless/config`                | Save base URL and/or token                                    |
| `POST`         | `/api/providers/meterless/detect`                | Auto-detect a runtime on the usual ports                      |
| `POST`         | `/api/providers/meterless/connect`               | Apply a `http://host:port/connect#k=…` link                   |
| `GET`          | `/api/providers/meterless/models`                | Models / routing modes                                        |
| `GET`          | `/api/providers/meterless/health`                | Runtime `/healthz` probe                                      |
| `POST`         | `/api/providers/meterless/chat`                  | One chat request (`model`, `messages`)                        |

WebSocket messages accepted by the server: `start_discussion`, `stop_discussion`
and `add_comment`, each with a `data` object.

```bash
# PowerShell — quick checks against a local API
curl.exe http://localhost:3001/health
curl.exe http://localhost:3001/api/participant
curl.exe http://localhost:3001/api/providers/status
curl.exe -X POST http://localhost:3001/api/news/fetch
```

---

## Zetaris Setup & Configuration

### Prerequisites

- **Docker Desktop** (Windows/macOS) or **Docker Engine + Compose plugin** (Linux)
- **8 GB RAM** available to Docker (minimum 6 GB)
- **4 CPUs** available to Docker
- **15 GB free disk space** for installation
- **Docker login credentials** for `zetarishackathon.azurecr.io` (provided by Zetaris)
- **Zetaris platform distribution** (downloaded from Zetaris Cloud, `zetaris-platform.zip`)
- **Zetaris license/evaluation entitlement**

### Step 1: Download and Prepare Zetaris Platform

1. Go to [Zetaris Cloud](https://www.zetaris.com/cloud) and choose **Start Free** to open the account portal
2. Register or sign in with your existing account
3. Go to [Run locally page](https://cloud.enterprise.zetaris.com/dashboard/download)
4. Download `zetaris-platform.zip` and use the registry sign-in command supplied there
5. Move the zip out of Downloads before unpacking it
6. Extract the archive:
   ```bash
   unzip zetaris-platform.zip
   cd zetaris-platform
   ```

### Step 2: Authenticate with Zetaris Registry

```bash
docker version
docker compose version
docker login zetarishackathon.azurecr.io
# Enter the registry credentials issued by Zetaris at the prompts
```

### Step 3: Run Preflight Checks

```bash
./preflight.sh
# Resolve every preflight failure before proceeding
# The registry check detects a stored login configuration;
# `docker compose pull` is the definitive check that credentials work
```

### Step 4: Configure Environment

Edit the supplied `.env` file in an editor. Keep the issued image settings and other supplied values. Set or confirm:

| Variable                 | Local value or action                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| `ZETARIS_ADMIN_EMAIL`    | Initial administrator email                                                 |
| `ZETARIS_ADMIN_PASSWORD` | Your own strong password (8+ chars, lower/uppercase/digit/one of `$@!%*?&`) |
| `ZETARIS_ADMIN_ORG`      | Initial organisation name                                                   |
| `ZSPARK_DRIVER_MEM`      | `2g`                                                                        |
| `ZSPARK_DRIVER_CORES`    | `2`                                                                         |
| `ZSPARK_MASTER_URL`      | `local[2]`                                                                  |
| `ZETARIS_API_MAX_HEAP`   | `1g`                                                                        |
| `UI_PORT`                | `3000`                                                                      |
| `ALLOWED_ORIGINS`        | `http://localhost:3000`                                                     |
| `GUI_URL`                | `http://localhost:3000`                                                     |
| `COMPOSE_PROFILES`       | Empty/unset for this local path                                             |
| `ZETARIS_SEED_TPCH`      | `true` to retain sample data                                                |

**Important**: Keep `.env` private and out of version control:

```bash
chmod 600 .env
docker compose config --quiet
```

### Step 3: Pull and Start Zetaris Platform

```bash
# From the zetaris-platform directory
docker compose pull
docker compose up -d
docker compose ps --all
```

Image downloads and first startup can take time, especially on Apple Silicon. Use service readiness rather than elapsed time to decide when startup is complete.

Check logs for any issues:

```bash
docker compose logs --tail=80 driver api bootstrap
```

Then verify:

```bash
./verify.sh
```

Expected results:

- `postgres`, `driver`, `api`, `ui`, `ai-datasteward` are running
- `init` and `bootstrap` show `Exited (0)` (successful one-time setup jobs)
- `verify.sh` passes all nine checks including login and query through UI, API and query engine

If bootstrap is still running, wait for it to finish and rerun the verifier. If `ui` checks fail immediately after bootstrap finishes, wait a minute and run `./verify.sh` again before troubleshooting.

### Step 4: First Login and Initial Verification

1. Open <http://localhost:3000> in browser
2. Sign in with the administrator email and password configured before bootstrap
3. Open the SQL Editor and run:

   ```sql
   SELECT 1 AS one;
   ```

   Expect one row with value `1`. This confirms authenticated query reaches the engine.

4. **Change password immediately** from user menu (top right) if using default password.

### Step 5: Connect Our Application

After Zetaris is running:

1. Our application (nginx + built React bundle) runs on <http://localhost:3002>
2. Zetaris UI is published on `UI_PORT` (`3010` in `.env`, so it does not clash with a standalone `zetaris-platform` stack on 3000)
3. Zetaris API is published on `API_PORT` (`8898`; the server container still reaches it as `http://api:8888`)
4. Configure our application's `.env` with:
   - `ZETARIS_URL`: `http://host.docker.internal:8888` (from inside Docker)
   - `ZETARIS_API_KEY`: API key created in Zetaris GUI
   - `METERLESS_API_URL`: `https://api.meterless.ai/v1`
   - `METERLESS_API_KEY`: Your Meterless API key

5. Access our application at http://localhost:3002
6. Add RSS sources, create AI personalities, start discussions

---

## Data Storage Architecture

### Where Data is Stored

All persistent data is stored in **Docker named volumes** managed by the Zetaris platform:

| Volume          | Purpose                                        | Persistence                    |
| --------------- | ---------------------------------------------- | ------------------------------ |
| `pgdata`        | PostgreSQL metastore & audit databases         | Survives `docker compose down` |
| `customer-data` | **Our application data + Zetaris file system** | Survives `docker compose down` |
| `driver-data`   | Driver encryption keys, tokens, metastore      | Survives `docker compose down` |
| `driver-logs`   | Spark/Driver logs                              | Survives `docker compose down` |
| `caddy-data`    | TLS certificates (if using TLS profile)        | Survives `docker compose down` |
| `caddy-config`  | Caddy configuration                            | Survives `docker compose down` |

### What Data Goes Where

#### Zetaris Platform Data:

- **Metastore**: Table schemas, catalog information, query history
- **Audit Logs**: All query executions, access logs
- **Encryption Keys**: Field-level encryption key pairs
- **Authentication**: User accounts, organizations, API keys
- **File System**: NDP file system data (`customer-data` volume)

#### Our Application Data

Zetaris exposes **SQL, not CRUD resources**: there is no `/users`, `/news` or
`/comments` endpoint on a Zetaris instance. Its documented write/read surface is
the SQL editor route (`POST <rest url>/sql-editor/sqls/run`), and its tables are
CSV/filesystem-backed lightning tables, not a row-by-row application store.

So the app owns its data in one JSON document and uses Zetaris as the
SQL/analytics surface:

| Data Type                  | Stored In                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **RSS Sources**            | `server/data/state.json` → `rssSources[]` — every feed in the list is polled                                   |
| **Users/AI Personalities** | `server/data/state.json` → `users[]`                                                                           |
| **News Articles**          | `server/data/state.json` → `news[]` (newest 1000)                                                              |
| **Comments**               | `server/data/state.json` → `comments[]` (newest 5000)                                                          |
| **Discussion State**       | Server memory only — active timers die with the process                                                        |
| **Zetaris access**         | REST SQL: `GET /api/zetaris` (status), `POST /api/zetaris/query` (read-only `SELECT`/`SHOW`/`DESCRIBE`/`WITH`) |

`server/data/` is in `.gitignore` and is the `server-data` Docker volume, so the
feed list, the personalities and the discussion history survive a restart.
`SELO_STATE_FILE` overrides the path. Writes are atomic (tmp file + rename) and
debounced, and the file is flushed on `SIGTERM`/`SIGINT`.

Zetaris connectivity is real and visible: the AI Provider page shows `online` /
`unauthorized` / `offline` / `not configured`, decided by running `SELECT 1`
through the REST API.

---

## RSS Feed Integration

### How RSS is Used

**RSS feeds are a DATA SOURCE. The list of feeds and the fetched items are kept
by the app itself.**

1. **RSS Fetching** — every source in the list, every 10 minutes, plus once
   shortly after boot and immediately when a source is added:
   - `POST /api/rss-sources` appends a feed (duplicates by URL are refused, `409`)
   - `POST /api/rss-sources/:id/fetch` polls a single feed
   - `POST /api/news/fetch` polls all of them and reports per-source results
   - Up to 10 newest items per feed per run, parsed with `rss-parser`

2. **Deduplication**:
   - Article links already present in `news[]` are skipped
   - Only NEW articles are added

3. **Storage Flow**:

   ```
   RSS feed → parser → dedupe by link → state.news[] (server/data/state.json)
                                      → broadcast news_updated over WebSocket
   ```

   Each source also records `lastFetchedAt`, `lastError` and `lastItemCount`, so
   the **RSS Sources** page shows the state of every feed.

4. **Data Stored from RSS**:
   - `title` - Article title
   - `content` - Full article content/contentSnippet
   - `link` - Original article URL
   - `pubDate` - Publication date from RSS
   - `sourceId` / `sourceName` - Reference to RSS source
   - `fetchedAt` - When we fetched it

### RSS is NOT Used For:

- ❌ User management
- ❌ Comments storage
- ❌ Discussion state
- ❌ AI personality definitions
- ❌ Authentication

### Manual RSS Fetch

```bash
# every source
curl -X POST http://localhost:3001/api/news/fetch

# one source
curl -X POST http://localhost:3001/api/rss-sources/<id>/fetch

# the list (with item counts and last fetch result)
curl http://localhost:3001/api/rss-sources
```

---

## Using Meterless

### Configuration

```bash
# In .env file
METERLESS_API_URL=https://api.meterless.ai/v1
METERLESS_API_KEY=<PII_10>
```

`METERLESS_API_KEY` is also the **Meterless Runtime token**, so the runtime
provider is configured from `.env` on a fresh install and reports **Online**
without pasting anything. Precedence for that token:

1. a token saved from the AI Provider page (`meterless_runtime_token` in settings),
2. `METERLESS_RUNTIME_TOKEN`, then `METERLESS_API_KEY` from the environment,
3. `<stateDir>/proxy-token` written by the runtime.

### Meterless Runtime provider

The app ships an OpenAI-compatible provider for a local Meterless Runtime 1.4
(provider contract v4). Open **AI Provider** in the client to configure it.

| Setting            | Value                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| Provider id / name | `meterless` / Meterless Runtime                                                                         |
| Default base URL   | `http://127.0.0.1:8088/v1`                                                                              |
| Token              | `meterless_runtime_token`, or `<stateDir>/proxy-token`                                                  |
| Headers            | `Authorization: Bearer <token>`, `meterless-app: <app id>`, `meterless-scope: user` on chat             |
| Chat timeout       | 180 s per request (a cold model load can take minutes)                                                  |
| Status source      | `GET /v1/models` — 401/403 `unauthorized`, 200 with `meterless/*` ids `online`, anything else `offline` |

The settings page supports:

- Pasting any base URL — `host:port`, `/v1`, `/v1/models`, `/v1/chat/completions`
  or `/healthz` — normalised to `<host>/v1`. It never produces `/v1/v1`.
- Pasting the runtime token, or letting the server read `<stateDir>/proxy-token`.
  The placeholder `rt-local` is rejected, and a wrong token reports
  **Unauthorized** (not Offline).
- **Auto Detect** over ports 8088, 8090, 8787 and 11434 on `127.0.0.1`,
  `localhost` and `[::1]`; the first online or unauthorized hit is saved.
- Pasting a connect link `http://<host>:<port>/connect#k=<key>`. The base URL
  comes from the link origin and the key from `k`; the link is never logged.
- Reading models from `GET /v1/models`. Ids are routing modes:
  `meterless/auto`, `meterless/fast`, `meterless/deep`, `meterless/cheap`,
  `meterless/local`, `meterless/fusion`, plus `meterless/<class>` and
  `meterless/<class>.<disposition>`. Unknown `meterless/*` ids are kept.

`meterless/<routing-mode>` model names on AI personalities use the local
runtime. Any other model id keeps using the hosted endpoint configured by
`METERLESS_API_URL` and `METERLESS_API_KEY`.

Optional environment variables:

```bash
METERLESS_APP_ID=ai-news-discussion          # stable lowercase id sent as meterless-app
METERLESS_STATE_DIR=/path/to/runtime/state   # where the runtime writes proxy-token
METERLESS_BASE_URL=http://127.0.0.1:8088/v1  # initial base URL (the UI can change it)
SELO_SETTINGS_FILE=/path/to/settings.json    # provider settings, including the token
SELO_STATE_FILE=/path/to/state.json          # RSS sources, users, news, comments
```

A runtime bound to `127.0.0.1` on the host is **not reachable from a container**.
For Docker runs point `METERLESS_BASE_URL` at an address the container can reach
or paste a connect link in the AI Provider page; for host runs the default
`http://127.0.0.1:8088/v1` is correct.

### Zetaris configuration

```bash
ZETARIS_API_KEY=<key created in the Zetaris GUI>
ZETARIS_ORG_ID=806                 # NUMERIC organisation id that owns the key
# ZETARIS_URL=127.0.0.1:8888       # optional; default for host runs
```

The app talks to `POST <rest url>/sql-editor/sqls/run` with
`Authorization: Bearer <key>`, `X-Org-ID: <numeric id>` and a fresh
`X-Request-ID`. Two mistakes produce an HTTP 400 instead of a clear message, and
both are handled explicitly:

| Answer                       | Meaning                                           |
| ---------------------------- | ------------------------------------------------- |
| `400 {"msg":"Not Allowed"}`  | `ZETARIS_ORG_ID` is not the id that owns the key  |
| `400 Invalid value for: ...` | `ZETARIS_ORG_ID` is not numeric (a name was used) |
| `401`                        | the key is missing or revoked                     |
| `200 {"data":[["1"]]}`       | `SELECT 1` works, so the provider is **online**   |

The AI Provider page shows the Zetaris state and lets you run one read-only
statement; `POST /api/zetaris/query` refuses anything that is not a single
`SELECT`, `SHOW`, `DESCRIBE` or `WITH`.

Verification:

```bash
npm test                  # unit tests: provider, Zetaris contract and state store
npm run verify:provider   # live checks against a mock and, if present, a real runtime on 8088
npm run check:connections # live Meterless Runtime + Zetaris probes using the real modules
npm run smoke             # boots the API and checks the no-login flow end to end
```

### How AI Discussions Work

1. When "Start Discussion" is clicked for a news item:
   - Every AI personality in the app is used
   - Each AI generates initial response to news content
   - AI models periodically respond to each other's comments
   - Responses limited to 2-3 sentences, temperature 0.8

2. AI prompts include:
   - System prompt defining personality
   - News content or previous comment context
   - Instructions to react naturally and concisely

---

## Technologies Used

- **Frontend**: React 19, React Router 7, Axios 1.x, CSS3 (built with react-scripts)
- **Backend**: Node.js 24 LTS, Express 5, WebSocket (ws)
- **Storage**: one JSON document (`server/data/state.json`) for RSS sources, users, news and comments; Zetaris is queried over its REST SQL API
- **AI Integration**: Meterless Runtime provider + hosted Meterless API
- **RSS Parsing**: rss-parser library
- **Containerization**: Docker (multi-stage), nginx for the static client, Docker Compose

### Pages

There is **no login page and no authentication** anywhere in the app. Four
pages, open by design:

| Page            | Route        | What it does                                             |
| --------------- | ------------ | -------------------------------------------------------- |
| **News Feed**   | `/feed`      | RSS items, discussion start/stop, comments               |
| **RSS Sources** | `/sources`   | Every feed, item count, last fetch result, fetch/delete  |
| **Users**       | `/users`     | AI personalities (name, routing mode, personality)       |
| **AI Provider** | `/providers` | Meterless Runtime + Zetaris status, models, test queries |

Comments are posted as the single local participant that the server creates on
first use (`GET /api/participant`), so nothing has to be signed in.

---

## Project Architecture

```
├── server/             # Node.js Express server
│   ├── index.js        # HTTP API, WebSocket hub, RSS polling, discussion loop
│   ├── zetaris.js      # Zetaris REST SQL client (POST /sql-editor/sqls/run)
│   ├── zetaris.test.js # Contract unit tests
│   ├── state-store.js  # Atomic, debounced JSON persistence (server/data/state.json)
│   ├── state-store.test.js # Round-trip, corrupt-file and cap tests
│   ├── providers/      # AI provider registry (Meterless Runtime + hosted Meterless)
│   │   ├── routes.js   # /api/providers router
│   │   ├── settings-store.js # Provider settings file, including the runtime token
│   │   ├── base-url.js # Base URL normalisation
│   │   └── meterless-runtime.test.js
│   ├── Dockerfile      # Server image (node:24-alpine, multi-stage)
│   ├── init/           # Zetaris init scripts
│   └── initdb/         # PostgreSQL bootstrap SQL (audit DB)
│
├── client/             # React frontend
│   ├── src/            # Source files
│   │   ├── App.jsx     # Routes: /feed, /sources, /users, /providers, /add-rss, /add-user
│   │   ├── api.js      # API/WebSocket base URLs + local participant
│   │   ├── components/ # NewsFeed, SourcesList, UsersList, ProviderSettings, forms
│   │   ├── index.js    # Entry point
│   │   └── App.css     # Styles
│   ├── Dockerfile      # Multi-stage build (node:24-alpine -> nginx:alpine)
│   ├── nginx.conf      # SPA fallback + asset caching
│   └── package.json    # Client dependencies (dev server pinned to port 3002)
│
├── scripts/            # check-connections.cjs, smoke-test.cjs, verify-meterless-provider.cjs
├── tests/              # Playwright integration tests (example.spec.js + package.json)
├── .vscode/
│   ├── launch.json     # Server, Chrome, unit-test and script debug configurations
│   ├── tasks.json      # Dev servers, tests, Playwright and Docker tasks
│   └── settings.json   # SonarLint connection
├── package.json        # Server dependencies and dev/debug/test scripts
├── package-lock.json   # Locked server dependency tree
├── docker-compose.yml  # Full orchestration (Zetaris + app)
├── .env                # Local/production config (gitignored)
├── LICENSE             # BSD 2-Clause, Oleksandr Lopatnov
├── README.md           # This file
└── Agents.txt          # Project goals
```

---

## How to Run the Project

### Docker Mode (Recommended - Full Stack with Zetaris)

````bash
# 1. Download and setup Zetaris per official guide:
#    - Download zetaris-platform.zip from Zetaris Cloud
#    - cd zetaris-platform
#    - docker login zetarishackathon.azurecr.io
#    - ./preflight.sh
#    - Edit .env with your settings
#    - docker compose pull && docker compose up -d
#    - ./verify.sh

# 2. Configure our application .env:
#    From the project root (C:\projects\selo):
#    - ZETARIS_URL: http://host.docker.internal:8888
#    - ZETARIS_API_KEY: <key created in THAT stack's Zetaris GUI at :3010>
#    - ZETARIS_ORG_ID: <numeric organisation id that owns the key>
#    - METERLESS_API_URL: https://api.meterless.ai/v1
#    - METERLESS_API_KEY: <your key; also the Meterless Runtime token>

# 3. Start the whole stack (Zetaris + our app):
docker compose up --build -d

# 3. Access:
#    - Our Application: http://localhost:3002
#    - Zetaris UI: http://localhost:3010  (UI_PORT in .env)
#    - Zetaris API: http://localhost:8898 (API_PORT in .env)

# 4. First-time Application Setup (no login anywhere):
#    1. Open http://localhost:3002 → News Feed
#    2. Add RSS sources (e.g., https://techcrunch.com/feed/)
#    3. Create AI personalities on Users (meterless/auto, meterless/deep, …)
#    4. Click news items → "Start Discussion"
#    5. Add your comments, watch AI react
#    6. Open AI Provider to see Meterless Runtime and Zetaris status

### Development Mode (the path verified against a live stack)
```bash
# Requires Node.js 22+ (the Docker images use Node 24 LTS)
npm install
npm --prefix client install

# Terminal 1: Server (Express 5, port 3001)
npm start

# Terminal 2: Client (CRA dev server, port 3000 by default)
npm --prefix client start

# Collections live in the server process; Meterless Runtime on
# 127.0.0.1:8088 and Zetaris on 127.0.0.1:8888 are reachable as-is.
npm run check:connections   # both probes, using the real modules
npm run smoke               # boots the API and checks the no-login flow
````

### Local Production Build

```bash
npm --prefix client run build   # static bundle in client/build
```

### Stopping & Cleanup

```bash
# Stop containers, retain data
docker compose stop

# Restart
docker compose start

# Full cleanup (removes containers/network, KEEPS volumes)
docker compose down

# NUCLEAR: Remove everything including data
docker compose down -v
```

---

## Debugging

### VS Code: one click for the full stack

The repository ships debug configurations in `.vscode/launch.json` and run
tasks in `.vscode/tasks.json`.

1. Run `npm run install-all` once.
2. Open **Run and Debug** (`Ctrl+Shift+D`), choose
   **Full stack: Server + Chrome**, then press `F5`.
   - The `dev: client (background)` task starts the CRA dev server on
     <http://localhost:3002> with its browser auto-open disabled.
   - The API starts under the Node debugger on <http://localhost:3001>.
   - Chrome opens at <http://localhost:3002> with source maps for
     [`client/src`](client/src).
3. Put breakpoints in server files or React components and debug normally.
   `stopAll` stops the debug sessions; the background client task can keep
   running, so terminate it from the **Terminal** panel when you are done.
4. Do not run `npm run dev` at the same time: ports `3001` and `3002` would
   already be taken. Use one workflow or the other.

### Launch configurations

| Configuration                         | What it does                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Full stack: Server + Chrome**       | Compound: API debugger + client task + Chrome                                                       |
| **Server: Node (launch)**             | API only; breakpoints in `server/index.js` and modules                                              |
| **Server: Attach (:9229)**            | Attaches to a server already started with `npm run dev:debug` (nodemon with `--inspect=9229`)       |
| **Client: Chrome (localhost:3002)**   | Browser debugging with source maps; runs the client task first                                      |
| **Test: state store**                 | Debugs [`server/state-store.test.js`](server/state-store.test.js:1)                                 |
| **Test: Zetaris client**              | Debugs [`server/zetaris.test.js`](server/zetaris.test.js:1)                                         |
| **Test: Meterless Runtime provider**  | Debugs [`server/providers/meterless-runtime.test.js`](server/providers/meterless-runtime.test.js:1) |
| **Test: current file**                | Debugs whatever test or script file is active                                                       |
| **Unit tests: all**                   | Compound of the three unit suites                                                                   |
| **Script: smoke test**                | Debugs [`scripts/smoke-test.cjs`](scripts/smoke-test.cjs:1) on port 3155                            |
| **Script: check connections**         | Debugs [`scripts/check-connections.cjs`](scripts/check-connections.cjs:1)                           |
| **Script: verify Meterless provider** | Debugs [`scripts/verify-meterless-provider.cjs`](scripts/verify-meterless-provider.cjs:1)           |

### Debugging from the terminal

```bash
# API with an inspector; attach with "Server: Attach (:9229)" or chrome://inspect
npm run server:debug

# API with inspector plus the client, both watched
npm run dev:debug
```

Useful breakpoint locations:

| Concern                                                 | Where                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Discussion orchestration and the 30 s AI loop           | [`server/index.js`](server/index.js:165)                                                      |
| Comment creation and persistence                        | [`server/index.js`](server/index.js:230)                                                      |
| RSS parsing, de-duplication and per-source errors       | [`server/index.js`](server/index.js:253)                                                      |
| Read-only SQL guard (`SELECT`/`SHOW`/`DESCRIBE`/`WITH`) | [`server/index.js`](server/index.js:484)                                                      |
| Runtime status, token precedence and chat headers       | [`server/providers/meterless-runtime.js`](server/providers/meterless-runtime.js)              |
| Atomic/debounced JSON persistence                       | [`server/state-store.js`](server/state-store.js:61)                                           |
| Zetaris REST SQL contract                               | [`server/zetaris.js`](server/zetaris.js)                                                      |
| WebSocket client, reconnect and message handling        | [`client/src/components/NewsFeed.jsx`](client/src/components/NewsFeed.jsx:48)                 |
| Provider page load/save/detect/connect flow             | [`client/src/components/ProviderSettings.jsx`](client/src/components/ProviderSettings.jsx:83) |

### Browser and network debugging

- **DevTools → Network** shows the REST calls; **WS → Messages** shows
  `news_updated`, `rss_sources_updated`, `new_comment` and
  `discussion_status` frames.
- The console logs `WebSocket connected`, and the client reconnects every 5 s
  after a close.
- The API base is baked in at build time from `REACT_APP_API_URL` (default
  `http://localhost:3001/api`); the Docker client image receives it through the
  `CLIENT_API_URL` build argument. Check the actual value in the Network tab
  first when requests go to the wrong host.
- Read the server boot banner: it prints the state file path, source/user/news/
  comment counts, Zetaris URL/org/key presence, runtime base URL/token source,
  and both provider statuses.

### Inspect and reset the app state

```powershell
# Show the persisted document (RSS sources, users, news, comments)
Get-Content .\server\data\state.json

# Reset local state: stop the server first, then delete the file
Remove-Item .\server\data\state.json
```

`SELO_STATE_FILE` points the server at a different file. The smoke test always
uses a temporary file and never touches `server/data/state.json`.

### Debugging inside Docker

```bash
docker compose ps --all
docker compose logs -f server client
docker compose logs --tail=200 server
docker compose exec server curl -fsS http://127.0.0.1:3001/health
```

For step debugging, run the Node process on the host
(`npm run server:debug`) and point it at the Dockerised Zetaris API
(`ZETARIS_URL=http://127.0.0.1:8898`, the published `API_PORT`). The runtime
caveat stays the same: a Meterless Runtime bound to `127.0.0.1` on the host is
not reachable from inside a container.

### Debugging the UI end to end

- `npm --prefix tests run test:ui` opens the Playwright UI runner.
- PowerShell: `$env:PWDEBUG=1; npm --prefix tests test` opens the Playwright
  inspector step by step.
- Failed runs keep screenshots and traces under `tests/test-results/`.

---

## Testing

### Suite overview

| Suite                                 | Command                     | External services                                                                                |
| ------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
| Unit and contract tests (`node:test`) | `npm test`                  | none — mocks and loopback only                                                                   |
| Provider contract only                | `npm run test:provider`     | none                                                                                             |
| Zetaris contract only                 | `npm run test:zetaris`      | none                                                                                             |
| State store only                      | `npm run test:state`        | none                                                                                             |
| Smoke test                            | `npm run smoke`             | `.env` with a runtime and Zetaris both online; boots the API on port 3155 with a temp state file |
| Provider live checks                  | `npm run verify:provider`   | mock runtime on port 18090; probes a real runtime on 8088 if one is listening                    |
| Connection checks                     | `npm run check:connections` | real Meterless Runtime and Zetaris from `.env`                                                   |
| End-to-end (Playwright)               | `npm --prefix tests test`   | a running app at <http://localhost:3002>                                                         |

### Unit and contract tests

`npm test` runs three `node:test` files with Node's built-in runner, so there is
no test framework to install. The VS Code configurations above debug one file
at a time with working breakpoints.

What they protect:

- [`server/providers/meterless-runtime.test.js`](server/providers/meterless-runtime.test.js)
  — base-URL normalisation (never `/v1/v1`), token precedence, status mapping
  (`online` / `unauthorized` / `offline`), chat headers.
- [`server/zetaris.test.js`](server/zetaris.test.js) — the REST SQL contract,
  read-only query guard and error mapping.
- [`server/state-store.test.js`](server/state-store.test.js) — round-trip,
  corrupt-file recovery and the news/comment caps.

```bash
npm test
npm run test:state
```

### Smoke test

`npm run smoke` spawns the real server on port 3155 with a temporary
`SELO_STATE_FILE`, so your real `server/data/state.json` is untouched. It
checks: no login route exists, the participant is handed out, **both providers
report online**, Zetaris answers `SELECT 1`, a write is refused, duplicate
feeds return `409`, a failing feed records `lastError`, and fetch-all polls
every source. It prints `PASS` / `FAIL` and exits non-zero when anything fails.

Because two of the checks are live provider probes, the `.env` credentials must
work before this suite is green. Run `npm run check:connections` first when in
doubt.

```bash
npm run smoke
```

### Live provider and connection checks

```bash
npm run verify:provider    # mock runtime + optional real runtime on 8088
npm run check:connections  # real .env credentials; secrets are masked
```

`check:connections` prints only lengths and booleans, then exits `1` if either
provider is not online. It is the fastest way to prove the credentials in
`.env` work.

### End-to-end tests (Playwright)

One-time setup:

```bash
npm --prefix tests install
npm --prefix tests run install-browsers
```

Run against a stack already listening at <http://localhost:3002>:

```bash
npm --prefix tests test
npm --prefix tests run test:headed
npm --prefix tests run test:ui
```

Notes:

- [`tests/example.spec.js`](tests/example.spec.js:3) adds the TechCrunch feed
  and expects `.news-item`, so it mutates the feed list of the stack under test.
  Use a disposable dev stack, not a stack holding data you care about.
- The spec hardcodes `http://localhost:3002`; start Docker
  (`docker compose up -d`) or `npm run dev` first.
- On PowerShell, set environment variables with `$env:NAME="value";` instead of
  the `NAME=value command` syntax used by bash.

### Suggested CI order

```bash
npm run install-all
npm test
npm run smoke
npm run verify:provider
# optional: require credentials and a deployed stack
# npm run check:connections
# npm --prefix tests test
```

Unit tests are hermetic. The smoke, provider, connection and Playwright suites
need the services and credentials described in their sections.

---

## Troubleshooting

### Common Issues

#### 1. Preflight Check Fails

```bash
# From zetaris-platform directory
./preflight.sh
# Fix all reported issues before proceeding
```

#### 2. Driver Won't Start (Spark Metastore Build)

```bash
docker compose logs driver
# First startup takes 2-5 minutes on slow/emulated hosts
# Wait for retries (180 x 10s = 30 min max)
```

#### 3. UI Shows 404 or Blank Page

```bash
docker compose logs ui
# Check if API is healthy
curl http://host.docker.internal:8888/
```

#### 4. Our App Can't Connect to Zetaris

```bash
# From inside our server container
docker compose exec server curl http://host.docker.internal:8888/
docker compose logs server
```

#### 5. Data Not Persisting

```bash
docker volume ls
# Should show: selo_pgdata, selo_customer-data, selo_driver-data, etc.
```

#### 5. Reset Everything (Nuclear Option)

```bash
# WARNING: Deletes ALL data including metastore, encryption keys, users
docker compose down -v
docker system prune -f
# Then restart from Step 1
```

### Logs & Debugging

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f driver
docker compose logs -f api
docker compose logs -f server

# Last 100 lines
docker compose logs --tail=100 api
```

### Health Checks

```bash
# Quick status
docker compose ps

# Detailed health
docker inspect --format='{{.State.Health.Status}}' $(docker compose ps -q driver)
```

---

## Quick Reference Commands

| Task                     | Command                                         |
| ------------------------ | ----------------------------------------------- |
| Install everything       | `npm run install-all`                           |
| Run API + client locally | `npm run dev`                                   |
| Debug the API            | `npm run server:debug`, then attach to `:9229`  |
| Debug full stack         | `F5` → **Full stack: Server + Chrome**          |
| Unit tests               | `npm test`                                      |
| Smoke test               | `npm run smoke`                                 |
| Live provider check      | `npm run verify:provider`                       |
| Live connection check    | `npm run check:connections`                     |
| End-to-end tests         | `npm --prefix tests test`                       |
| Start all containers     | `docker compose up -d`                          |
| Stop (keep data)         | `docker compose stop`                           |
| Restart                  | `docker compose start`                          |
| Rebuild & start          | `docker compose up --build -d`                  |
| View logs                | `docker compose logs -f [service]`              |
| Check status             | `docker compose ps --all`                       |
| Verify Zetaris           | `./verify.sh` (from the `zetaris-platform` dir) |
| Clean restart            | `docker compose down && docker compose up -d`   |
| Nuclear reset            | `docker compose down -v`                        |

---

## License

This project is distributed under the **BSD 2-Clause License**.

Copyright (c) 2026, **Oleksandr Lopatnov**.

The full text is kept in [`LICENSE`](LICENSE) and reproduced below:

```text
BSD 2-Clause License

Copyright (c) 2026, Oleksandr Lopatnov

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Third-party dependencies (React, Express, `rss-parser`, Playwright, and the
Meterless/Zetaris tooling) keep their own licenses and copyright notices.
