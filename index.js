import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Client } from '@elastic/elasticsearch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
    'http://localhost:5173',
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

// Cached mapping summary populated at startup (fields -> has keyword)
let mappingSummaryCache = {};

const INDICES = ['tasks', 'organizations', 'teams', 'orgmembers'];

// Helper: load mapping summary into mappingSummaryCache
const loadMappingSummary = async () => {
  try {
    const raw = await esClient.indices.getMapping({ index: INDICES }).catch((e) => ({ }));

    const hasKeywordSubfield = (mapping, path) => {
      if (!mapping) return false;
      const parts = path.split('.');
      let cur = mapping;
      if (cur.mappings && cur.mappings.properties) cur = cur.mappings.properties;
      for (const part of parts) {
        if (!cur) return false;
        const next = cur[part];
        if (!next) return false;
        if (next.properties) {
          cur = next.properties;
          continue;
        }
        cur = next;
      }
      if (!cur) return false;
      if (cur.type === 'keyword') return true;
      if (cur.fields && cur.fields.keyword) return true;
      return false;
    };

    const fieldsToCheck = ['userEmail', 'email', 'members.email', 'name', 'title', 'description'];
    const summary = {};
    for (const idx of INDICES) {
      const mapping = raw[idx] || raw?.[idx] || raw;
      summary[idx] = {};
      for (const f of fieldsToCheck) {
        summary[idx][f] = hasKeywordSubfield(mapping, f);
      }
    }

    mappingSummaryCache = summary;
    console.log('Loaded mapping summary:', JSON.stringify(mappingSummaryCache, null, 2));
    return mappingSummaryCache;
  } catch (err) {
    console.error('Failed to load mapping summary:', err);
    return {};
  }
};

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

    // Build an Elasticsearch body-based query. Use multi_match with bool_prefix
    // to support prefix searching and use the keyword subfield for exact userEmail match.
    const size = Math.min(Number(limit) || 10, 50);

    // Search across all indices: tasks, organizations, teams, orgmembers
    const indices = ['tasks', 'organizations', 'teams', 'orgmembers'];

    const fieldsToSearch = [
      'title^3',
      'description^2',
      'category',
      'assignee',
      'invites',
      'name^3',
      'slug',
      'members.name',
      'members.email',
      'teams.name',
      'email'
    ];

    // Build a filter that restricts results to items the user can see.
    // Use mappingSummaryCache to decide whether to use .keyword term filters
    // or fallback to match. If a mapping doesn't indicate a field, we'll
    // fall back to a match or allow the index through (less strict).

    // Ensure mappingSummaryCache is loaded (lazy load)
    if (!mappingSummaryCache || Object.keys(mappingSummaryCache).length === 0) {
      await loadMappingSummary().catch(() => {});
    }

    const m = mappingSummaryCache || {};

    const termOrMatch = (fieldBase, idx, fallbackField) => {
      const hasKeyword = m[idx] && m[idx][fieldBase];
      if (hasKeyword) return { term: { [`${fallbackField || fieldBase}.keyword`]: userEmail } };
      return { match: { [fallbackField || fieldBase]: userEmail } };
    };

    const userFilters = {
      bool: {
        should: [
          // tasks
          {
            bool: {
              must: [
                { term: { docType: 'tasks' } },
                termOrMatch('userEmail', 'tasks', 'userEmail')
              ]
            }
          },
          // organizations (check members.email)
          {
            bool: {
              must: [
                { term: { docType: 'organizations' } },
                termOrMatch('members.email', 'organizations', 'members.email')
              ]
            }
          },
          // orgmembers
          {
            bool: {
              must: [
                { term: { docType: 'orgmembers' } },
                termOrMatch('email', 'orgmembers', 'email')
              ]
            }
          },
          // include teams (no reliable email-based filter)
          { term: { docType: 'teams' } }
        ],
        minimum_should_match: 1
      }
    };

    const esQuery = {
      index: indices,
      body: {
        size,
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: String(query),
                  type: 'bool_prefix',
                  fields: fieldsToSearch,
                  operator: 'and'
                }
              }
            ],
            filter: [userFilters]
          }
        },
        _source: ['docType', 'title', 'description', 'category', 'status', 'priority', 'dueDate', 'userEmail', '$createdAt', '$updatedAt', 'name', 'slug', 'members', 'teams', 'email']
      }
    };

    // Debug logging to help diagnose empty results
    console.debug('ES search body:', JSON.stringify(esQuery.body, null, 2));

    const result = await esClient.search(esQuery);
    const hits = result.hits?.hits || [];
    console.debug('ES hits count:', hits.length);
    const items = hits.map((h) => ({
      $id: h._id,
      _index: h._index,
      _score: h._score,
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

    // Delete operation: try to delete from all known indices to be safe
    if (event && String(event).includes('delete')) {
      const indicesToTry = ['tasks', 'organizations', 'teams', 'orgmembers'];
      await Promise.all(indicesToTry.map((idx) => esClient.delete({ index: idx, id }).catch(() => {})));
      return res.json({ ok: true, action: 'deleted', id });
    }

    // Detect document type (task, organization, team, orgMember)
    const detectDocType = (doc) => {
      // Explicit overrides (body fields or headers)
      const explicit = req.body.docType || req.body.type || req.body.collection || req.body?.payload?.collection || req.body?.table || req.headers['x-doc-type'] || req.headers['x-collection'];
      if (typeof explicit === 'string') {
        const low = explicit.toLowerCase();
        if (low.includes('task')) return 'tasks';
        if (low.includes('org') && low.includes('member')) return 'orgmembers';
        if (low.includes('org') || low.includes('organization')) return 'organizations';
        if (low.includes('team')) return 'teams';
      }

      // Heuristics (check specific types before generic task detection)
      // orgmember: looks like { email, role }
      if (doc.email || doc.role) return 'orgmembers';

      // organizations: slug or members array of objects or teams array
      if (doc.slug || (Array.isArray(doc.teams) && doc.teams.length) || (Array.isArray(doc.members) && doc.members.length && typeof doc.members[0] === 'object')) return 'organizations';

      // teams: name + members array of strings
      if (doc.name && Array.isArray(doc.members) && doc.members.length && doc.members.every((m) => typeof m === 'string')) return 'teams';

      // tasks: title/description/status/userEmail
      if (doc.title || doc.userEmail || doc.description || doc.status) return 'tasks';

      // default to tasks
      return 'tasks';
    };

    const docType = detectDocType(document);

    // Build index document body depending on docType
    let body;
    if (docType === 'tasks') {
      body = {
        docType,
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
    } else if (docType === 'organizations') {
      body = {
        docType,
        name: document.name,
        slug: document.slug,
        description: document.description,
        members: document.members, // array of OrgMember
        teams: document.teams, // array of Team
        createdAt: document.createdAt || document.$createdAt
      };
    } else if (docType === 'teams') {
      body = {
        docType,
        name: document.name,
        members: document.members // array of member $ids
      };
    } else if (docType === 'orgmembers') {
      body = {
        docType,
        name: document.name,
        email: document.email,
        role: document.role
      };
    } else {
      body = { docType, ...document };
    }

  const indexName = docType; // use index names: 'tasks', 'organizations', 'teams', 'orgmembers'

  console.debug('Indexing document', { id, docType, indexName, keys: Object.keys(document).slice(0, 10) });

  await esClient.index({ index: indexName, id, document: body });
    await esClient.indices.refresh({ index: indexName }).catch(() => {});

    res.json({ ok: true, action: 'upserted', id, index: indexName });
  } catch (err) {
    console.error('Index error:', err);
    res.status(500).json({ ok: false, error: 'index_failed' });
  }
});

// Mappings endpoint - return index mappings and a small keyword-subfield summary
app.get('/api/mappings', async (req, res) => {
  try {
    const { index, refresh } = req.query;
    const indices = index ? String(index).split(',').map((s) => s.trim()) : INDICES;

    if (refresh === 'true') {
      await loadMappingSummary().catch(() => {});
    }

    const raw = await esClient.indices.getMapping({ index: indices }).catch((e) => {
      console.error('getMapping error:', e?.message || e);
      return {};
    });

    res.json({ ok: true, indices: indices, mappings: raw, summary: mappingSummaryCache });
  } catch (err) {
    console.error('Mapping endpoint error:', err);
    res.status(500).json({ ok: false, error: 'mapping_failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});

// Load mapping summary at startup
loadMappingSummary().catch(() => {});
