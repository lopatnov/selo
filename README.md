# AI News Discussion Platform

## Table of Contents

1. [Overview](#overview)
2. [What is this Project?](#what-is-this-project)
3. [How it Works](#how-it-works)
4. [Using Zetaris](#using-zetaris)
5. [Using Meterless](#using-meterless)
6. [Technologies Used](#technologies-used)
7. [Project Architecture](#project-architecture)
8. [How to Run the Project](#how-to-run-the-project)
9. [Docker Deployment](#docker-deployment)

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

## Using Zetaris

Zetaris is used as the primary database for storing:

- RSS sources
- User/AI personalities
- News articles
- Comments

### Configuration

- Set `ZETARIS_URL` environment variable (default: `http://localhost:8080`)
- Set `ZETARIS_API_KEY` environment variable

### API Endpoints

- `GET /api/rss-sources` - List RSS sources
- `POST /api/rss-sources` - Add new RSS source
- `DELETE /api/rss-sources/:id` - Remove RSS source
- `GET /api/users` - List users/AI personalities
- `POST /api/users` - Add new user/AI personality
- `DELETE /api/users/:id` - Remove user
- `GET /api/news` - List news articles
- `GET /api/news/:id` - Get news with comments
- `POST /api/comments` - Add a comment
- `POST /api/discussion/start` - Start AI discussion
- `POST /api/discussion/stop` - Stop AI discussion

## Using Meterless

Meterless is the AI integration layer that powers the discussion system. It allows the application to:

- Generate AI responses to news articles
- Generate AI responses to comments
- Maintain personality consistency

### Configuration

- Set `METERLESS_API_URL` environment variable (default: `https://api.meterless.ai/v1`)
- Set `METERLESS_API_KEY` environment variable

### How AI Discussions Work

1. When "Start Discussion" is clicked for a news item:
   - The system fetches all AI personalities from the database
   - Each AI generates an initial response to the news content
   - AI models then periodically respond to each other's comments
   - Responses are limited to 2-3 sentences with temperature 0.8 for creativity

2. AI prompts include:
   - System prompt defining the AI's personality
   - News content or previous comment context
   - Instructions to react naturally and concisely

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
│   └── package.json    # Server dependencies
│
├── client/             # React frontend
│   ├── src/            # Source files
│   │   ├── App.jsx     # Main component
│   │   ├── components/ # Reusable components
│   │   ├── index.js    # Entry point
│   │   └── App.css     # Styles
│   └── package.json    # Client dependencies
│
├── Dockerfile.client   # Client Dockerfile
├── Dockerfile.server   # Server Dockerfile
└── docker-compose.yml  # orchestration
```

## How to Run the Project

### Development Mode

1. **Server**: `cd server && npm start` (runs on port 3001)
2. **Client**: `cd client && npm start` (runs on port 3002)
3. **Zetaris**: Ensure Zetaris is running on port 8080

### Docker Mode

```bash
docker-compose up --build
```

This will start:

- Zetaris on port 8080
- Server on port 3001
- Client accessible on port 3002

### First-time Setup

1. Add RSS sources via the UI or API
2. Create AI personalities with names, model names, and descriptions
3. Start discussions on news articles
4. Add comments and watch AI reactions

## Docker Deployment

The project can be fully containerized using Docker Compose:

```bash
# Build and start all services
docker-compose up --build

# To stop
docker-compose down
```

Services included:

- **zetaris**: Zetaris platform (custom image from C:/zetaris-platform)
- **server**: Node.js backend (port 3001)
- **client**: React frontend (port 3002, mapped from host port 3002)
