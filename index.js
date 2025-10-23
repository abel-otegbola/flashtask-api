import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Client } from '@elastic/elasticsearch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
    'localhost:3000',
    'https://flashtasks.app',
    'https://www.flashtasks.app'
];
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}
// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Elasticsearch client
const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL,
  auth: process.env.ELASTICSEARCH_API_KEY
    ? { apiKey: process.env.ELASTICSEARCH_API_KEY }
    : {
        username: process.env.ELASTICSEARCH_USERNAME,
        password: process.env.ELASTICSEARCH_PASSWORD
      },
  tls: { rejectUnauthorized: false }
});

const ELASTIC_INDEX = process.env.ELASTICSEARCH_INDEX || 'tasks';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'flashtasks-backend' });
});

// Search endpoint
app.post('/api/search', async (req, res) => {
  try {
    const { query, userEmail, limit = 10 } = req.body;

    if (!userEmail) {
      return res.status(400).json({ results: [], error: 'userEmail required' });
    }

    if (!query || String(query).trim().length < 2) {
      return res.json({ results: [] });
    }

    const esQuery = {
      index: ELASTIC_INDEX,
      size: Math.min(Number(limit) || 10, 50),
      query: {
        bool: {
          must: [
            {
              simple_query_string: {
                query: `${query}*`,
                fields: ['title^3', 'description^2', 'category', 'assignee', 'invites'],
                default_operator: 'and'
              }
            }
          ],
          filter: [
            { term: { userEmail: userEmail } }
          ]
        }
      },
      _source: ['title', 'description', 'category', 'status', 'priority', 'dueDate', 'userEmail', '$createdAt', '$updatedAt']
    };

    const result = await esClient.search(esQuery);
    const hits = result.hits?.hits || [];
    const items = hits.map((h) => ({
      $id: h._id,
      ...(h._source || {})
    }));

    res.json({ results: items });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ results: [], error: 'search_failed' });
  }
});

// Indexing webhook endpoint
app.post('/api/index', async (req, res) => {
  try {
    // Optional webhook secret check
    const expectedSecret = process.env.WEBHOOK_SECRET;
    if (expectedSecret) {
      const headerSecret = req.headers['x-webhook-secret'] || req.headers['x-webhook-token'];
      if (headerSecret !== expectedSecret) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    }

    // Appwrite can send event info via headers or body depending on integration
    const headerEvent = req.headers['x-appwrite-event'] || req.headers['x-appwrite-webhook-event'];
    const bodyEvent = req.body?.event || req.body?.events || req.body?.type;
    const event = (Array.isArray(bodyEvent) ? bodyEvent[0] : bodyEvent) || headerEvent || '';

    // Try to normalize document from various possible shapes
    const document = req.body?.document
      || req.body?.payload?.document
      || req.body?.payload
      || (req.body?.$id ? req.body : undefined);
    
    if (!document?.$id) {
      return res.status(400).json({ ok: false, error: 'missing_document' });
    }

    const id = document.$id;

    // Delete operation
    if (event && String(event).includes('delete')) {
      await esClient.delete({ index: ELASTIC_INDEX, id }).catch(() => {});
      return res.json({ ok: true, action: 'deleted', id });
    }

    // Upsert for create/update
    const body = {
      title: document.title,
      description: document.description,
      category: document.category,
      status: document.status,
      priority: document.priority,
      dueDate: document.dueDate,
      userEmail: document.userEmail,
      $createdAt: document.$createdAt,
      $updatedAt: document.$updatedAt,
      assignee: document.assignee,
      invites: document.invites
    };

    await esClient.index({ index: ELASTIC_INDEX, id, document: body });
    await esClient.indices.refresh({ index: ELASTIC_INDEX }).catch(() => {});

    res.json({ ok: true, action: 'upserted', id });
  } catch (err) {
    console.error('Index error:', err);
    res.status(500).json({ ok: false, error: 'index_failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
