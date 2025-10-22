# Flashtasks Backend

Node.js + Express backend for Elasticsearch search and indexing.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Fill in your Elasticsearch credentials in `.env`

## Development

Run locally:
```bash
npm run dev
```

Server runs on http://localhost:3001

## Endpoints

### POST /api/search
Search tasks in Elasticsearch.

**Request:**
```json
{
  "query": "design",
  "userEmail": "user@example.com",
  "limit": 10
}
```

**Response:**
```json
{
  "results": [
    {
      "$id": "task-id",
      "title": "Task title",
      "description": "...",
      "status": "pending",
      "userEmail": "user@example.com"
    }
  ]
}
```

### POST /api/index
Webhook endpoint for Appwrite to call when tasks are created/updated/deleted.

**Request:**
```json
{
  "event": "databases.*.collections.*.documents.*.create",
  "document": {
    "$id": "task-id",
    "title": "Task title",
    "userEmail": "user@example.com",
    ...
  }
}
```

## Deploy to Vercel

1. Install Vercel CLI:
```bash
npm i -g vercel
```

2. Deploy:
```bash
vercel
```

3. Add environment variables in Vercel dashboard:
   - ELASTICSEARCH_URL
   - ELASTICSEARCH_API_KEY
   - ELASTICSEARCH_INDEX

4. Copy your deployment URL (e.g., `https://flashtasks-backend.vercel.app`)

## Connect to Frontend

Update your frontend `.env.local`:
```
VITE_BACKEND_URL=https://flashtasks-backend.vercel.app
```

## Setup Appwrite Webhook

1. Go to Appwrite Console → Project Settings → Webhooks
2. Create a new webhook:
   - Name: `elasticsearch-indexer`
   - URL: `https://your-vercel-url.vercel.app/api/index`
   - Events:
     - databases.68f9033c000c2a1c40c9.collections.taskslist.documents.*.create
     - databases.68f9033c000c2a1c40c9.collections.taskslist.documents.*.update
     - databases.68f9033c000c2a1c40c9.collections.taskslist.documents.*.delete
   - HTTP Method: POST
   - Optional: Add header `x-webhook-secret: <same-as-WEBHOOK_SECRET>`
3. Save and test by creating a task in your app
