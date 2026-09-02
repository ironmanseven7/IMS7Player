/**
 * Xtream Web Player - local proxy + static host.
 *
 * Zero dependencies. Node 18+.
 *
 * Why a proxy at all: Xtream Codes panels don't send Access-Control-Allow-Origin,
 * so player_api.php calls and .m3u8 fetches are blocked by the browser. This
 * server relays them from the same origin as the page, rewrites HLS manifests so
 * segment URIs keep flowing through the relay, and forwards Range headers so VOD
 * seeking works.
 *
 * Binds to 127.0.0.1 only. Do not expose it: /stream will relay any http(s) URL
 * it is handed, which is an open proxy if it is reachable from outside.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Bump together with CLIENT_VERSION in public/app.js whenever routes change.
// The page is served fresh from disk on every request, so a long-running process
// can end up older than the page it is serving; the app compares these and says so.
const VERSION = '1.6.0';

const PORT = Number(process.env.PORT) || 8787;
const BIND = process.env.BIND || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_REDIRECTS = 5;
const UA = process.env.XTREAM_UA || 'VLC/3.0.20 LibVLC/3.0.20';
// Panels very often run expired or self-signed certs. Opt in with XTREAM_INSECURE_TLS=1.
const INSECURE_TLS = process.env.XTREAM_INSECURE_TLS === '1';

/** Non-standard status codes XUI.one / Xtream panels return instead of a JSON error. */
const PANEL_STATUS_HINTS = {
  511: 'The panel wants credentials it did not get (HTTP 511). Check the username and password fields.',
  512: 'The panel rejected this line (HTTP 512). Usually a wrong username/password, an expired line, ' +
    'or a line bound to a different host/port than the one you entered - check the exact URL in your ' +
    'provider\'s M3U link.',
  513: 'The panel says this line is already at its connection limit (HTTP 513).',
  521: 'The panel is blocking this IP or device (HTTP 521).',
};

// Kept in memory as well as printed so /log can serve it. The Android build has
// no terminal to read, and both servers answer the same diagnostics route.
const recentLog = [];

function logLine(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  recentLog.push(line);
  if (recentLog.length > 120) recentLog.shift();
}

/** Strip credentials before anything reaches the console. */
function redact(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.searchParams.has('password')) u.searchParams.set('password', '***');
    if (u.searchParams.has('username')) u.searchParams.set('username', '***');
    return u.toString().replace(/\/(live|movie|series)\/[^/]+\/[^/]+\//, '/$1/***/***/');
  } catch {
    return urlStr;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Keep-alive pools. Without these every HLS segment pays a fresh TCP (and TLS)
 * handshake to the panel, which on a 6-second segment cycle is a large slice of
 * the time budget and a common cause of stalling.
 */
const AGENTS = {
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 32, scheduling: 'fifo' }),
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 32, scheduling: 'fifo' }),
};

/** Fire an upstream request, following redirects manually so we learn the final URL. */
function upstream(targetUrl, { method = 'GET', headers = {}, depth = 0, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return reject(new Error(`Bad upstream URL: ${targetUrl}`));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error(`Refusing non-http(s) URL: ${parsed.protocol}`));
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      {
        method,
        headers: {
          'user-agent': UA,
          accept: '*/*',
          ...headers,
          host: parsed.host,
        },
        timeout: timeoutMs,
        agent: AGENTS[parsed.protocol],
        ...(parsed.protocol === 'https:' && INSECURE_TLS ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const loc = res.headers.location;
        if (loc && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          if (depth >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
          const next = new URL(loc, parsed).toString();
          return resolve(upstream(next, { method, headers, depth: depth + 1, timeoutMs }));
        }
        resolve({ res, finalUrl: parsed.toString() });
      }
    );

    // Nagle batching adds latency to the small, frequent writes a stream makes.
    req.on('socket', (socket) => socket.setNoDelay(true));
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Normalise whatever the user typed into a scheme + host + optional port origin. */
function normaliseHost(raw) {
  let v = String(raw || '').trim();
  if (!v) throw new Error('Missing server address');
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  const u = new URL(v);
  return `${u.protocol}//${u.host}`;
}

/**
 * Rewrite an HLS manifest so every segment / key / variant URI is resolved
 * against the *final* upstream URL and routed back through /stream.
 */
function rewriteManifest(text, finalUrl) {
  const base = new URL(finalUrl);
  const proxied = (u) => {
    try {
      return '/stream?url=' + encodeURIComponent(new URL(u.trim(), base).toString());
    } catch {
      return u;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxied(u)}"`);
      }
      return proxied(t);
    })
    .join('\n');
}

const M3U8_HINT = /mpegurl|x-mpegURL/i;

async function handleStream(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'Missing url parameter' });

  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;

  let out;
  try {
    // A live feed can pause between bursts; 15s is too eager to kill playback.
    out = await upstream(target, { headers, timeoutMs: 45000 });
  } catch (err) {
    logLine(`PLAY FAIL  ${redact(target)}  ${err.message || err}`);
    return sendJson(res, 502, { error: 'Upstream request failed', detail: String(err.message || err) });
  }
  if (!req.headers.range) logLine(`PLAY ${out.res.statusCode}  ${redact(target)}`);

  const { res: up, finalUrl } = out;
  const ctype = String(up.headers['content-type'] || '');
  const looksLikeManifest = M3U8_HINT.test(ctype) || /\.m3u8(\?|$)/i.test(finalUrl);

  if (looksLikeManifest) {
    let raw;
    try {
      raw = (await readBody(up)).toString('utf8');
    } catch (err) {
      return sendJson(res, 502, { error: 'Could not read manifest', detail: String(err.message || err) });
    }
    if (!raw.includes('#EXTM3U')) {
      // Not actually a playlist (panels often return an HTML error page here).
      return sendJson(res, 502, {
        error: 'Server did not return a playlist',
        detail: raw.slice(0, 300),
      });
    }
    const body = Buffer.from(rewriteManifest(raw, finalUrl));
    res.writeHead(up.statusCode || 200, {
      'content-type': 'application/vnd.apple.mpegurl',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    return res.end(body);
  }

  const passthrough = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    if (up.headers[k]) passthrough[k] = up.headers[k];
  }
  passthrough['cache-control'] = 'no-store';

  res.writeHead(up.statusCode || 200, passthrough);
  up.pipe(res);
  req.on('close', () => up.destroy());
}

async function handleApi(req, res, url) {
  let origin;
  try {
    origin = normaliseHost(url.searchParams.get('host'));
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }

  const endpoint = url.searchParams.get('endpoint') === 'xmltv' ? 'xmltv.php' : 'player_api.php';
  const target = new URL(`${origin}/${endpoint}`);
  for (const [k, v] of url.searchParams) {
    if (k === 'host' || k === 'endpoint') continue;
    target.searchParams.set(k, v);
  }

  const started = Date.now();
  let out;
  try {
    out = await upstream(target.toString());
  } catch (err) {
    const detail = String(err.message || err);
    logLine(`API  FAIL  ${redact(target.toString())}  ${detail}`);
    const tls = /certificate|self-signed|SSL|TLS/i.test(detail)
      ? ' This panel has an untrusted certificate. Restart the player with XTREAM_INSECURE_TLS=1 to accept it, or use the http:// address instead.'
      : '';
    return sendJson(res, 502, { error: 'Could not reach the panel', detail: detail + tls });
  }

  const { res: up } = out;
  let raw;
  try {
    raw = await readBody(up);
  } catch (err) {
    return sendJson(res, 502, { error: 'Panel response failed', detail: String(err.message || err) });
  }

  logLine(`API  ${up.statusCode}  ${Date.now() - started}ms  ${raw.length}B  ${redact(target.toString())}`);

  if (endpoint === 'xmltv.php') {
    res.writeHead(up.statusCode || 200, {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'no-store',
    });
    return res.end(raw);
  }

  const text = raw.toString('utf8');
  try {
    JSON.parse(text);
  } catch {
    const code = up.statusCode;
    const hint = PANEL_STATUS_HINTS[code];
    let detail;
    if (hint) detail = hint;
    else if (!text.trim()) detail = `The panel answered HTTP ${code} with an empty body, so it is not serving the player API at this address. Check the host and port in your provider's M3U link.`;
    else if (/<html|<!doctype/i.test(text)) detail = `The panel answered HTTP ${code} with a web page, not API data - this address is probably the customer portal rather than the API host.`;
    else detail = `HTTP ${code}: ${text.slice(0, 300)}`;

    return sendJson(res, 502, { error: 'The panel did not return player API data', status: code, detail });
  }

  res.writeHead(up.statusCode || 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/* ── server discovery ───────────────────────────────────────
 * The address a provider prints on its website is often the customer portal,
 * not the machine serving player_api.php. Given a hostname and a line, try the
 * ports Xtream/XUI panels are normally published on and report which one
 * actually answers with player API JSON.
 */

const PROBE_PORTS = [
  ['http', 80], ['http', 8080], ['http', 8000], ['http', 8880],
  ['http', 2082], ['http', 2086], ['http', 2095], ['http', 25461],
  ['http', 25462], ['http', 8081], ['https', 443], ['https', 2083],
  ['https', 2096], ['https', 8443],
];
const PROBE_PREFIXES = ['line', 'tv', 'panel', 'api', 'portal'];
const PROBE_CONCURRENCY = 6;

async function probeOne(origin, username, password) {
  const target = `${origin}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  try {
    const { res } = await upstream(target, { timeoutMs: 6000 });
    const text = (await readBody(res)).toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    if (json && json.user_info) {
      const authed = String(json.user_info.auth) === '1';
      return {
        origin,
        verdict: authed ? 'works' : 'wrong-credentials',
        status: res.statusCode,
        note: authed
          ? `Player API works here (${json.user_info.status || 'active'})`
          : 'This IS the API host, but it rejected this username/password',
      };
    }
    return {
      origin,
      verdict: 'no-api',
      status: res.statusCode,
      note: PANEL_STATUS_HINTS[res.statusCode]
        ? `HTTP ${res.statusCode}`
        : text.trim()
          ? `HTTP ${res.statusCode}, not API data`
          : `HTTP ${res.statusCode}, empty response`,
    };
  } catch (err) {
    return { origin, verdict: 'unreachable', note: String(err.message || err).slice(0, 80) };
  }
}

async function handleProbe(req, res, url) {
  const rawHost = String(url.searchParams.get('host') || '').trim();
  const username = url.searchParams.get('username') || '';
  const password = url.searchParams.get('password') || '';
  if (!rawHost || !username || !password) {
    return sendJson(res, 400, { error: 'Need host, username and password to search.' });
  }

  let hostname, explicitPort, scheme;
  try {
    const u = new URL(/^https?:\/\//i.test(rawHost) ? rawHost : 'http://' + rawHost);
    hostname = u.hostname;
    explicitPort = u.port;
    scheme = u.protocol.replace(':', '');
  } catch {
    return sendJson(res, 400, { error: 'That does not look like a server address.' });
  }

  const origins = [];
  const add = (s, h, p) => {
    const o = `${s}://${h}${(s === 'http' && p == 80) || (s === 'https' && p == 443) ? '' : ':' + p}`;
    if (!origins.includes(o)) origins.push(o);
  };

  if (explicitPort) add(scheme, hostname, explicitPort);
  for (const [s, p] of PROBE_PORTS) add(s, hostname, p);

  // Providers commonly put the line on a subdomain of the portal domain.
  const bare = hostname.replace(/^(www|portal|client|billing)\./i, '');
  if (bare.split('.').length === 2) {
    for (const pre of PROBE_PREFIXES) {
      if (`${pre}.${bare}` === hostname) continue;
      add('http', `${pre}.${bare}`, 80);
      add('http', `${pre}.${bare}`, 8080);
    }
  }

  logLine(`PROBE start  ${origins.length} candidates for ${hostname}`);
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: PROBE_CONCURRENCY }, async () => {
      while (cursor < origins.length) {
        const origin = origins[cursor++];
        results.push(await probeOne(origin, username, password));
      }
    })
  );

  const rank = { works: 0, 'wrong-credentials': 1, 'no-api': 2, unreachable: 3 };
  results.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.origin.localeCompare(b.origin));
  const hit = results.find((r) => r.verdict === 'works');
  logLine(`PROBE done   ${hit ? 'FOUND ' + hit.origin : 'no working address among ' + origins.length}`);

  sendJson(res, 200, { tried: origins.length, results });
}

/**
 * Hand out an APK dropped in this folder, for sideloading with Downloader on a
 * Fire TV or Shield. Typing a LAN address into a TV remote is tolerable; typing
 * a GitHub URL and signing in is not.
 *
 * Requires BIND=0.0.0.0 so the TV can reach it. See the README warning: that
 * also exposes /stream to your network, so turn it off when you're done.
 */
function serveApk(req, res) {
  let apk;
  try {
    apk = fs.readdirSync(__dirname).filter((f) => f.toLowerCase().endsWith('.apk')).sort().pop();
  } catch {
    apk = null;
  }
  if (!apk) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('No .apk in the xtream-player folder. Download one from the GitHub release and drop it here.');
  }

  const file = path.join(__dirname, apk);
  const size = fs.statSync(file).size;
  logLine(`APK  serving ${apk} (${(size / 1048576).toFixed(1)} MB) to ${req.socket.remoteAddress}`);
  res.writeHead(200, {
    'content-type': 'application/vnd.android.package-archive',
    'content-length': size,
    'content-disposition': `attachment; filename="${apk}"`,
  });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api') return void handleApi(req, res, url);
  if (url.pathname === '/stream') return void handleStream(req, res, url);
  if (url.pathname === '/probe') return void handleProbe(req, res, url);
  if (url.pathname === '/apk') return serveApk(req, res);
  if (url.pathname === '/log') return sendJson(res, 200, { lines: recentLog });
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, version: VERSION });
  return serveStatic(req, res, url);
});

server.on('clientError', (_err, socket) => socket.destroy());

/** Someone already owns the port. Work out whether it's another copy of this player. */
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`\n  Could not start: ${err.message}\n`);
    process.exit(1);
  }

  const req = http.get({ host: BIND, port: PORT, path: '/health', timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      if (body.includes('"ok":true')) {
        console.log(`\n  The player is already running at  http://${BIND}:${PORT}`);
        console.log('  Nothing to do - just open that address in your browser.');
        console.log('  (To restart it, close the other window first.)\n');
      } else {
        portTaken();
      }
      process.exit(0);
    });
  });
  req.on('timeout', () => {
    req.destroy();
    portTaken();
    process.exit(1);
  });
  req.on('error', () => {
    portTaken();
    process.exit(1);
  });
});

function portTaken() {
  console.log(`\n  Port ${PORT} is in use by another program.`);
  console.log(`  Start this player on a different port instead, for example:\n`);
  console.log(`      set PORT=8788 && node server.js\n`);
}

server.listen(PORT, BIND, () => {
  console.log(`\n  Xtream Web Player running at  http://${BIND}:${PORT}\n`);
  if (BIND === '0.0.0.0') {
    const nets = require('os').networkInterfaces();
    const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
    if (lan) {
      console.log(`  On your network:              http://${lan.address}:${PORT}`);
      console.log(`  Sideload URL for Downloader:  http://${lan.address}:${PORT}/apk`);
      console.log('  (Anyone on this network can reach it - stop the server when done.)');
    }
    console.log('');
  }
  console.log('  Enter your panel URL, username and password in the browser.');
  console.log('  Credentials are never stored on this server.\n');
});
