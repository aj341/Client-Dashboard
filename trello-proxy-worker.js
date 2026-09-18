// Cloudflare Worker: read-only proxy for the Design Bees Trello dashboard.
//
// Holds the Trello API key/token as server-side secrets so the dashboard
// page itself never contains or requests credentials. Only forwards GET
// requests, and only to a fixed allow-list of board/list IDs for this one
// board — it cannot be used to reach any other part of the Trello account.
//
// Deploy: set secrets TRELLO_KEY and TRELLO_TOKEN (wrangler secret put, or
// the Cloudflare dashboard's Settings > Variables > "Encrypt" toggle).

const BOARD_ID = 'x4btPZ3f';

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

    let trelloPath;
    if (parts[0] === 'board' && parts[1] === 'labels') {
      trelloPath = `/1/boards/${BOARD_ID}/labels`;
    } else if (parts[0] === 'board' && parts[1] === 'customFields') {
      trelloPath = `/1/boards/${BOARD_ID}/customFields`;
    } else if (parts[0] === 'list' && parts[1] && parts[2] === 'cards') {
      const listId = parts[1];
      if (!ALLOWED_LIST_IDS.has(listId)) {
        return json({ error: 'List not allowed' }, 403);
      }
      trelloPath = `/1/lists/${listId}/cards`;
    } else {
      return json({ error: 'Not found' }, 404);
    }

    const trelloUrl = new URL(`https://api.trello.com${trelloPath}`);
    // Pass through the caller's query params (fields, members, etc.) before
    // attaching credentials, so the frontend still controls what it asks for.
    url.searchParams.forEach((v, k) => trelloUrl.searchParams.set(k, v));
    trelloUrl.searchParams.set('key', env.TRELLO_KEY);
    trelloUrl.searchParams.set('token', env.TRELLO_TOKEN);

    const resp = await fetch(trelloUrl);
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  },
};
