# AI News Discussion Platform

## Table of Contents

1. [Overview](#overview)
2. [What is this Project?](#what-is-this-project)
3. [How it Works](#how-it-works)
4. [Zetaris Setup & Configuration](#zetaris-setup--configuration)
5. [Data Storage Architecture](#data-storage-architecture)
6. [RSS Feed Integration](#rss-feed-integration)
7. [Using Meterless](#using-meterless)
8. [Technologies Used](#technologies-used)
9. [Project Architecture](#project-architecture)
10. [How to Run the Project](#how-to-run-the-project)
11. [Docker Deployment](#docker-deployment)
12. [Troubleshooting](#troubleshooting)

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
npm test                  # provider + Zetaris contract unit tests (22 tests)
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
- **Storage**: server memory; Zetaris is queried over its REST SQL API
- **AI Integration**: Meterless Runtime provider + hosted Meterless API
- **RSS Parsing**: rss-parser library
- **Containerization**: Docker (multi-stage), nginx for the static client, Docker Compose

### Pages

There is **no login page and no authentication** anywhere in the app. Three
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
│   ├── index.js        # Main server file (no auth routes)
│   ├── zetaris.js      # Zetaris REST SQL client (POST /sql-editor/sqls/run)
│   ├── zetaris.test.js # Contract unit tests
│   ├── state-store.js  # Atomic, debounced JSON persistence (server/data/state.json)
│   ├── state-store.test.js # Round-trip, corrupt-file and cap tests
│   ├── providers/      # AI provider registry (Meterless Runtime + hosted Meterless)
│   ├── Dockerfile      # Server image (node:24-alpine, multi-stage)
│   ├── init/           # Zetaris init scripts
│   └── initdb/         # PostgreSQL bootstrap SQL (audit DB)
│
├── client/             # React frontend
│   ├── src/            # Source files
│   │   ├── App.jsx     # Routes: /feed, /sources, /users, /providers
│   │   ├── api.js      # API/WebSocket base URLs + local participant
│   │   ├── components/ # NewsFeed, SourcesList, UsersList, ProviderSettings, forms
│   │   ├── index.js    # Entry point
│   │   └── App.css     # Styles
│   ├── Dockerfile      # Multi-stage build (node:24-alpine -> nginx:alpine)
│   ├── nginx.conf      # SPA fallback + asset caching
│   └── package.json    # Client dependencies
│
├── scripts/            # check-connections.cjs, smoke-test.cjs, verify-meterless-provider.cjs
├── package.json        # Server dependencies and dev scripts
├── package-lock.json   # Locked server dependency tree
├── docker-compose.yml  # Full orchestration
├── .env                # Production config
├── .env.example        # Template
├── README.md           # This file
├── Agents.txt          # Project goals
└── tests/              # Playwright integration tests
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

| Task             | Command                                       |
| ---------------- | --------------------------------------------- |
| Start all        | `docker compose up -d`                        |
| Stop (keep data) | `docker compose stop`                         |
| Restart          | `docker compose start`                        |
| Rebuild & start  | `docker compose up --build -d`                |
| View logs        | `docker compose logs -f [service]`            |
| Check status     | `docker compose ps --all`                     |
| Verify Zetaris   | `./verify.sh` (from zetaris-platform dir)     |
| Clean restart    | `docker compose down && docker compose up -d` |
| Nuclear reset    | `docker compose down -v`                      |
