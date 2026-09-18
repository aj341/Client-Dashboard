// Cloudflare Worker: read-only proxy for the Design Bees Trello dashboard.
//
// Holds the Trello API key/token as server-side secrets so the dashboard
// page itself never contains or requests credentials. Only forwards GET
// requests, and only to a fixed allow-list of board/list IDs for this one
// board — it cannot be used to reach any other part of the Trello account.
//
// Also applies the exclude-email / exclude-label filtering server-side, so
// which clients/emails are excluded is never visible in the dashboard's
// page source to the team viewing it, and no personal email address ever
// needs to be committed to the GitHub repo.
//
// Deploy: set these as secrets (Settings > Variables and Secrets > Add):
//   TRELLO_KEY       - Trello API key
//   TRELLO_TOKEN     - Trello token
//   EXCLUDE_EMAILS   - comma-separated list of exact emails or @domains to
//                      hide, e.g. "someone@gmail.com,designbees.com.au"
//   EXCLUDE_LABELS   - comma-separated Trello label names to hide,
//                      e.g. "design Bees,Mckenzie Dev"
// EXCLUDE_EMAILS and EXCLUDE_LABELS are optional — leave unset for no
// filtering. To change them, just edit the secret's value and save;
// no code change or redeploy needed.

const BOARD_ID = 'x4btPZ3f';
const CLIENT_EMAIL_FIELD_NAME = 'client email';

const ALLOWED_LIST_IDS = new Set([
  '6767eb93ad96bd8a9c785242', // 2.2 - Being Designed
  '65694d3b54a5be08d28f529b', // STAGE 2: With Designer
  '656d96513d2851c6d5458391', // 3 - Internal Check
  '65694d3b545bb7f8813c32ef', // STAGE 4: Client review
  '6767eba73e27b8009ef10f25', // Stage 5.1 Prepping Files
  '65f2b493a2a6fee06c4c9e78', // 5.2 - Packaging Files to send
  '65a4ae916bbe11ac77be2ed3', // STAGE 6: Files Pushed
  '65694d3b4a249033d5a9c7bb', // STAGE 1: Scoping
  '69167848e061f20b459250cb', // 2.1 - Waiting For Your Input (On Hold)
  '65ded88d73b12a33e6dcf412', // STAGE 5: Client Approved
  '65dfc41340a34fc6664b0aa5', // STAGE 7: Client Review Survey
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function parseList(raw) {
  return (raw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Cached per-isolate for a short time so 11 parallel list requests don't
// each re-fetch board labels/custom fields from Trello.
let filterMetaCache = null;
let filterMetaCacheAt = 0;
const FILTER_META_TTL_MS = 60000;

async function getFilterMeta(env) {
  const now = Date.now();
  if (filterMetaCache && now - filterMetaCacheAt < FILTER_META_TTL_MS) {
    return filterMetaCache;
  }
  const [labels, customFields] = await Promise.all([
    trelloFetch(`/1/boards/${BOARD_ID}/labels`, { fields: 'name', limit: '1000' }, env).then(r => r.json()),
    trelloFetch(`/1/boards/${BOARD_ID}/customFields`, {}, env).then(r => r.json()),
  ]);
  const labelNameById = {};
  (labels || []).forEach(l => { if (l.name) labelNameById[l.id] = l.name.toLowerCase(); });
  const emailField = (customFields || []).find(f => (f.name || '').trim().toLowerCase() === CLIENT_EMAIL_FIELD_NAME);
  filterMetaCache = { labelNameById, emailFieldId: emailField ? emailField.id : null };
  filterMetaCacheAt = now;
  return filterMetaCache;
}

function trelloFetch(path, params, env) {
  const url = new URL(`https://api.trello.com${path}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('key', env.TRELLO_KEY);
  url.searchParams.set('token', env.TRELLO_TOKEN);
  return fetch(url);
}

function cardIsExcluded(card, meta, excludedEmails, excludedLabelNames) {
  if (excludedLabelNames.length) {
    const hasExcludedLabel = (card.idLabels || []).some(id => excludedLabelNames.includes(meta.labelNameById[id]));
    if (hasExcludedLabel) return true;
  }
  if (excludedEmails.length && meta.emailFieldId && card.customFieldItems) {
    const item = card.customFieldItems.find(i => i.idCustomField === meta.emailFieldId);
    const email = item && item.value ? (item.value.text || '').trim().toLowerCase() : '';
    if (email) {
      const isExactMatch = excludedEmails.some(e => e.includes('@') && e === email);
      const isDomainMatch = excludedEmails.some(e => !e.includes('@') && email.endsWith('@' + e));
      if (isExactMatch || isDomainMatch) return true;
    }
  }
  return false;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Only GET is allowed' }, 405);
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['board','labels']

    if (parts[0] === 'board' && parts[1] === 'labels') {
      const resp = await trelloFetch(`/1/boards/${BOARD_ID}/labels`, Object.fromEntries(url.searchParams), env);
      return new Response(await resp.text(), { status: resp.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    if (parts[0] === 'board' && parts[1] === 'customFields') {
      const resp = await trelloFetch(`/1/boards/${BOARD_ID}/customFields`, Object.fromEntries(url.searchParams), env);
      return new Response(await resp.text(), { status: resp.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    if (parts[0] === 'list' && parts[1] && parts[2] === 'cards') {
      const listId = parts[1];
      if (!ALLOWED_LIST_IDS.has(listId)) {
        return json({ error: 'List not allowed' }, 403);
      }

      const excludedEmails = parseList(env.EXCLUDE_EMAILS);
      const excludedLabelNames = parseList(env.EXCLUDE_LABELS);
      const needsFiltering = excludedEmails.length > 0 || excludedLabelNames.length > 0;

      const params = Object.fromEntries(url.searchParams);
      if (needsFiltering) {
        // We need these to filter, regardless of what the frontend asked for.
        params.customFieldItems = 'true';
      }

      const [cardsResp, meta] = await Promise.all([
        trelloFetch(`/1/lists/${listId}/cards`, params, env),
        needsFiltering ? getFilterMeta(env) : Promise.resolve(null),
      ]);

      if (!cardsResp.ok) {
        return new Response(await cardsResp.text(), { status: cardsResp.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }

      let cards = await cardsResp.json();
      if (needsFiltering) {
        cards = cards.filter(c => !cardIsExcluded(c, meta, excludedEmails, excludedLabelNames));
      }
      // Never leak the raw client-email custom field value to the browser.
      cards.forEach(c => { delete c.customFieldItems; });

      return json(cards);
    }

    return json({ error: 'Not found' }, 404);
  },
};
