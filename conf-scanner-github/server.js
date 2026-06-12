require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const { TableClient, AzureNamedKeyCredential, odata } = require('@azure/data-tables');

const app = express();
const PORT = process.env.PORT || 3000;

const PCO_APP_ID = process.env.PCO_APP_ID;
const PCO_SECRET = process.env.PCO_SECRET;
const PCO_FORM_ID = process.env.PCO_FORM_ID && process.env.PCO_FORM_ID.trim() ? process.env.PCO_FORM_ID.trim() : null;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || 'changeme-use-a-long-random-string-in-production';

// Trust Azure's proxy (required for rate limiting and correct IP detection)
app.set('trust proxy', 1);

app.use(express.json());

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
    httpOnly: true,
    sameSite: 'lax',
  },
}));

// Serve public folder (login page is at /login.html, served statically)
// Root → guide homepage
app.get('/', (req, res) => {
  res.redirect('/guide.html');
});

// /scanner → badge scanner app
app.get('/scanner', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Active session tracking ───────────────────────────────────────────────────
const activeSessions = new Map();

function trackSession(req) {
  const sid = req.sessionID;
  if (!sid) return;
  const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
  const existing = activeSessions.get(sid) || {};
  activeSessions.set(sid, {
    name: req.session?.recorderName || existing.name || 'Unknown',
    phone: req.session?.recorderPhone || existing.phone || '',
    ip,
    userAgent: req.headers['user-agent'] || '',
    lastSeen: new Date().toISOString(),
    loginAt: existing.loginAt || new Date().toISOString(),
  });
}

// Prune sessions older than 13 hours every 30 min
setInterval(() => {
  const cutoff = Date.now() - 13 * 60 * 60 * 1000;
  for (const [sid, data] of activeSessions.entries()) {
    if (new Date(data.lastSeen).getTime() < cutoff) activeSessions.delete(sid);
  }
}, 30 * 60 * 1000);

// Auth middleware — protects all /api/* routes
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    trackSession(req);
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Rate limiter — max 10 login attempts per IP per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    console.warn(`Rate limit hit from IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many login attempts. Try again in 15 minutes.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /auth/login
app.post('/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    req.session.authenticated = true;
    const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
    activeSessions.set(req.sessionID, {
      name: 'Unknown',
      phone: '',
      ip,
      userAgent: req.headers['user-agent'] || '',
      lastSeen: new Date().toISOString(),
      loginAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  activeSessions.delete(req.sessionID);
  req.session.destroy();
  res.json({ ok: true });
});

// GET /auth/status
app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

function pcoAuth() {
  const token = Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

async function pcoGet(url) {
  const res = await fetch(url, {
    headers: { Authorization: pcoAuth(), 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PCO API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function pcoPatch(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: pcoAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PCO API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function pcoPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: pcoAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PCO API error ${res.status}: ${text}`);
  }
  return res.json();
}

// GET /api/config — expose locked form ID to front-end
app.get('/api/config', (req, res) => {
  res.json({ locked_form_id: PCO_FORM_ID });
});

// GET /api/forms — list all PCO People forms
app.get('/api/forms', requireAuth, async (req, res) => {
  try {
    const data = await pcoGet('https://api.planningcenteronline.com/people/v2/forms?per_page=100');
    const forms = data.data.map(f => ({
      id: f.id,
      name: f.attributes.name,
      description: f.attributes.description,
      active: f.attributes.active,
      submission_count: f.attributes.submission_count,
    }));
    res.json({ forms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/forms/:formId/fields — get field definitions for a form
app.get('/api/forms/:formId/fields', requireAuth, async (req, res) => {
  try {
    const { formId } = req.params;
    const data = await pcoGet(
      `https://api.planningcenteronline.com/people/v2/forms/${formId}/fields?per_page=100`
    );
    const fields = data.data.map(f => ({
      id: f.id,
      label: f.attributes.label,
      field_type: f.attributes.field_type,
      required: f.attributes.required,
      sequence: f.attributes.sequence,
    }));
    res.json({ fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/forms/:formId/submissions — all submissions with person info
app.get('/api/forms/:formId/submissions', requireAuth, async (req, res) => {
  try {
    const { formId } = req.params;
    let allSubmissions = [];
    let url = `https://api.planningcenteronline.com/people/v2/forms/${formId}/form_submissions?per_page=100&include=person`;

    while (url) {
      const data = await pcoGet(url);
      const included = data.included || [];

      for (const sub of data.data) {
        const personId = sub.relationships?.person?.data?.id;
        const person = included.find(i => i.type === 'Person' && i.id === personId);
        allSubmissions.push({
          submission_id: sub.id,
          person_id: personId || null,
          created_at: sub.attributes.created_at,
          name: person
            ? `${person.attributes.first_name} ${person.attributes.last_name}`
            : 'Unknown',
          first_name: person?.attributes?.first_name || '',
          last_name: person?.attributes?.last_name || '',
          avatar: person?.attributes?.avatar || null,
        });
      }

      url = data.meta?.next ? data.links?.next : null;
    }

    res.json({ submissions: allSubmissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/submissions/:submissionId/responses — field responses for one submission
app.get('/api/submissions/:submissionId/responses', requireAuth, async (req, res) => {
  try {
    const { submissionId } = req.params;
    const data = await pcoGet(
      `https://api.planningcenteronline.com/people/v2/form_submissions/${submissionId}/form_submission_values?per_page=100&include=form_field`
    );
    const included = data.included || [];
    const responses = data.data.map(v => {
      const fieldId = v.relationships?.form_field?.data?.id;
      const field = included.find(i => i.type === 'FormField' && i.id === fieldId);
      return {
        id: v.id,
        label: field?.attributes?.label || 'Field',
        field_type: field?.attributes?.field_type || 'text',
        value: v.attributes.value || '',
      };
    }).filter(r => r.value);
    res.json({ responses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/people/search?q=name — search PCO people by name
app.get('/api/people/search', requireAuth, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.length < 2) return res.json({ people: [] });
    // PCO's correct search param — searches across name and email
    const data = await pcoGet(
      `https://api.planningcenteronline.com/people/v2/people?where[search_name_or_email]=${encodeURIComponent(q)}&per_page=10`
    );
    console.log(`PCO search "${q}": found ${data?.data?.length ?? 0} results`);
    if (!data || !Array.isArray(data.data)) return res.json({ people: [] });
    const people = data.data.map(p => ({
      id: p.id,
      name: `${p.attributes.first_name || ''} ${p.attributes.last_name || ''}`.trim(),
      first_name: p.attributes.first_name || '',
      last_name: p.attributes.last_name || '',
      avatar: p.attributes.avatar || null,
    }));
    res.json({ people });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/people/:personId — person details
app.get('/api/people/:personId', requireAuth, async (req, res) => {
  try {
    const { personId } = req.params;
    const data = await pcoGet(
      `https://api.planningcenteronline.com/people/v2/people/${personId}?include=emails,phone_numbers`
    );
    const p = data.data;
    const included = data.included || [];
    const emails = included.filter(i => i.type === 'Email').map(e => e.attributes.address);
    const phones = included.filter(i => i.type === 'PhoneNumber').map(ph => ph.attributes.number);
    res.json({
      id: p.id,
      first_name: p.attributes.first_name,
      last_name: p.attributes.last_name,
      avatar: p.attributes.avatar,
      emails,
      phones,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/people/:personId/notes
app.get('/api/people/:personId/notes', requireAuth, async (req, res) => {
  try {
    const { personId } = req.params;
    // Filter to conference category only if configured
    const categoryFilter = PCO_NOTE_CATEGORY_ID
      ? `&where[note_category_id]=${PCO_NOTE_CATEGORY_ID}`
      : '';
    const data = await pcoGet(
      `https://api.planningcenteronline.com/people/v2/people/${personId}/notes?per_page=100${categoryFilter}`
    );
    const notes = data.data.map(n => ({
      id: n.id,
      note: n.attributes.note,
      created_at: n.attributes.created_at,
    }));
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/people/:personId/notes
app.post('/api/people/:personId/notes', requireAuth, async (req, res) => {
  try {
    const { personId } = req.params;
    const { note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });
    const categoryId = await getNoteCategoryId();
    const body = {
      data: {
        type: 'Note',
        attributes: { note: note.trim() },
        relationships: {
          ...(categoryId && { note_category: { data: { type: 'NoteCategory', id: categoryId } } }),
        },
      },
    };
    const data = await pcoPost(
      `https://api.planningcenteronline.com/people/v2/people/${personId}/notes`,
      body
    );
    res.json({
      id: data.data.id,
      note: data.data.attributes.note,
      created_at: data.data.attributes.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST /api/people/register — create person in PCO + add form submission
app.post('/api/people/register', requireAuth, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, form_id, recorded_by } = req.body;
    if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name are required' });

    // 1. Create the person
    const personBody = {
      data: {
        type: 'Person',
        attributes: { first_name, last_name },
      },
    };
    const personData = await pcoPost(
      'https://api.planningcenteronline.com/people/v2/people',
      personBody
    );
    const personId = personData.data.id;

    // 2. Add email if provided
    if (email) {
      await pcoPost(
        `https://api.planningcenteronline.com/people/v2/people/${personId}/emails`,
        { data: { type: 'Email', attributes: { address: email, location: 'Home' } } }
      ).catch(() => {});
    }

    // 3. Add phone if provided
    if (phone) {
      await pcoPost(
        `https://api.planningcenteronline.com/people/v2/people/${personId}/phone_numbers`,
        { data: { type: 'PhoneNumber', attributes: { number: phone, location: 'Mobile' } } }
      ).catch(() => {});
    }

    // 4. Write creation note
    const categoryId = await getNoteCategoryId();
    const creatorTag = recorded_by ? `[${recorded_by}] ` : '';
    const creationNote = `${creatorTag}Walk-in registration — Jesus is Lord Freedom Crusade 2026`;
    await pcoPost(
      `https://api.planningcenteronline.com/people/v2/people/${personId}/notes`,
      {
        data: {
          type: 'Note',
          attributes: { note: creationNote },
          relationships: { ...(categoryId && { note_category: { data: { type: 'NoteCategory', id: categoryId } } }) }
        }
      }
    ).catch(() => {});

    // 5. Create a form submission linking person to form
    let submissionId = null;
    if (form_id) {
      try {
        const subBody = {
          data: {
            type: 'FormSubmission',
            relationships: {
              person: { data: { type: 'Person', id: personId } },
            },
          },
        };
        const subData = await pcoPost(
          `https://api.planningcenteronline.com/people/v2/forms/${form_id}/form_submissions`,
          subBody
        );
        submissionId = subData.data.id;
      } catch(e) {}
    }

    res.json({ person_id: personId, submission_id: submissionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Note category ID — set via PCO_NOTE_CATEGORY_ID env var
const PCO_BADGE_FIELD_ID = process.env.PCO_BADGE_FIELD_ID && process.env.PCO_BADGE_FIELD_ID.trim()
  ? process.env.PCO_BADGE_FIELD_ID.trim()
  : null;
const PCO_NOTE_CATEGORY_ID = process.env.PCO_NOTE_CATEGORY_ID && process.env.PCO_NOTE_CATEGORY_ID.trim()
  ? process.env.PCO_NOTE_CATEGORY_ID.trim()
  : null;

async function getNoteCategoryId() {
  return PCO_NOTE_CATEGORY_ID;
}

// ── Azure Table Storage ───────────────────────────────────────────────────────
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
let badgesTable = null;
let offlineTable = null;

async function initTables() {
  if (!STORAGE_CONN) {
    console.warn('AZURE_STORAGE_CONNECTION_STRING not set — using in-memory fallback');
    return;
  }
  try {
    badgesTable = TableClient.fromConnectionString(STORAGE_CONN, 'badges');
    offlineTable = TableClient.fromConnectionString(STORAGE_CONN, 'offline');
    await badgesTable.createTable();
    await offlineTable.createTable();
    console.log('✓ Azure Table Storage connected');
  } catch(e) {
    console.warn('Table Storage init error:', e.message);
  }
}

// In-memory fallback
let badgeMapFallback = {};

async function getBadgeMap() {
  if (!badgesTable) return badgeMapFallback;
  const map = {};
  try {
    for await (const entity of badgesTable.listEntities()) {
      map[entity.rowKey] = entity.personId;
    }
  } catch(e) { console.warn('getBadgeMap error:', e.message); }
  return map;
}

async function getBadge(badgeId) {
  if (!badgesTable) return badgeMapFallback[badgeId] || null;
  try {
    const entity = await badgesTable.getEntity('badge', badgeId);
    return entity.personId || null;
  } catch(e) { return null; }
}

async function setBadge(badgeId, personId) {
  if (!badgesTable) { badgeMapFallback[badgeId] = personId; return; }
  try {
    await badgesTable.upsertEntity({ partitionKey: 'badge', rowKey: badgeId, personId }, 'Replace');
  } catch(e) { console.warn('setBadge error:', e.message); }
}

async function getOfflineMap() {
  if (!offlineTable) return {};
  const map = {};
  try {
    for await (const entity of offlineTable.listEntities()) {
      map[entity.rowKey] = {
        badge_id: entity.rowKey,
        name: entity.name || '',
        phone: entity.phone || '',
        email: entity.email || '',
        milestones: JSON.parse(entity.milestones || '[]'),
        notes: JSON.parse(entity.notes || '[]'),
        captured_at: entity.captured_at || '',
        recorded_by: entity.recorded_by || '',
      };
    }
  } catch(e) { console.warn('getOfflineMap error:', e.message); }
  return map;
}

async function getOfflineCapture(badgeId) {
  if (!offlineTable) return null;
  try {
    const entity = await offlineTable.getEntity('offline', badgeId);
    return {
      badge_id: entity.rowKey,
      name: entity.name || '',
      phone: entity.phone || '',
      email: entity.email || '',
      milestones: JSON.parse(entity.milestones || '[]'),
      notes: JSON.parse(entity.notes || '[]'),
      captured_at: entity.captured_at || '',
      recorded_by: entity.recorded_by || '',
    };
  } catch(e) { return null; }
}

async function upsertOfflineCapture(badgeId, data) {
  if (!offlineTable) return;
  try {
    await offlineTable.upsertEntity({
      partitionKey: 'offline',
      rowKey: badgeId,
      name: data.name || '',
      phone: data.phone || '',
      email: data.email || '',
      milestones: JSON.stringify(data.milestones || []),
      notes: JSON.stringify(data.notes || []),
      captured_at: data.captured_at || new Date().toISOString(),
      recorded_by: data.recorded_by || '',
    }, 'Replace');
  } catch(e) { console.warn('upsertOffline error:', e.message); }
}

async function deleteOfflineCapture(badgeId) {
  if (!offlineTable) return;
  try { await offlineTable.deleteEntity('offline', badgeId); }
  catch(e) { console.warn('deleteOffline error:', e.message); }
}

// GET /api/badges — return full map
app.get('/api/badges', requireAuth, async (req, res) => {
  try {
    const badges = await getBadgeMap();
    res.json({ badges });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/badges/:badgeId — look up a badge
app.get('/api/badges/:badgeId', requireAuth, async (req, res) => {
  try {
    const personId = await getBadge(req.params.badgeId.toUpperCase());
    if (!personId) return res.json({ linked: false });
    res.json({ linked: true, person_id: personId });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/badges/assign — assign a badge ID to a person
app.post('/api/badges/assign', requireAuth, async (req, res) => {
  try {
    const { badge_id, person_id } = req.body;
    if (!badge_id || !person_id) return res.status(400).json({ error: 'badge_id and person_id required' });
    const bid = badge_id.toUpperCase().trim();

    // Enforce WI- prefix — FC badges cannot be manually assigned
    if (!bid.startsWith('WI-')) {
      return res.status(400).json({
        error: `Only WI- badges can be assigned here. FC badges are pre-assigned to registered attendees.`,
        code: 'WRONG_BADGE_TYPE',
      });
    }

    // Check if already assigned to someone else
    const existingPersonId = await getBadge(bid);
    if (existingPersonId && existingPersonId !== person_id) {
      // Look up their name from PCO for a friendly error
      let existingName = existingPersonId;
      try {
        const personData = await pcoGet(
          `https://api.planningcenteronline.com/people/v2/people/${existingPersonId}`
        );
        const attrs = personData?.data?.attributes;
        if (attrs) existingName = `${attrs.first_name || ''} ${attrs.last_name || ''}`.trim();
      } catch(e) {}
      return res.status(409).json({
        error: `Badge ${bid} is already assigned to ${existingName}. Please use a different WI badge.`,
        code: 'ALREADY_ASSIGNED',
        existing_person_id: existingPersonId,
        existing_person_name: existingName,
      });
    }

    await setBadge(bid, person_id);

    // Optionally write badge ID to PCO custom field
    if (PCO_BADGE_FIELD_ID) {
      try {
        await pcoPost(
          `https://api.planningcenteronline.com/people/v2/people/${person_id}/field_data`,
          { data: { type: 'FieldDatum', attributes: { value: bid },
            relationships: { field_definition: { data: { type: 'FieldDefinition', id: PCO_BADGE_FIELD_ID } } } } }
        );
      } catch(e) { console.warn('Could not write badge to PCO field:', e.message); }
    }
    res.json({ ok: true, badge_id: bid, person_id });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Offline captures ──────────────────────────────────────────────────────────

// GET /api/offline — all offline captures
app.get('/api/offline', requireAuth, async (req, res) => {
  try {
    const captures = await getOfflineMap();
    res.json({ captures });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/offline/:badgeId — save or update an offline capture
app.post('/api/offline/:badgeId', requireAuth, async (req, res) => {
  try {
    const bid = req.params.badgeId.toUpperCase();
    const { name, phone, email, milestone, note, recorded_by } = req.body;
    let capture = await getOfflineCapture(bid) || {
      badge_id: bid, name: '', phone: '', email: '',
      milestones: [], notes: [], captured_at: new Date().toISOString(), recorded_by: recorded_by || '',
    };
    if (name !== undefined) capture.name = name;
    if (phone !== undefined) capture.phone = phone;
    if (email !== undefined) capture.email = email;
    if (recorded_by !== undefined) capture.recorded_by = recorded_by;
    if (milestone && !capture.milestones.includes(milestone)) capture.milestones.push(milestone);
    if (note) capture.notes.push({ text: note, ts: new Date().toISOString() });
    await upsertOfflineCapture(bid, capture);
    res.json({ ok: true, capture });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/offline/:badgeId/sync — push offline capture to PCO
app.post('/api/offline/:badgeId/sync', requireAuth, async (req, res) => {
  const bid = req.params.badgeId.toUpperCase();
  const capture = await getOfflineCapture(bid);
  if (!capture) return res.status(404).json({ error: 'No offline capture found for ' + bid });

  try {
    const nameParts = (capture.name || 'Unknown').trim().split(' ');
    const first = nameParts[0] || 'Unknown';
    const last = nameParts.slice(1).join(' ') || '(Walk-in)';

    const personData = await pcoPost('https://api.planningcenteronline.com/people/v2/people', {
      data: { type: 'Person', attributes: { first_name: first, last_name: last } }
    });
    const personId = personData.data.id;

    const syncCategoryId = await getNoteCategoryId();
    const syncCreatorTag = capture.recorded_by ? `[${capture.recorded_by}] ` : '';
    const syncNote = `${syncCreatorTag}Walk-in registration (offline capture) — Jesus is Lord Freedom Crusade 2026`;
    await pcoPost(`https://api.planningcenteronline.com/people/v2/people/${personId}/notes`, {
      data: { type: 'Note', attributes: { note: syncNote },
        relationships: { ...(syncCategoryId && { note_category: { data: { type: 'NoteCategory', id: syncCategoryId } } }) } }
    }).catch(() => {});

    if (capture.email) {
      await pcoPost(`https://api.planningcenteronline.com/people/v2/people/${personId}/emails`, {
        data: { type: 'Email', attributes: { address: capture.email, location: 'Home' } }
      }).catch(() => {});
    }
    if (capture.phone) {
      await pcoPost(`https://api.planningcenteronline.com/people/v2/people/${personId}/phone_numbers`, {
        data: { type: 'PhoneNumber', attributes: { number: capture.phone, location: 'Mobile' } }
      }).catch(() => {});
    }

    const categoryId = await getNoteCategoryId();
    const milestoneLabels = { baptized: 'Baptized in Jesus Name', holyghost: 'Filled with the Holy Ghost', biblestudy: 'Requested Bible Study' };
    const milestoneTags = { baptized: '[MILESTONE:BAPTIZED]', holyghost: '[MILESTONE:HOLYGHOST]', biblestudy: '[MILESTONE:BIBLESTUDY]' };

    for (const m of (capture.milestones || [])) {
      await pcoPost(`https://api.planningcenteronline.com/people/v2/people/${personId}/notes`, {
        data: { type: 'Note', attributes: { note: `${milestoneTags[m]} ${capture.name || bid} — ${milestoneLabels[m]} (captured offline)` },
          relationships: { ...(categoryId && { note_category: { data: { type: 'NoteCategory', id: categoryId } } }) } }
      }).catch(() => {});
    }
    for (const n of (capture.notes || [])) {
      await pcoPost(`https://api.planningcenteronline.com/people/v2/people/${personId}/notes`, {
        data: { type: 'Note', attributes: { note: n.text },
          relationships: { ...(categoryId && { note_category: { data: { type: 'NoteCategory', id: categoryId } } }) } }
      }).catch(() => {});
    }

    await setBadge(bid, personId);
    await deleteOfflineCapture(bid);
    res.json({ ok: true, person_id: personId });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Follow-up system ─────────────────────────────────────────────────────────
let followupsTable = null;
let contactlogTable = null;
let auditlogTable = null;
let volunteersTable = null;

async function initFollowupTables() {
  if (!STORAGE_CONN) return;
  try {
    followupsTable  = TableClient.fromConnectionString(STORAGE_CONN, 'followups');
    contactlogTable = TableClient.fromConnectionString(STORAGE_CONN, 'contactlog');
    auditlogTable   = TableClient.fromConnectionString(STORAGE_CONN, 'auditlog');
    volunteersTable = TableClient.fromConnectionString(STORAGE_CONN, 'volunteers');
    await Promise.all([
      followupsTable.createTable(),
      contactlogTable.createTable(),
      auditlogTable.createTable(),
      volunteersTable.createTable(),
    ]);
    console.log('✓ Follow-up tables ready');
  } catch(e) {
    console.warn('Follow-up table init error:', e.message);
  }
}

async function writeAudit(action, entity_type, entity_id, changed_by, before, after) {
  if (!auditlogTable) return;
  try {
    const ts = Date.now();
    await auditlogTable.createEntity({
      partitionKey: entity_type,
      rowKey: `${ts}-${Math.random().toString(36).slice(2,8)}`,
      action,
      entity_id,
      changed_by: changed_by || 'unknown',
      before: JSON.stringify(before || {}),
      after: JSON.stringify(after || {}),
      timestamp: new Date().toISOString(),
    });
  } catch(e) { console.warn('writeAudit error:', e.message); }
}

// GET /api/volunteers
app.get('/api/volunteers', requireAuth, async (req, res) => {
  try {
    const list = [];
    if (volunteersTable) {
      for await (const e of volunteersTable.listEntities()) {
        list.push({ id: e.rowKey, name: e.name, phone: e.phone || '', email: e.email || '' });
      }
    }
    list.sort((a,b) => a.name.localeCompare(b.name));
    res.json({ volunteers: list });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/volunteers
app.post('/api/volunteers', requireAuth, async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const id = name.trim().toLowerCase().replace(/\s+/g,'-') + '-' + Date.now();
    if (volunteersTable) {
      await volunteersTable.createEntity({
        partitionKey: 'volunteer', rowKey: id,
        name: name.trim(), phone: phone||'', email: email||'',
      });
    }
    res.json({ ok: true, id, name: name.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/volunteers/:id
app.delete('/api/volunteers/:id', requireAuth, async (req, res) => {
  try {
    if (volunteersTable) await volunteersTable.deleteEntity('volunteer', req.params.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/followups — all follow-up records
app.get('/api/followups', requireAuth, async (req, res) => {
  try {
    const list = [];
    if (followupsTable) {
      for await (const e of followupsTable.listEntities()) {
        list.push({
          id: e.rowKey,
          person_id: e.person_id,
          name: e.name,
          phone: e.phone || '',
          email: e.email || '',
          family: JSON.parse(e.family || '[]'),
          milestones: JSON.parse(e.milestones || '[]'),
          assigned_to: e.assigned_to || '',
          assigned_to_id: e.assigned_to_id || '',
          campus_id: e.campus_id || '',
          campus_name: e.campus_name || '',
          status: e.status || 'unassigned',
          created_at: e.created_at,
          updated_at: e.updated_at,
          notes: e.notes || '',
        });
      }
    }
    res.json({ followups: list });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/followups — create or update a follow-up record
app.post('/api/followups', requireAuth, async (req, res) => {
  try {
    const { person_id, name, phone, email, family, milestones, changed_by } = req.body;
    if (!person_id) return res.status(400).json({ error: 'person_id required' });

    // Check if exists
    let existing = null;
    if (followupsTable) {
      try { existing = await followupsTable.getEntity('followup', person_id); } catch(e) {}
    }

    const now = new Date().toISOString();
    const entity = {
      partitionKey: 'followup',
      rowKey: person_id,
      person_id,
      name: name || '',
      phone: phone || '',
      email: email || '',
      family: JSON.stringify(family || []),
      milestones: JSON.stringify(milestones || []),
      status: existing?.status || 'unassigned',
      assigned_to: existing?.assigned_to || '',
      assigned_to_id: existing?.assigned_to_id || '',
      campus_id: req.body.campus_id || existing?.campus_id || '',
      campus_name: req.body.campus_name || existing?.campus_name || '',
      notes: existing?.notes || '',
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    if (followupsTable) await followupsTable.upsertEntity(entity, 'Replace');

    await writeAudit(
      existing ? 'followup_updated' : 'followup_created',
      'followup', person_id, changed_by,
      existing ? { status: existing.status } : null,
      { name: entity.name, milestones: entity.milestones }
    );

    res.json({ ok: true, id: person_id });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/followups/:personId/assign
app.patch('/api/followups/:personId/assign', requireAuth, async (req, res) => {
  try {
    const { volunteer_id, volunteer_name, changed_by } = req.body;
    const pid = req.params.personId;

    let existing = null;
    if (followupsTable) {
      try { existing = await followupsTable.getEntity('followup', pid); } catch(e) {}
    }
    if (!existing) return res.status(404).json({ error: 'Follow-up record not found' });

    const before = { assigned_to: existing.assigned_to, status: existing.status };
    existing.assigned_to = volunteer_name || '';
    existing.assigned_to_id = volunteer_id || '';
    existing.status = volunteer_id ? 'assigned' : 'unassigned';
    existing.updated_at = new Date().toISOString();

    if (followupsTable) await followupsTable.upsertEntity(existing, 'Replace');
    await writeAudit('assignment_changed', 'followup', pid, changed_by, before,
      { assigned_to: existing.assigned_to, status: existing.status });

    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/followups/:personId/status
app.patch('/api/followups/:personId/status', requireAuth, async (req, res) => {
  try {
    const { status, changed_by } = req.body;
    const pid = req.params.personId;
    const valid = ['unassigned','assigned','in_progress','completed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    let existing = null;
    if (followupsTable) {
      try { existing = await followupsTable.getEntity('followup', pid); } catch(e) {}
    }
    if (!existing) return res.status(404).json({ error: 'Record not found' });

    const before = { status: existing.status };
    existing.status = status;
    existing.updated_at = new Date().toISOString();

    if (followupsTable) await followupsTable.upsertEntity(existing, 'Replace');
    await writeAudit('status_changed', 'followup', pid, changed_by, before, { status });

    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/followups/:personId/contact — log a contact attempt
app.post('/api/followups/:personId/contact', requireAuth, async (req, res) => {
  try {
    const { method, outcome, note, logged_by } = req.body;
    const pid = req.params.personId;
    const ts = Date.now();
    const rowKey = `${pid}-${ts}`;
    const now = new Date().toISOString();

    if (contactlogTable) {
      await contactlogTable.createEntity({
        partitionKey: pid,
        rowKey,
        person_id: pid,
        method: method || 'call',
        outcome: outcome || '',
        note: note || '',
        logged_by: logged_by || '',
        timestamp: now,
      });
    }

    // Update follow-up status to in_progress if still assigned
    if (followupsTable) {
      try {
        const existing = await followupsTable.getEntity('followup', pid);
        if (existing.status === 'assigned') {
          existing.status = 'in_progress';
          existing.updated_at = now;
          await followupsTable.upsertEntity(existing, 'Replace');
        }
      } catch(e) {}
    }

    await writeAudit('contact_logged', 'followup', pid, logged_by, null,
      { method, outcome, note });

    res.json({ ok: true, rowKey });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/followups/:personId/contacts — get contact history
app.get('/api/followups/:personId/contacts', requireAuth, async (req, res) => {
  try {
    const pid = req.params.personId;
    const logs = [];
    if (contactlogTable) {
      for await (const e of contactlogTable.listEntities({ queryOptions: { filter: `PartitionKey eq '${pid}'` } })) {
        logs.push({
          id: e.rowKey,
          method: e.method,
          outcome: e.outcome,
          note: e.note,
          logged_by: e.logged_by,
          timestamp: e.timestamp,
        });
      }
    }
    logs.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
    res.json({ contacts: logs });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/audit — recent audit log entries
app.get('/api/audit', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = [];
    if (auditlogTable) {
      for await (const e of auditlogTable.listEntities()) {
        logs.push({
          id: e.rowKey,
          action: e.action,
          entity_type: e.partitionKey,
          entity_id: e.entity_id,
          changed_by: e.changed_by,
          before: e.before,
          after: e.after,
          timestamp: e.timestamp,
        });
      }
    }
    logs.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
    res.json({ logs: logs.slice(0, limit) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/people/:personId/contact — update phone and email in PCO
app.post('/api/people/:personId/contact', requireAuth, async (req, res) => {
  try {
    const { personId } = req.params;
    const { phone, email } = req.body;

    // Get existing emails and phones to avoid duplicates
    const existing = await pcoGet(
      `https://api.planningcenteronline.com/people/v2/people/${personId}?include=emails,phone_numbers`
    );
    const included = existing.included || [];
    const existingEmails = included.filter(i => i.type === 'Email');
    const existingPhones = included.filter(i => i.type === 'PhoneNumber');

    // Update or create phone
    if (phone) {
      if (existingPhones.length > 0) {
        // Update the first phone
        await pcoPatch(
          `https://api.planningcenteronline.com/people/v2/people/${personId}/phone_numbers/${existingPhones[0].id}`,
          { data: { type: 'PhoneNumber', attributes: { number: phone, location: 'Mobile' } } }
        ).catch(async () => {
          // If PATCH fails, create new
          await pcoPost(
            `https://api.planningcenteronline.com/people/v2/people/${personId}/phone_numbers`,
            { data: { type: 'PhoneNumber', attributes: { number: phone, location: 'Mobile' } } }
          );
        });
      } else {
        await pcoPost(
          `https://api.planningcenteronline.com/people/v2/people/${personId}/phone_numbers`,
          { data: { type: 'PhoneNumber', attributes: { number: phone, location: 'Mobile' } } }
        );
      }
    }

    // Update or create email
    if (email) {
      if (existingEmails.length > 0) {
        await pcoPatch(
          `https://api.planningcenteronline.com/people/v2/people/${personId}/emails/${existingEmails[0].id}`,
          { data: { type: 'Email', attributes: { address: email, location: 'Home' } } }
        ).catch(async () => {
          await pcoPost(
            `https://api.planningcenteronline.com/people/v2/people/${personId}/emails`,
            { data: { type: 'Email', attributes: { address: email, location: 'Home' } } }
          );
        });
      } else {
        await pcoPost(
          `https://api.planningcenteronline.com/people/v2/people/${personId}/emails`,
          { data: { type: 'Email', attributes: { address: email, location: 'Home' } } }
        );
      }
    }

    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campuses — pull campus list from PCO
app.get('/api/campuses', requireAuth, async (req, res) => {
  try {
    const data = await pcoGet('https://api.planningcenteronline.com/people/v2/campuses?per_page=25');
    const campuses = (data.data || []).map(c => ({
      id: c.id,
      name: c.attributes.name,
    })).sort((a,b) => a.name.localeCompare(b.name));
    res.json({ campuses });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/people/:personId/campus — assign campus in PCO
app.patch('/api/people/:personId/campus', requireAuth, async (req, res) => {
  try {
    const { personId } = req.params;
    const { campus_id } = req.body;
    if (!campus_id) return res.status(400).json({ error: 'campus_id required' });

    await pcoPatch(
      `https://api.planningcenteronline.com/people/v2/people/${personId}`,
      {
        data: {
          type: 'Person',
          id: personId,
          relationships: {
            primary_campus: {
              data: { type: 'Campus', id: campus_id }
            }
          }
        }
      }
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/people/:personId/family — get household members from PCO
app.get('/api/people/:personId/family', requireAuth, async (req, res) => {
  try {
    const { personId } = req.params;
    const data = await pcoGet(
      `https://api.planningcenteronline.com/people/v2/people/${personId}/household_memberships?include=person&per_page=20`
    );
    const included = data.included || [];
    const members = included
      .filter(i => i.type === 'Person' && i.id !== personId)
      .map(p => ({
        id: p.id,
        name: `${p.attributes.first_name||''} ${p.attributes.last_name||''}`.trim(),
        avatar: p.attributes.avatar || null,
      }));
    res.json({ family: members });
  } catch(err) { res.json({ family: [] }); }
});

// POST /auth/set-name — store recorder name in server session for tracking
app.post('/auth/set-name', requireAuth, (req, res) => {
  const { name, phone } = req.body;
  if (name) {
    req.session.recorderName = name;
    req.session.recorderPhone = phone || '';
    const existing = activeSessions.get(req.sessionID);
    if (existing) {
      existing.name = name;
      existing.phone = phone || '';
      activeSessions.set(req.sessionID, existing);
    }
  }
  res.json({ ok: true });
});

// Health check — basic (public, used by front-end auth check)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, pco_configured: !!(PCO_APP_ID && PCO_SECRET), locked_form_id: PCO_FORM_ID });
});

// Status page — detailed diagnostic (auth required)
app.get('/api/status', requireAuth, async (req, res) => {
  const status = {
    app: {
      ok: true,
      version: process.env.npm_package_version || '1.0.0',
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
      timestamp: new Date().toISOString(),
    },
    pco: {
      configured: !!(PCO_APP_ID && PCO_SECRET),
      form_id: PCO_FORM_ID || null,
      note_category_id: PCO_NOTE_CATEGORY_ID || null,
      ok: false,
      last_check: null,
      error: null,
    },
    storage: {
      configured: !!(STORAGE_CONN),
      ok: false,
      last_check: null,
      badge_count: null,
      offline_count: null,
      error: null,
    },
  };

  // Test PCO connection
  try {
    const start = Date.now();
    await pcoGet('https://api.planningcenteronline.com/people/v2');
    status.pco.ok = true;
    status.pco.last_check = new Date().toISOString();
    status.pco.response_ms = Date.now() - start;
  } catch(e) {
    status.pco.ok = false;
    status.pco.error = e.message;
    status.pco.last_check = new Date().toISOString();
  }

  // Test Azure Table Storage
  if (badgesTable) {
    try {
      const start = Date.now();
      let badgeCount = 0;
      for await (const _ of badgesTable.listEntities()) badgeCount++;
      let offlineCount = 0;
      if (offlineTable) {
        for await (const _ of offlineTable.listEntities()) offlineCount++;
      }
      status.storage.ok = true;
      status.storage.last_check = new Date().toISOString();
      status.storage.badge_count = badgeCount;
      status.storage.offline_count = offlineCount;
      status.storage.response_ms = Date.now() - start;
    } catch(e) {
      status.storage.ok = false;
      status.storage.error = e.message;
      status.storage.last_check = new Date().toISOString();
    }
  } else {
    status.storage.ok = false;
    status.storage.error = 'AZURE_STORAGE_CONNECTION_STRING not configured';
  }

  // Active sessions
  status.sessions = {
    active: activeSessions.size,
    users: Array.from(activeSessions.values()).map(s => ({
      name: s.name || 'Unknown',
      ip: s.ip,
      userAgent: s.userAgent,
      lastSeen: s.lastSeen,
      loginAt: s.loginAt,
    })).sort((a,b) => b.lastSeen.localeCompare(a.lastSeen)),
  };

  res.json(status);
});

// Initialize Azure Table Storage then start server
initTables().then(async () => {
  await initFollowupTables();
app.listen(PORT, () => {
  console.log(`Relay running at http://localhost:${PORT}`);
  console.log(`PCO_FORM_ID raw value: "${process.env.PCO_FORM_ID}"`);
  console.log(`PCO_FORM_ID resolved: ${PCO_FORM_ID}`);
  if (PCO_FORM_ID) console.log(`✓ Locked to form ID: ${PCO_FORM_ID}`);
  if (PCO_NOTE_CATEGORY_ID) console.log(`✓ Note category ID: ${PCO_NOTE_CATEGORY_ID}`);
  else console.log(`No form lock — dropdown will show`);
  if (!PCO_APP_ID || !PCO_SECRET) console.warn('WARNING: PCO credentials not set in .env');
});
});
