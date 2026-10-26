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

### Step-by-Step Zetaris Installation

#### 1. Prepare Environment Files

The project includes two environment files in the root directory:

- `.env.example` - Template with all required variables
- `.env` - Actual configuration (already populated with your credentials)

**Critical variables that MUST be set before first startup:**

```bash
# Zetaris Platform Images (from C:\zetaris-platform)
DRIVER_IMAGE=zetarishackathon.azurecr.io/zetaris-ndp-driver:2.4.3-v2.4.3.1-hackathon.cb88df0b255aba5a9a9eda96483fc877cc82df80
API_IMAGE=zetarishackathon.azurecr.io/zetaris-ndp-api:2.4.3-v2.4.3.1-hackathon.a2848d8a41fa21673a0d719deb41b675412710fe
UI_IMAGE=zetarishackathon.azurecr.io/zetaris-new-ui:2.4.3-v2.4.3.1-hackathon.88e49b0db015979a2d071d2d68a6865d38a39f15

# Administrator Account (set BEFORE first startup)
ZETARIS_ADMIN_EMAIL=oleksandr@lopatnov.cv.ua
ZETARIS_ADMIN_PASSWORD=Zetaris1@
ZETARIS_ADMIN_ORG=cruso

# PostgreSQL Credentials
POSTGRES_USER=zetaris
POSTGRES_PASSWORD=zt-metastore-6f2a9c41d0b7

# Resource Sizing
ZSPARK_DRIVER_MEM=2g
ZSPARK_DRIVER_CORES=2
ZSPARK_MASTER_URL=local[2]
ZETARIS_API_MAX_HEAP=1g

# Network
UI_PORT=3000
ALLOWED_ORIGINS=http://localhost:3000
GUI_URL=http://localhost:3000
API_PORT=8888
API_INTERNAL_PORT=8889
DRIVER_PORT=10000
SPARK_UI_PORT=4040
QUERY_HTTP_PUBLISH=0

# Sample Data
ZETARIS_SEED_TPCH=true
```

#### 2. Authenticate with Zetaris Registry

```bash
# From the project root directory (C:\projects\selo)
docker login zetarishackathon.azurecr.io
# Enter the registry credentials provided by Zetaris
```

#### 3. Start the Platform

```bash
# From project root (C:\projects\selo)
docker-compose up --build -d
```

#### 3. Verify Startup

```bash
# Check all services are running
docker-compose ps --all

# Expected output: postgres, driver, api, ui, bootstrap should be running
# init and bootstrap should show "Exited (0)" after completion

# Check logs for any issues
docker-compose logs --tail=80 driver api bootstrap
```

#### 4. Verify with Built-in Verification Script

```bash
# After all services show as healthy, run verification
./verify.sh
```

Expected results:

- `postgres`, `driver`, `api`, `ui`, `ai-datasteward` are running
- `init` and `bootstrap` show `Exited (0)` (successful one-time setup)
- `verify.sh` passes all checks including login and query through UI, API, and query engine

#### 5. First Login & API Key Creation

1. Open **http://localhost:3000** in browser
2. Sign in with:
   - Email: `oleksandr@lopatnov.cv.ua`
   - Password: `Zetaris1@`
3. **Change password immediately** from user menu (top right)
4. Create API Key for application integration:
   - Go to Settings → API Keys
   - Create new key with appropriate permissions
   - Copy the API key to your `.env` file:
     ```bash
     ZETARIS_API_KEY=your-generated-api-key
     ```

#### 5. Zetaris Service Endpoints

After successful startup:

- **UI (Web Interface)**: http://localhost:3000
- **Public API**: http://localhost:8888
- **Internal API**: http://localhost:8889
- **Driver (JDBC)**: jdbc:zetaris:lightning@localhost:10000
- **Spark UI**: http://localhost:4040

---

## Data Storage Architecture

### Where Data is Stored

All persistent data is stored in **Docker named volumes** managed by the Zetaris platform:

| Volume          | Purpose                                        | Persistence                    |
| --------------- | ---------------------------------------------- | ------------------------------ |
| `pgdata`        | PostgreSQL metastore & audit databases         | Survives `docker-compose down` |
| `customer-data` | **Our application data + Zetaris file system** | Survives `docker-compose down` |
| `driver-data`   | Driver encryption keys, tokens, metastore      | Survives `docker-compose down` |
| `driver-logs`   | Spark/Driver logs                              | Survives `docker-compose down` |
| `caddy-data`    | TLS certificates (if using TLS profile)        | Survives `docker-compose down` |
| `caddy-config`  | Caddy configuration                            | Survives `docker-compose down` |

### What Data Goes Where

#### Zetaris Platform Data (in `pgdata`, `driver-data`, `customer-data`):

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

If Zetaris API is unavailable, the server falls back to **in-memory storage** (lost on restart). This is indicated in logs with "Fallback to in-memory storage".

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

You can trigger immediate fetch via API:

```bash
curl -X POST http://localhost:3001/api/news/fetch
```

---

## Using Meterless

### Configuration

```bash
# In .env file
METERLESS_API_URL=https://api.meterless.ai/v1
METERLESS_API_KEY=your-meterless-api-key
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

## Project Architecture

```
├── server/             # Node.js Express server
│   ├── index.js        # Main server file
│   ├── package.json    # Server dependencies
│   └── init/           # Zetaris init scripts (mounted to containers)
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
├── verify.sh           # Zetaris verification script
├── README.md           # This file
├── Agents.txt          # Project goals
└── tests/              # Playwright integration tests
```

## How to Run the Project

### Docker Mode (Recommended - Full Stack)

```bash
# 1. Ensure .env is configured (already done)
cd C:\projects\selo

# 2. Login to Zetaris registry
docker login zetarishackathon.azurecr.io

# 3. Build and start ALL services
docker-compose up --build -d

# 4. Verify
docker-compose ps --all
docker-compose logs --tail=80 driver api bootstrap
./verify.sh
```

### Access Points After Startup:

- **Our Application**: http://localhost:3002
- **Zetaris UI**: http://localhost:3000
- **Zetaris API**: http://localhost:8888
- **Our Server API**: http://localhost:3001

### First-time Application Setup:

1. Open http://localhost:3002
2. Add RSS sources (e.g., `https://techcrunch.com/feed/`)
3. Create AI personalities with Meterless model names
4. Click news items → "Start Discussion"
5. Add your comments, watch AI react

### Development Mode (Without Zetaris)

```bash
# Terminal 1: Server
cd server && npm start

# Terminal 2: Client
cd client && npm start
# Uses in-memory storage (no Zetaris required)
```

### Stopping & Cleanup

```bash
# Stop containers, retain data
docker-compose stop

# Restart
docker-compose start

# Full cleanup (removes containers/network, KEEPS volumes)
docker-compose down

# NUCLEAR: Remove everything including data
docker-compose down -v
```

---

## Troubleshooting

### Common Issues

#### 1. Preflight Check Fails

```bash
# Run preflight from Zetaris platform directory
cd C:\zetaris-platform
./preflight.sh
# Fix all reported issues before proceeding
```

#### 2. Driver Won't Start (Spark Metastore Build)

```bash
# Check driver logs
docker-compose logs driver
# First startup takes 2-5 minutes on slow/emulated hosts
# Wait for retries (180 x 10s = 30 min max)
```

#### 3. UI Shows 404 or Blank Page

```bash
# Check if API is healthy
curl http://localhost:8888/
# Check UI logs
docker-compose logs ui
```

#### 4. Our App Can't Connect to Zetaris

```bash
# Verify Zetaris API is reachable from our server
docker-compose exec server curl http://api:8888/

# Check server logs
docker-compose logs server
```

#### 5. Data Not Persisting

```bash
# Check volumes exist
docker volume ls
# Should show: selo_pgdata, selo_customer-data, selo_driver-data, etc.
```

#### 6. Reset Everything (Nuclear Option)

```bash
# WARNING: Deletes ALL data including metastore, encryption keys, users
docker-compose down -v
docker system prune -f
# Then restart from step 1
```

### Logs & Debugging

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f driver
docker-compose logs -f api
docker-compose logs -f server

# Last 100 lines
docker-compose logs --tail=100 api
```

### Health Checks

```bash
# Quick status
docker-compose ps

# Detailed health
docker inspect --format='{{.State.Health.Status}}' $(docker-compose ps -q driver)
```

---

## Quick Reference Commands

| Task             | Command                                       |
| ---------------- | --------------------------------------------- |
| Start all        | `docker-compose up -d`                        |
| Stop (keep data) | `docker-compose stop`                         |
| Restart          | `docker-compose start`                        |
| Rebuild & start  | `docker-compose up --build -d`                |
| View logs        | `docker-compose logs -f [service]`            |
| Check status     | `docker-compose ps --all`                     |
| Verify Zetaris   | `./verify.sh`                                 |
| Clean restart    | `docker-compose down && docker-compose up -d` |
| Nuclear reset    | `docker-compose down -v`                      |
