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
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
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

// Indices we maintain
const INDICES = ['tasks', 'organizations'];

// Cached mapping summary
let mappingSummaryCache = {};

const loadMappingSummary = async () => {
  try {
    const raw = await esClient.indices.getMapping({ index: INDICES }).catch(() => ({}));
    const hasKeywordSubfield = (mapping, path) => {
      if (!mapping) return false;
      const parts = path.split('.');
      let cur = mapping;
      if (cur.mappings && cur.mappings.properties) cur = cur.mappings.properties;
      for (const part of parts) {
        if (!cur) return false;
        const next = cur[part];
        if (!next) return false;
        if (next.properties) { cur = next.properties; continue; }
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
      for (const f of fieldsToCheck) summary[idx][f] = hasKeywordSubfield(mapping, f);
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
app.post('/api/index', async (req, res) => {
  // Deprecated: prefer using /api/index/task or /api/index/organization
  res.status(400).json({ ok: false, error: 'use /api/index/task or /api/index/organization' });
});

// Task-specific indexing endpoint
app.post('/api/index/task', async (req, res) => {
  try {
    const headerEvent = req.headers['x-appwrite-event'] || req.headers['x-appwrite-webhook-event'];
    const bodyEvent = req.body?.event || req.body?.events || req.body?.type;
    const event = (Array.isArray(bodyEvent) ? bodyEvent[0] : bodyEvent) || headerEvent || '';

    const document = req.body?.document || req.body?.payload?.document || req.body?.payload || (req.body?.$id ? req.body : undefined);
    if (!document?.$id) return res.status(400).json({ ok: false, error: 'missing_document' });
    const id = document.$id;

    if (event && String(event).includes('delete')) {
      await esClient.delete({ index: 'tasks', id }).catch(() => {});
      return res.json({ ok: true, action: 'deleted', id });
    }

    const body = {
      docType: 'tasks',
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

    console.debug('Indexing task', { id, keys: Object.keys(document).slice(0, 10) });
    await esClient.index({ index: 'tasks', id, document: body });
    await esClient.indices.refresh({ index: 'tasks' }).catch(() => {});
    res.json({ ok: true, action: 'upserted', id, index: 'tasks' });
  } catch (err) {
    console.error('Task index error:', err);
    res.status(500).json({ ok: false, error: 'index_failed' });
  }
});

// Organization-specific indexing endpoint (teams and members are nested inside organization)
app.post('/api/index/organization', async (req, res) => {
  try {
    const headerEvent = req.headers['x-appwrite-event'] || req.headers['x-appwrite-webhook-event'];
    const bodyEvent = req.body?.event || req.body?.events || req.body?.type;
    const event = (Array.isArray(bodyEvent) ? bodyEvent[0] : bodyEvent) || headerEvent || '';

    const document = req.body?.document || req.body?.payload?.document || req.body?.payload || (req.body?.$id ? req.body : undefined);
    if (!document) return res.status(400).json({ ok: false, error: 'missing_document' });

    // deletion: if organization id provided
    const id = document.$id || document.organizationId || document.orgId;
    if (event && String(event).includes('delete') && id) {
      await esClient.delete({ index: 'organizations', id }).catch(() => {});
      return res.json({ ok: true, action: 'deleted', id });
    }

    // If full organization provided (has members or teams or name/slug), upsert it
    if (document.$id && (document.members || document.teams || document.name)) {
      const body = {
        docType: 'organizations',
        name: document.name,
        slug: document.slug,
        description: document.description,
        members: document.members || [],
        teams: document.teams || [],
        createdAt: document.createdAt || document.$createdAt
      };

      console.debug('Indexing organization', { id: document.$id, keys: Object.keys(document).slice(0, 10) });
      await esClient.index({ index: 'organizations', id: document.$id, document: body });
      await esClient.indices.refresh({ index: 'organizations' }).catch(() => {});
      return res.json({ ok: true, action: 'upserted', id: document.$id, index: 'organizations' });
    }

    // If payload is a team or member, require parent org id to merge
    const parentOrgId = document.organizationId || document.orgId || (document.org && document.org.$id) || document.parentOrgId;
    if (!parentOrgId) {
      return res.status(400).json({ ok: false, error: 'missing_parent_org_id' });
    }

    const existing = await esClient.get({ index: 'organizations', id: parentOrgId }).catch(() => null);
    let orgDoc = existing && existing._source ? existing._source : { docType: 'organizations', members: [], teams: [], name: '', slug: '', description: '' };

    // merge member
    if (document.email || document.role) {
      const member = { $id: document.$id || (`mem_${Date.now()}`), name: document.name, email: document.email, role: document.role };
      orgDoc.members = orgDoc.members || [];
      const existsIdx = orgDoc.members.findIndex((m) => m && m.$id === member.$id);
      if (existsIdx >= 0) orgDoc.members[existsIdx] = { ...orgDoc.members[existsIdx], ...member };
      else orgDoc.members.push(member);
    }

    // merge team
    if (document.name && Array.isArray(document.members)) {
      const team = { $id: document.$id || (`team_${Date.now()}`), name: document.name, members: document.members || [] };
      orgDoc.teams = orgDoc.teams || [];
      const existsIdx = orgDoc.teams.findIndex((t) => t && t.$id === team.$id);
      if (existsIdx >= 0) orgDoc.teams[existsIdx] = { ...orgDoc.teams[existsIdx], ...team };
      else orgDoc.teams.push(team);
    }

    orgDoc.docType = 'organizations';
    console.debug('Merging into organization', { targetOrgId: parentOrgId });
    await esClient.index({ index: 'organizations', id: parentOrgId, document: orgDoc });
    await esClient.indices.refresh({ index: 'organizations' }).catch(() => {});
    return res.json({ ok: true, action: 'merged_into_organization', id: parentOrgId });
  } catch (err) {
    console.error('Organization index error:', err);
    res.status(500).json({ ok: false, error: 'index_failed' });
  }
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

    const size = Math.min(Number(limit) || 10, 50);
    const indices = INDICES;

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

    // Build visibility filters per-index (don't rely on docType field since older
    // documents might not have it). Use _index to scope the visibility filter.
    const userFilters = {
      bool: {
        should: [
          // tasks: require matching userEmail in tasks index
          {
            bool: {
              must: [
                { term: { _index: 'tasks' } },
                termOrMatch('userEmail', 'tasks', 'userEmail')
              ]
            }
          },
          // organizations: require member email in organizations index
          {
            bool: {
              must: [
                { term: { _index: 'organizations' } },
                termOrMatch('members.email', 'organizations', 'members.email')
              ]
            }
          }
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
                  operator: 'or'
                }
              }
            ],
            filter: [userFilters]
          }
        },
        _source: ['docType', 'title', 'description', 'category', 'status', 'priority', 'dueDate', 'userEmail', '$createdAt', '$updatedAt', 'name', 'slug', 'members', 'teams', 'email']
      }
    };

    console.debug('ES search body:', JSON.stringify(esQuery.body, null, 2));

    const result = await esClient.search(esQuery);
    const hits = result.hits?.hits || [];
    console.debug('ES hits count:', hits.length, 'took(ms):', result.took);

    // If debug flag requested, also run an unfiltered search to show what the
    // text query returns without the userEmail visibility filter. This helps
    // diagnose whether the userEmail filter is excluding matching docs.
    const debug = req.body?.debug === true || req.query?.debug === 'true';
    let unfiltered = null;
    if (debug) {
      const unfilteredQuery = { ...esQuery };
      // remove filters
      if (unfilteredQuery.body && unfilteredQuery.body.query && unfilteredQuery.body.query.bool) {
        unfilteredQuery.body.query.bool.filter = [];
      }
      console.debug('ES unfiltered search body:', JSON.stringify(unfilteredQuery.body, null, 2));
      const r2 = await esClient.search(unfilteredQuery);
      const hits2 = r2.hits?.hits || [];
      unfiltered = {
        took: r2.took,
        total: r2.hits?.total || null,
        count: hits2.length,
        sample: hits2.slice(0, 5).map((h) => ({ $id: h._id, _index: h._index, _score: h._score, ...(h._source || {}) }))
      };
    }

    const items = hits.map((h) => ({
      $id: h._id,
      _index: h._index,
      _score: h._score,
      ...(h._source || {})
    }));

    const resp = { results: items };
    if (debug) resp.debug = { filtered: { took: result.took, total: result.hits?.total || null, count: items.length }, unfiltered };
    res.json(resp);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ results: [], error: 'search_failed' });
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
