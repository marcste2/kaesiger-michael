const ALLOWED_ORIGINS = new Set([
  'https://marcste2.github.io',
]);
const SCORE_MAX = 50000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;
const rateBuckets = new Map();

function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 +
    ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function cleanName(value) {
  let name = String(value || '').trim().replace(/\s+/g, ' ');
  name = name.replace(/[^\p{L}\p{N} _\-.]/gu, '').slice(0, 12);
  const blocked = ['hitler', 'nazi', 'penis', 'fuck', 'nigger', 'fotze', 'wichs', 'hure'];
  return blocked.some(word => name.toLowerCase().includes(word)) ? '' : name;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(request, data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      ...corsHeaders(request),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function allowedRequest(request) {
  const origin = request.headers.get('Origin');
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function rateLimited(request) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.started >= RATE_WINDOW_MS) {
    bucket = { started: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (rateBuckets.size > 1000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.started >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  return bucket.count > RATE_MAX;
}

async function leaderboard(env, playerId) {
  const week = weekKey();
  const topResult = await env.DB.prepare(
    `SELECT player_id AS playerId, name, score, updated_at AS updatedAt
     FROM scores
     WHERE week = ?
     ORDER BY score DESC, updated_at ASC, player_id ASC
     LIMIT 50`
  ).bind(week).all();
  const top = (topResult.results || []).map((row, index) => ({
    rank: index + 1,
    playerId: row.playerId,
    name: row.name,
    score: row.score,
  }));

  let mine = null;
  if (/^[a-zA-Z0-9-]{8,64}$/.test(playerId || '')) {
    mine = await env.DB.prepare(
      `SELECT s.player_id AS playerId, s.name, s.score,
        1 + (
          SELECT COUNT(*) FROM scores x
          WHERE x.week = s.week AND (
            x.score > s.score OR
            (x.score = s.score AND x.updated_at < s.updated_at) OR
            (x.score = s.score AND x.updated_at = s.updated_at AND x.player_id < s.player_id)
          )
        ) AS rank
       FROM scores s
       WHERE s.week = ? AND s.player_id = ?`
    ).bind(week, playerId).first();
  }
  return { week, top, mine: mine || null, updatedAt: Date.now() };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (!allowedRequest(request)) return json(request, { error: 'origin_not_allowed' }, 403);

    if (url.pathname === '/health' && request.method === 'GET') {
      return json(request, { ok: true, week: weekKey() });
    }

    if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
      try {
        return json(request, await leaderboard(env, url.searchParams.get('playerId') || ''));
      } catch (error) {
        return json(request, { error: 'leaderboard_unavailable' }, 503);
      }
    }

    if (url.pathname === '/api/score' && request.method === 'POST') {
      if (rateLimited(request)) return json(request, { error: 'rate_limited' }, 429);
      let body;
      try {
        body = await request.json();
      } catch {
        return json(request, { error: 'invalid_json' }, 400);
      }
      const playerId = String(body.playerId || '');
      const name = cleanName(body.name);
      const score = Number(body.score);
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(playerId) ||
          name.length < 3 ||
          !Number.isInteger(score) ||
          score <= 0 ||
          score > SCORE_MAX) {
        return json(request, { error: 'invalid_score' }, 400);
      }
      const week = weekKey();
      const now = Date.now();
      try {
        await env.DB.prepare(
          `INSERT INTO scores (week, player_id, name, score, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(week, player_id) DO UPDATE SET
             name = excluded.name,
             score = MAX(scores.score, excluded.score),
             updated_at = CASE
               WHEN excluded.score > scores.score THEN excluded.updated_at
               ELSE scores.updated_at
             END`
        ).bind(week, playerId, name, score, now).run();
        return json(request, await leaderboard(env, playerId));
      } catch (error) {
        return json(request, { error: 'score_unavailable' }, 503);
      }
    }

    return json(request, { error: 'not_found' }, 404);
  },
};
