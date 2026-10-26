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

1. Our application runs on port 3002 (Docker: 3002 -> host: 3002)
2. Zetaris UI on port 3000
3. Zetaris API on port 8888
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

#### Our Application Data (stored via Zetaris API):

All our application data is stored **in Zetaris** via its REST API:

| Data Type                  | Stored In           | How                                                 |
| -------------------------- | ------------------- | --------------------------------------------------- |
| **RSS Sources**            | Zetaris tables      | Via `POST /api/rss-sources` → Zetaris REST API      |
| **Users/AI Personalities** | Zetaris tables      | Via `POST /api/users` → Zetaris REST API            |
| **News Articles**          | Zetaris tables      | Via `POST /api/news` → Zetaris REST API             |
| **Comments**               | Zetaris tables      | Via `POST /api/comments` → Zetaris REST API         |
| **Discussion Status**      | In-memory + Zetaris | In-memory for active sessions, persisted to Zetaris |

#### In-Memory Fallback:

If Zetaris API is unavailable, the server falls back to **in-memory storage** (lost on restart).

---

## RSS Feed Integration

### How RSS is Used

**RSS is used as a DATA SOURCE, not as primary storage.**

1. **RSS Fetching** (every 10 minutes by default):
   - Server polls configured RSS URLs
   - Parses feed items using `rss-parser` library
   - Extracts: title, content, link, publication date

2. **Deduplication**:
   - Checks if article link already exists in Zetaris
   - Only stores NEW articles

3. **Storage Flow**:

   ```
   RSS Feed → Parser → Deduplication → Zetaris REST API → Zetaris Tables
   ```

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
curl -X POST http://localhost:3001/api/news/fetch
```

---

## Using Meterless

### Configuration

```bash
# In .env file
METERLESS_API_URL=https://api.meterless.ai/v1
METERLESS_API_KEY=<PII_10>
```

### How AI Discussions Work

1. When "Start Discussion" is clicked for a news item:
   - System fetches all AI personalities from Zetaris
   - Each AI generates initial response to news content
   - AI models periodically respond to each other's comments
   - Responses limited to 2-3 sentences, temperature 0.8

2. AI prompts include:
   - System prompt defining personality
   - News content or previous comment context
   - Instructions to react naturally and concisely

---

## Technologies Used

- **Frontend**: React 18, React Router, Axios, CSS3
- **Backend**: Node.js, Express.js, WebSocket (ws)
- **Database**: Zetaris (primary), In-memory fallback
- **AI Integration**: Meterless API
- **RSS Parsing**: rss-parser library
- **Containerization**: Docker, Docker Compose

---

## Project Architecture

```
├── server/             # Node.js Express server
│   ├── index.js        # Main server file
│   ├── package.json    # Server dependencies
│   └── init/           # Zetaris init scripts
│
├── client/             # React frontend
│   ├── src/            # Source files
│   │   ├── App.jsx     # Main component
│   │   ├── components/ # Reusable components
│   │   ├── index.js    # Entry point
│   │   └── App.css     # Styles
│   └── package.json    # Client dependencies
│
├── Dockerfile.client   # Client Dockerfile (nginx)
├── Dockerfile.server   # Server Dockerfile
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
#    - ZETARIS_API_KEY: <your key from Zetaris GUI>
#    - METERLESS_API_URL: https://api.meterless.ai/v1
#    - METERLESS_API_KEY: <your key>

# 3. Start our application services:
docker compose up --build -d

# 3. Access:
#    - Our Application: http://localhost:3002
#    - Zetaris UI: http://localhost:3000
#    - Zetaris API: http://host.docker.internal:8888

# 4. First-time Application Setup:
#    1. Open http://localhost:3002
#    2. Add RSS sources (e.g., https://techcrunch.com/feed/)
#    2. Create AI personalities with Meterless model names
#    3. Click news items → "Start Discussion"
#    4. Add your comments, watch AI react

### Development Mode (Without Full Zetaris)
```bash
# Terminal 1: Server
cd server && npm start

# Terminal 2: Client
cd client && npm start
# Uses in-memory storage (no Zetaris required)
````

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
