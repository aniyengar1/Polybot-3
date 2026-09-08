// Public-facing monitoring dashboard for kalshi-bot + sports-bot. Runs on kalshi-bot-vm only
// (no third VM) -- fetches kalshi-bot's own stats over localhost (kalshi-bot-stats.service)
// and sports-bot's stats over the VPC's internal IP (sports-bot-stats.service, which is NOT
// exposed to the public internet -- only this dashboard, on the same private network, can
// reach it). Merges both into one JSON, and serves the static dashboard page. HTTP Basic Auth
// gates both routes -- this reveals real strategy edges even in paper mode, not meant to be
// wide open. View-only: no route here ever accepts a write; every query in this file and in
// both statsServer.js files is a SELECT, nothing else.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.KALSHI_DASHBOARD_PORT || 8080);
const KALSHI_STATS_URL = process.env.KALSHI_DASHBOARD_KALSHI_STATS_URL || 'http://127.0.0.1:7001/stats';
const KALSHI_STATS_ORIGIN = new URL(KALSHI_STATS_URL).origin; // e.g. http://127.0.0.1:7001 -- base for other kalshi-bot-stats routes (bucket-trades)
const SPORTS_STATS_URL = process.env.KALSHI_DASHBOARD_SPORTS_STATS_URL; // required, internal IP:port
const AUTH_USER = process.env.KALSHI_DASHBOARD_USER;
const AUTH_PASS = process.env.KALSHI_DASHBOARD_PASS;

if (!AUTH_USER || !AUTH_PASS) {
  throw new Error('KALSHI_DASHBOARD_USER / KALSHI_DASHBOARD_PASS must be set -- refusing to start a dashboard with no auth configured.');
}
if (!SPORTS_STATS_URL) {
  throw new Error('KALSHI_DASHBOARD_SPORTS_STATS_URL must be set (sports-bot-vm internal IP) -- refusing to guess it.');
}

function checkAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === AUTH_USER && pass === AUTH_PASS;
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(body) });
        } catch (err) {
          resolve({ ok: false, error: `bad JSON from ${url}: ${err}` });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `timeout fetching ${url}` });
    });
    req.on('error', (err) => resolve({ ok: false, error: `${url}: ${err}` }));
  });
}

async function getMergedStats() {
  const [kalshi, sports] = await Promise.all([fetchJson(KALSHI_STATS_URL), fetchJson(SPORTS_STATS_URL)]);
  return {
    generatedAt: new Date().toISOString(),
    kalshiBot: kalshi.ok ? kalshi.data : { error: kalshi.error, serviceActive: false },
    sportsBot: sports.ok ? sports.data : { error: sports.error, serviceActive: false },
  };
}

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="bot dashboard"', 'Content-Type': 'text/plain' });
    res.end('Authentication required.');
    return;
  }

  if (req.url === '/api/stats' && req.method === 'GET') {
    const merged = await getMergedStats();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(merged));
    return;
  }

  // Per-bucket trade drill-down, fetched on demand by the dashboard when a bucket card is
  // clicked -- deliberately not part of /api/stats's 30s poll payload (see statsServer.js's
  // /bucket-trades route, which owns validation and the actual query). kalshi-bot only; sports-
  // bot has no bucket concept.
  if (req.url.startsWith('/api/kalshi/bucket-trades') && req.method === 'GET') {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const upstream = await fetchJson(KALSHI_STATS_ORIGIN + '/bucket-trades' + parsed.search);
    res.writeHead(upstream.ok ? 200 : 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(upstream.ok ? upstream.data : { error: upstream.error }));
    return;
  }

  if ((req.url === '/' || req.url === '/index.html') && req.method === 'GET') {
    try {
      const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`dashboard.html missing: ${err}`);
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] dashboard listening on 0.0.0.0:${PORT}`);
});
