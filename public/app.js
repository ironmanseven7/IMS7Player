/* Xtream Web Player - browser app. Talks to the local proxy at /api and /stream. */

const $ = (sel) => document.querySelector(sel);
// Bump together with VERSION in server.js. The page comes off disk on every request,
// so a server process left running from an older build serves this newer page.
const CLIENT_VERSION = '1.11.0';
const STALE_SERVER =
  'The server.js process running in your terminal is older than this page. ' +
  'Close the "Start Player" window and run it again.';
const CHUNK = 150;
const STORE_KEY = 'xtream.creds';
const FAV_KEY = 'xtream.favs';
const BUFFER_KEY = 'xtream.buffer';

/**
 * Buffering profiles. The trade is always the same: how far behind the live edge
 * we sit. More distance means more cushion to ride out a hiccup, at the cost of
 * being further behind real time. "smooth" is the default because a stuttering
 * picture is worse than a 30-second delay on almost anything except live sport.
 */
const BUFFER_PROFILES = {
  smooth: {
    label: 'Smooth (most buffer)',
    hls: {
      lowLatencyMode: false,
      liveSyncDurationCount: 6,     // start ~6 segments behind live
      liveMaxLatencyDurationCount: 15,
      maxBufferLength: 60,          // seconds to hold ahead
      maxMaxBufferLength: 120,
      maxBufferSize: 120 * 1000 * 1000,
      backBufferLength: 30,
      maxBufferHole: 0.5,
      nudgeMaxRetry: 10,
      startFragPrefetch: true,
      fragLoadingMaxRetry: 8,
      manifestLoadingMaxRetry: 6,
      levelLoadingMaxRetry: 6,
    },
    ts: {
      enableWorker: true,
      enableStashBuffer: true,
      stashInitialSize: 1024,       // KB held before playback starts
      liveBufferLatencyChasing: false,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 60,
      autoCleanupMinBackwardDuration: 30,
    },
  },
  balanced: {
    label: 'Balanced',
    hls: {
      lowLatencyMode: false,
      liveSyncDurationCount: 4,
      liveMaxLatencyDurationCount: 10,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 20,
      maxBufferHole: 0.3,
      nudgeMaxRetry: 6,
      startFragPrefetch: true,
      fragLoadingMaxRetry: 5,
    },
    ts: {
      enableWorker: true,
      enableStashBuffer: true,
      stashInitialSize: 512,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 8,
      liveBufferLatencyMinRemain: 3,
      autoCleanupSourceBuffer: true,
    },
  },
  lowlatency: {
    label: 'Low latency (closest to live)',
    hls: {
      lowLatencyMode: true,
      liveSyncDurationCount: 3,
      maxBufferLength: 12,
      backBufferLength: 10,
      nudgeMaxRetry: 3,
    },
    ts: {
      enableWorker: true,
      enableStashBuffer: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 3,
      liveBufferLatencyMinRemain: 1,
    },
  },
};

function bufferProfile() {
  return BUFFER_PROFILES[localStorage.getItem(BUFFER_KEY)] || BUFFER_PROFILES.smooth;
}

const state = {
  creds: null,          // { host, username, password, fmt }
  section: 'live',      // live | movie | series | favorites
  categories: [],
  catFilter: 'all',
  items: [],            // full item list for the active category
  shown: 0,
  query: '',
  now: null,            // currently playing descriptor
  engine: null,         // hls.js / mpegts.js handle for the main player
  maxConnections: 0,    // what the panel says this line allows; 0 = unknown
  cache: { live: null, movie: null, series: null }, // all-streams cache per section
};

/** Multiview: up to MV_MAX live channels on screen, one of them with sound. */
const MV_MAX = 4;
const mv = {
  active: false,
  tiles: [],            // { id, name, logo, fav, el, video, pick, status, engine, gen, ... }
  selected: 0,
  epgFor: null,         // stream id the guide below the grid is showing
};

/* ── plumbing ─────────────────────────────────────────────── */

/**
 * Fetch JSON from our own proxy. A route that doesn't exist means the running
 * process predates this page, so say that rather than leaking a parse error.
 */
async function localJson(path) {
  const res = await fetch(path);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(res.status === 404 ? 'This build of the player is not running yet' : 'The local player returned an unreadable response');
    err.detail = res.status === 404 ? STALE_SERVER : `HTTP ${res.status}: ${text.slice(0, 120)}`;
    throw err;
  }
  return { res, data };
}

async function api(action, params = {}) {
  const q = new URLSearchParams({
    host: state.creds.host,
    username: state.creds.username,
    password: state.creds.password,
  });
  if (action) q.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }

  const { res, data } = await localJson('/api?' + q.toString());
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.detail = data?.detail || '';
    throw err;
  }
  return data;
}

function directUrl(kind, id, ext) {
  const base = state.creds.host.replace(/\/+$/, '');
  const u = encodeURIComponent(state.creds.username);
  const p = encodeURIComponent(state.creds.password);
  if (kind === 'live') return `${base}/live/${u}/${p}/${id}.${state.creds.fmt}`;
  if (kind === 'movie') return `${base}/movie/${u}/${p}/${id}.${ext || 'mp4'}`;
  return `${base}/series/${u}/${p}/${id}.${ext || 'mp4'}`;
}

// Absolute, not relative: mpegts.js loads inside a Web Worker, which cannot
// resolve a relative URL against the page.
const proxied = (url) => `${location.origin}/stream?url=` + encodeURIComponent(url);

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

const b64 = (s) => {
  if (!s) return '';
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return s;
  }
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── favourites ───────────────────────────────────────────── */

const favs = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    } catch {
      return [];
    }
  },
  write(list) {
    localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 500)));
  },
  key: (f) => `${f.kind}:${f.id}`,
  has(f) {
    return this.read().some((x) => this.key(x) === this.key(f));
  },
  toggle(f) {
    const list = this.read();
    const i = list.findIndex((x) => this.key(x) === this.key(f));
    if (i >= 0) list.splice(i, 1);
    else list.unshift(f);
    this.write(list);
    return i < 0;
  },
};

/* ── auth ─────────────────────────────────────────────────── */

/**
 * Providers hand out a single M3U link that already carries host, port, username
 * and password. Paste it into the URL box and we'll split it into the fields.
 */
function parsePastedUrl(value) {
  const v = String(value || '').trim();
  if (!/^https?:\/\//i.test(v) || !v.includes('?')) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const username = u.searchParams.get('username');
  const password = u.searchParams.get('password');
  if (!username || !password) return null;
  return { host: `${u.protocol}//${u.host}`, username, password };
}

$('#f-host').addEventListener('input', () => {
  const parsed = parsePastedUrl($('#f-host').value);
  if (!parsed) return;
  $('#f-host').value = parsed.host;
  $('#f-user').value = parsed.username;
  $('#f-pass').value = parsed.password;
  toast('Filled the username and password from that link.');
});

const PROBE_LABEL = {
  works: '✓',
  'wrong-credentials': '!',
  'no-api': '·',
  unreachable: '·',
};

$('#probe-btn').addEventListener('click', async () => {
  const btn = $('#probe-btn');
  const box = $('#probe-results');
  const q = new URLSearchParams({
    host: $('#f-host').value.trim(),
    username: $('#f-user').value,
    password: $('#f-pass').value,
  });

  if (!q.get('host') || !q.get('username') || !q.get('password')) {
    box.hidden = false;
    box.innerHTML = '<div class="probe-note">Fill in the address, username and password first - the search needs your line to tell a working host from a dead one.</div>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Searching…';
  box.hidden = false;
  box.innerHTML = '<div class="probe-note">Trying the ports and subdomains Xtream panels normally use. This takes a few seconds.</div>';

  try {
    const { res, data } = await localJson('/probe?' + q.toString());
    if (!res.ok) throw new Error(data?.error || 'Search failed');

    const good = data.results.filter((r) => r.verdict === 'works' || r.verdict === 'wrong-credentials');
    const dead = data.results.length - good.length;

    box.innerHTML =
      (good.length
        ? good
            .map(
              (r) =>
                `<button type="button" class="probe-hit ${r.verdict}" data-origin="${esc(r.origin)}">
                   <b>${PROBE_LABEL[r.verdict]} ${esc(r.origin)}</b><span>${esc(r.note)}</span>
                 </button>`
            )
            .join('')
        : `<div class="probe-note">Tried ${data.tried} addresses on that host - none of them serve the player API.
             Your line lives somewhere else. Open your provider's client area, copy the M3U / Xtream link it gives you,
             and paste the whole thing into the Server URL box above.</div>`) +
      (good.length ? `<div class="probe-note">${dead} other addresses did not answer as a panel.</div>` : '');

    box.querySelectorAll('.probe-hit').forEach((b) =>
      b.addEventListener('click', () => {
        $('#f-host').value = b.dataset.origin;
        box.hidden = true;
        $('#login-form').requestSubmit();
      })
    );
  } catch (ex) {
    box.innerHTML = `<div class="probe-note">${esc(ex.message || ex)}${ex.detail ? '<br>' + esc(ex.detail) : ''}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find my server';
  }
});

function showLoginError(ex) {
  const err = $('#login-error');
  err.innerHTML =
    `<b>${esc(ex.message || ex)}</b>` +
    (ex.detail ? `<span class="detail-line">${esc(ex.detail)}</span>` : '') +
    `<span class="detail-line muted">The exact request and status are printed in the terminal running server.js.</span>`;
  err.hidden = false;
}

async function connect(creds) {
  state.creds = creds;
  const info = await api(null);
  if (!info || !info.user_info) throw new Error('Unexpected response from the panel.');
  if (String(info.user_info.auth) === '0' || info.user_info.status === 'Banned') {
    throw new Error(`Login rejected by the panel (status: ${info.user_info.status || 'auth failed'}).`);
  }

  const ui = info.user_info;
  state.maxConnections = Number(ui.max_connections) || 0;
  const exp = ui.exp_date ? new Date(Number(ui.exp_date) * 1000).toLocaleDateString() : 'never';
  $('#acct-info').textContent =
    `${ui.username} · ${ui.status || 'Active'} · expires ${exp} · ${ui.active_cons || 0}/${ui.max_connections || '?'} connections`;

  $('#login').hidden = true;
  $('#app').hidden = false;
  startUpdateChecks();
  await loadSection('live');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const err = $('#login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  const creds = {
    host: $('#f-host').value.trim(),
    username: $('#f-user').value,
    password: $('#f-pass').value,
    fmt: $('#f-fmt').value,
  };

  try {
    await connect(creds);
    if ($('#f-remember').checked) localStorage.setItem(STORE_KEY, JSON.stringify(creds));
    else localStorage.removeItem(STORE_KEY);
  } catch (ex) {
    showLoginError(ex);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

$('#logout').addEventListener('click', () => {
  stopPlayback();
  localStorage.removeItem(STORE_KEY);
  location.reload();
});

/* ── sections ─────────────────────────────────────────────── */

const CAT_ACTION = { live: 'get_live_categories', movie: 'get_vod_categories', series: 'get_series_categories' };
const LIST_ACTION = { live: 'get_live_streams', movie: 'get_vod_streams', series: 'get_series' };

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    loadSection(tab.dataset.section);
  });
});

async function loadSection(section) {
  state.section = section;
  state.catFilter = 'all';
  state.query = '';
  $('#item-search').value = '';
  $('#cat-search').value = '';

  if (section === 'favorites') {
    state.categories = [];
    renderCategories();
    state.items = favs.read();
    resetList();
    return;
  }

  $('#cat-list').innerHTML = skeletonRows(6);
  $('#item-list').innerHTML = skeletonRows(9);

  try {
    const cats = await api(CAT_ACTION[section]);
    state.categories = adultLast(Array.isArray(cats) ? cats : [], (c) => isAdultName(c.category_name));
    renderCategories();

    if (!state.cache[section]) {
      const all = await api(LIST_ACTION[section]);
      state.cache[section] = Array.isArray(all) ? all : [];
    }
    // Voice search can fill the cache before the categories are known, so this
    // runs on every load; it is stable, so doing it twice changes nothing.
    const adultCats = new Set(state.categories.filter((c) => isAdultName(c.category_name)).map((c) => String(c.category_id)));
    state.cache[section] = adultLast(state.cache[section], (r) => adultCats.has(String(r.category_id)) || isAdultName(r.name || r.title));
    state.items = state.cache[section];
    resetList();
  } catch (ex) {
    $('#cat-list').innerHTML = '';
    $('#item-list').innerHTML = `<li class="error-row">${esc(ex.message || ex)}</li>`;
  }
}

/**
 * Panels list adult channels wherever their own ordering puts them, which is
 * often the top of "All". Keep them, but move them to the end.
 */
// "Adult Swim" is a cartoon channel, not an adult one.
const ADULT_NAME = /^\W*(xxx|adults?\b(?!\s*swim)|18\s*\+)|\b(xxx|adults? only|for adults|porn)\b/i;
const isAdultName = (name) => ADULT_NAME.test(String(name || ''));

/** Stable partition: everything else in its original order, then the adult rows. */
function adultLast(rows, isAdult) {
  const keep = [];
  const last = [];
  for (const r of rows) (isAdult(r) ? last : keep).push(r);
  return last.length ? keep.concat(last) : rows;
}

function renderCategories() {
  const filter = $('#cat-search').value.toLowerCase();
  const ul = $('#cat-list');

  if (state.section === 'favorites') {
    ul.innerHTML = '<li class="loading">Saved items</li>';
    return;
  }

  const rows = state.categories.filter((c) => !filter || String(c.category_name).toLowerCase().includes(filter));
  ul.innerHTML =
    `<li><button class="cat ${state.catFilter === 'all' ? 'active' : ''}" data-id="all">All</button></li>` +
    rows
      .map(
        (c) =>
          `<li><button class="cat ${state.catFilter === c.category_id ? 'active' : ''}" data-id="${esc(c.category_id)}">${esc(c.category_name)}</button></li>`
      )
      .join('');

  ul.querySelectorAll('.cat').forEach((b) =>
    b.addEventListener('click', () => {
      state.catFilter = b.dataset.id;
      renderCategories();
      resetList();
    })
  );
}

$('#cat-search').addEventListener('input', renderCategories);
$('#item-search').addEventListener('input', (e) => {
  state.query = e.target.value.toLowerCase();
  resetList();
});

function visibleItems() {
  let rows = state.items;
  if (state.section !== 'favorites' && state.catFilter !== 'all') {
    rows = rows.filter((r) => String(r.category_id) === String(state.catFilter));
  }
  if (state.query) {
    rows = rows.filter((r) => String(r.name || r.title || '').toLowerCase().includes(state.query));
  }
  return rows;
}

function resetList() {
  state.shown = 0;
  $('#item-list').innerHTML = '';
  renderMore();
}

function itemKind(row) {
  if (state.section === 'favorites') return row.kind;
  return state.section;
}

function renderMore() {
  const rows = visibleItems();
  const slice = rows.slice(state.shown, state.shown + CHUNK);
  const ul = $('#item-list');

  if (!rows.length) {
    ul.innerHTML = '<li class="loading">Nothing here.</li>';
    $('#item-count').textContent = '';
    $('#load-more').hidden = true;
    return;
  }

  // Films and series get artwork cards; channels stay a compact list.
  const grid = usesGrid();
  ul.classList.toggle('grid', grid);
  document.body.classList.toggle('grid-mode', grid);   // artwork wants a wider column

  const html = slice
    .map((row, i) => {
      const idx = state.shown + i;
      if (grid) return cardMarkup(row, idx, itemKind(row));

      const name = row.name || row.title || 'Untitled';
      const logo = row.stream_icon || row.cover || row.icon || '';
      const kind = itemKind(row);
      const meta =
        kind === 'live'
          ? row.epg_channel_id || ''
          : [row.year, row.rating ? `★ ${row.rating}` : ''].filter(Boolean).join(' · ');

      // how far through a movie you got last time
      const seen = kind === 'movie' ? resume.get('movie', row.stream_id || row.id) : null;
      const progress = seen && seen.duration
        ? `<span class="item-progress"><i style="width:${Math.min(100, (seen.position / seen.duration) * 100).toFixed(0)}%"></i></span>`
        : '';

      return `<li>
        <button class="item" data-idx="${idx}">
          ${logo ? `<img loading="lazy" src="${esc(logo)}" alt="" onerror="this.remove()" />` : '<span class="ph"></span>'}
          <span class="item-text"><span class="item-name">${esc(name)}</span>
          ${meta ? `<span class="item-meta">${esc(meta)}</span>` : ''}${progress}</span>
        </button></li>`;
    })
    .join('');

  ul.insertAdjacentHTML('beforeend', html);
  state.shown += slice.length;
  $('#item-count').textContent = `${state.shown} of ${rows.length}`;
  $('#load-more').hidden = state.shown >= rows.length;

  ul.querySelectorAll('.item:not([data-bound])').forEach((b) => {
    b.dataset.bound = '1';
    b.addEventListener('click', () => {
      ul.querySelectorAll('.item').forEach((x) => x.classList.remove('playing'));
      b.classList.add('playing');
      open(visibleItems()[Number(b.dataset.idx)]);
      scrollPlayerIntoView();
    });
  });
}

$('#load-more').addEventListener('click', renderMore);
$('#item-list').addEventListener('scroll', (e) => {
  const el = e.target;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 300 && !$('#load-more').hidden) renderMore();
});

/* ── opening an item ──────────────────────────────────────── */

async function open(row) {
  if (!row) return;
  const kind = itemKind(row);

  // In multiview a channel goes into the grid; anything on demand leaves it.
  if (mv.active) {
    if (kind === 'live') {
      addTile(channelOf(row));
      return;
    }
    exitMultiview(false);
  }

  if (kind === 'series') {
    const id = row.series_id || row.id;
    showMeta({ title: row.name || row.title, logo: row.cover || row.stream_icon, sub: [row.year, row.genre].filter(Boolean).join(' · ') });
    $('#now-detail').innerHTML = '<div class="loading">Loading episodes…</div>';
    $('#fav-toggle').hidden = false;
    setFavButton({ kind: 'series', id, name: row.name || row.title, cover: row.cover, series_id: id });
    $('#copy-url').hidden = true;
    try {
      const info = await api('get_series_info', { series_id: id });
      renderSeries(row, info);
    } catch (ex) {
      $('#now-detail').innerHTML = `<div class="error-row">${esc(ex.message || ex)}</div>`;
    }
    return;
  }

  if (kind === 'live') {
    const id = row.stream_id || row.id;
    play('live', id, null, {
      title: row.name || row.title,
      logo: row.stream_icon || row.cover,
      sub: 'Live',
      fav: { kind: 'live', id, name: row.name || row.title, stream_icon: row.stream_icon },
    });
    loadEpg(id);
    return;
  }

  // movie
  const id = row.stream_id || row.id;
  play('movie', id, row.container_extension, {
    title: row.name || row.title,
    logo: row.stream_icon || row.cover,
    sub: [row.year, row.container_extension?.toUpperCase()].filter(Boolean).join(' · '),
    fav: { kind: 'movie', id, name: row.name || row.title, stream_icon: row.stream_icon, container_extension: row.container_extension },
  });
  try {
    const info = await api('get_vod_info', { vod_id: id });
    const d = info?.info || {};
    $('#now-detail').innerHTML = `
      ${d.movie_image ? `<img class="poster" src="${esc(d.movie_image)}" alt="" onerror="this.remove()" />` : ''}
      <div class="meta-block">
        ${d.genre ? `<div><b>Genre</b> ${esc(d.genre)}</div>` : ''}
        ${d.releasedate ? `<div><b>Released</b> ${esc(d.releasedate)}</div>` : ''}
        ${d.duration ? `<div><b>Duration</b> ${esc(d.duration)}</div>` : ''}
        ${d.rating ? `<div><b>Rating</b> ${esc(d.rating)}</div>` : ''}
        ${d.plot ? `<p>${esc(d.plot)}</p>` : ''}
      </div>`;
  } catch {
    $('#now-detail').innerHTML = '';
  }
}

function renderSeries(row, info) {
  const eps = info?.episodes || {};
  const seasons = Object.keys(eps).sort((a, b) => Number(a) - Number(b));
  if (!seasons.length) {
    $('#now-detail').innerHTML = '<div class="loading">No episodes listed for this series.</div>';
    return;
  }

  const plot = info?.info?.plot ? `<p>${esc(info.info.plot)}</p>` : '';
  const html =
    plot +
    seasons
      .map((s) => {
        const list = (eps[s] || [])
          .map(
            (ep) =>
              `<li><button class="episode" data-id="${esc(ep.id)}" data-ext="${esc(ep.container_extension || 'mp4')}" data-title="${esc(row.name || '')} · S${esc(s)}E${esc(ep.episode_num)} ${esc(ep.title || '')}">
                 <b>E${esc(ep.episode_num)}</b> ${esc(ep.title || 'Episode ' + ep.episode_num)}
               </button></li>`
          )
          .join('');
        return `<details class="season" ${s === seasons[0] ? 'open' : ''}><summary>Season ${esc(s)} <span class="muted small">${(eps[s] || []).length} episodes</span></summary><ul class="episodes">${list}</ul></details>`;
      })
      .join('');

  $('#now-detail').innerHTML = html;
  $('#now-detail')
    .querySelectorAll('.episode')
    .forEach((b) =>
      b.addEventListener('click', () => {
        $('#now-detail').querySelectorAll('.episode').forEach((x) => x.classList.remove('playing'));
        b.classList.add('playing');
        play('series', b.dataset.id, b.dataset.ext, {
          title: b.dataset.title,
          logo: row.cover || row.stream_icon,
          sub: 'Episode',
          keepDetail: true,
        });
      })
    );
}

async function loadEpg(streamId) {
  // Moving between multiview tiles fires these quickly; only the newest may paint.
  const seq = (loadEpg.seq = (loadEpg.seq || 0) + 1);
  $('#now-detail').innerHTML = '<div class="loading">Loading guide…</div>';
  try {
    const data = await api('get_short_epg', { stream_id: streamId, limit: 8 });
    if (seq !== loadEpg.seq) return;
    const list = data?.epg_listings || [];
    if (!list.length) {
      $('#now-detail').innerHTML = '<div class="loading">No EPG data for this channel.</div>';
      return;
    }
    const fmt = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '');
    $('#now-detail').innerHTML =
      '<ul class="epg">' +
      list
        .map(
          (e, i) => `<li class="${i === 0 ? 'live-now' : ''}">
            <span class="epg-time">${esc(fmt(e.start))}</span>
            <span class="epg-body"><b>${esc(b64(e.title))}</b>${e.description ? `<span>${esc(b64(e.description))}</span>` : ''}</span>
          </li>`
        )
        .join('') +
      '</ul>';
  } catch (ex) {
    if (seq !== loadEpg.seq) return;
    $('#now-detail').innerHTML = `<div class="error-row">${esc(ex.message || ex)}</div>`;
  }
}

/* ── playback ─────────────────────────────────────────────── */

function stopPlayback() {
  const video = $('#video');
  // Switching away clears currentTime, so bank the position first.
  if (typeof saveResumeNow === 'function') saveResumeNow();
  state.engine?.destroy();
  state.engine = null;
  video.removeAttribute('src');
  video.load();
}

/**
 * Attach a live stream to a <video>, as HLS or MPEG-TS per the login's format.
 * Shared by the main player and the multiview tiles. Returns a handle whose
 * destroy() releases the connection, or null when the browser plays it natively.
 */
function attachLive(video, src, profile, fail) {
  if (state.creds.fmt === 'm3u8') {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls(profile.hls);
      // Attaching reloads the element, which can abort the play() below before
      // anything has arrived - several streams starting at once reliably hit it.
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else fail(`${data.details || data.type}`);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      video.play().catch(() => {});
      return { destroy: () => hls.destroy() };
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
    } else {
      fail('This browser cannot play HLS.');
    }
    return null;
  }

  if (window.mpegts && mpegts.isSupported()) {
    const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src }, profile.ts);
    p.on(mpegts.Events.ERROR, (type, detail) => fail(`${type} ${detail || ''}`));
    p.attachMediaElement(video);
    p.load();
    p.play()?.catch?.(() => {});
    return {
      destroy() {
        try {
          p.pause();
          p.unload();
          p.detachMediaElement();
          p.destroy();
        } catch {}
      },
    };
  }
  fail('MPEG-TS playback is not supported in this browser. Switch the live format to HLS.');
  return null;
}

function showMeta({ title, logo, sub }) {
  setTimeout(syncDetailCollapse, 0);
  $('#now-title').textContent = title || 'Nothing playing';
  $('#now-sub').textContent = sub || '';
  const img = $('#now-logo');
  if (logo) {
    img.src = logo;
    img.hidden = false;
    img.onerror = () => (img.hidden = true);
  } else {
    img.hidden = true;
  }
}

function setFavButton(fav) {
  const btn = $('#fav-toggle');
  if (!fav) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const paint = () => (btn.textContent = favs.has(fav) ? '★ Favourited' : '☆ Favourite');
  paint();
  btn.onclick = () => {
    favs.toggle(fav);
    paint();
    if (state.section === 'favorites') {
      state.items = favs.read();
      resetList();
    }
  };
}

let playGen = 0;

function play(kind, id, ext, meta = {}) {
  stopPlayback();
  const gen = ++playGen; // ignore late events from a stream we've already switched away from
  const video = $('#video');
  const overlay = $('#video-overlay');
  const url = directUrl(kind, id, ext);
  const src = proxied(url);

  state.now = { kind, id, ext, url, meta, startedAt: Date.now() };
  state.stalls = 0;
  state.started = false;
  showMeta(meta);
  setFavButton(meta.fav || null);
  $('#copy-url').hidden = false;
  $('#copy-url').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Direct URL copied - paste it into VLC if a format will not play here.');
    } catch {
      prompt('Copy this URL:', url);
    }
  };
  if (!meta.keepDetail) $('#now-detail').innerHTML = '';

  overlay.hidden = false;
  overlay.textContent = 'Connecting…';

  const clearOverlay = () => {
    if (gen === playGen) overlay.hidden = true;
  };
  const fail = (msg) => {
    if (gen !== playGen) return;
    overlay.hidden = false;
    overlay.innerHTML = `<b>Playback failed</b><br>${esc(msg)}<br><span class="small">Try "Copy direct URL" and open it in VLC to confirm the stream itself works.</span>`;
  };

  video.addEventListener('playing', clearOverlay, { once: true });

  if (kind === 'live') {
    state.engine = attachLive(video, src, bufferProfile(), fail);
    return;
  }

  // VOD / series: let the browser handle it, Range requests flow through the proxy.
  video.src = src;
  applyResume(kind, id);
  video.play().catch(() => {});
  video.addEventListener(
    'error',
    () => {
      const e = video.error;
      fail(
        e && e.code === 4
          ? `The browser cannot decode this container (${(ext || '').toUpperCase() || 'unknown'}). MP4 works best; MKV/AVI usually need VLC.`
          : 'The stream could not be loaded.'
      );
    },
    { once: true }
  );
}

/* ── buffering controls + readout ─────────────────────────── */

/** Seconds of media already downloaded ahead of the playhead. */
function bufferAhead(video) {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.currentTime >= video.buffered.start(i) - 0.5 && video.currentTime <= video.buffered.end(i)) {
      return video.buffered.end(i) - video.currentTime;
    }
  }
  return 0;
}

function startStatsReadout() {
  const video = $('#video');
  const el = $('#stats');

  // Only count a rebuffer once playback has actually started - the initial fill
  // fires 'waiting' too, and counting it makes every stream look like it stalled.
  video.addEventListener('playing', () => (state.started = true));
  video.addEventListener('waiting', () => {
    if (state.started) state.stalls = (state.stalls || 0) + 1;
  });

  setInterval(() => {
    if (!state.now || video.readyState === 0) {
      el.hidden = true;
      return;
    }
    // A live stream that sits empty for 12s straight will not recover on its
    // own; rebuild it rather than leaving the user on a frozen frame.
    if (state.now.kind === 'live' && !video.paused && video.readyState < 3) {
      state.dry = (state.dry || 0) + 1;
      if (state.dry >= 12 && Date.now() - (state.lastRecover || 0) > 30000) {
        state.lastRecover = Date.now();
        state.dry = 0;
        toast('Stream stalled - reconnecting.');
        play(state.now.kind, state.now.id, state.now.ext, state.now.meta || {});
        return;
      }
    } else {
      state.dry = 0;
    }

    // A feed that dies mid-stream pauses the element rather than raising an
    // error, which otherwise just leaves a frozen frame and no explanation.
    if (state.now.kind === 'live' && state.started && video.paused && bufferAhead(video) < 0.2) {
      const overlay = $('#video-overlay');
      if (overlay.hidden) {
        overlay.hidden = false;
        overlay.innerHTML = '<b>The stream dropped</b><br>The panel stopped sending data. ' +
          'Pick the channel again to reconnect.';
      }
    }

    const ahead = bufferAhead(video);
    const stalls = state.stalls || 0;
    el.hidden = false;
    el.className = 'stats' + (ahead < 2 ? ' thin' : '');
    el.textContent = `buffer ${ahead.toFixed(1)}s · ${stalls} stall${stalls === 1 ? '' : 's'} · ${bufferProfile().label.split(' (')[0]}`;
  }, 1000);
}

$('#buffer-mode').addEventListener('change', (e) => {
  localStorage.setItem(BUFFER_KEY, e.target.value);
  toast(`Buffering set to ${BUFFER_PROFILES[e.target.value].label}.`);
  if (mv.active) mv.tiles.forEach(startTile);
  const n = state.now;
  if (n) play(n.kind, n.id, n.ext, n.meta || {}); // reload so the new settings take effect
});

/* ── boot ─────────────────────────────────────────────────── */

/** Warn up front if the running process is older than the page it just served. */
async function checkServerVersion() {
  // After an in-app update the Android app runs newer page files than its
  // native side, which is expected - and it has no terminal to restart anyway.
  if (window.AndroidPlatform) return;
  try {
    const res = await fetch('/health');
    const data = await res.json();
    if (data.version === CLIENT_VERSION) return;
    const box = $('#probe-results');
    box.hidden = false;
    box.innerHTML = `<div class="probe-note stale">${esc(STALE_SERVER)}
      <br><span class="small">Page ${esc(CLIENT_VERSION)}, running server ${esc(data.version || 'older than 1.2.0')}.</span></div>`;
  } catch {
    /* server unreachable - the login attempt will report that clearly enough */
  }
}

(function boot() {
  detectPlatform();
  checkServerVersion();
  $('#buffer-mode').value = localStorage.getItem(BUFFER_KEY) || 'smooth';
  startStatsReadout();
  startResumeTracking();
  watchForSlowStart();
  watchTiles();
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {}
  if (!saved) return;

  $('#f-host').value = saved.host || '';
  $('#f-user').value = saved.username || '';
  $('#f-pass').value = saved.password || '';
  $('#f-fmt').value = saved.fmt || 'm3u8';

  connect(saved).catch(showLoginError);
})();

/* ── resume positions ─────────────────────────────────────── */

const RESUME_KEY = 'xtream.resume';
const RESUME_MIN = 30;      // don't bother resuming the first 30s
const RESUME_DONE = 0.95;   // past this fraction, treat it as finished

const resume = {
  all() {
    try {
      return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}');
    } catch {
      return {};
    }
  },
  key: (kind, id) => `${kind}:${id}`,
  get(kind, id) {
    return this.all()[this.key(kind, id)] || null;
  },
  save(kind, id, position, duration) {
    if (!duration || !isFinite(duration)) return;
    const map = this.all();
    const k = this.key(kind, id);
    if (position < RESUME_MIN || position / duration > RESUME_DONE) delete map[k];
    else map[k] = { position: Math.floor(position), duration: Math.floor(duration), at: Date.now() };

    // keep the newest 300 so this cannot grow without bound
    const trimmed = Object.entries(map)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, 300);
    localStorage.setItem(RESUME_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  },
};

/** Write the current position for whatever is playing, ignoring the throttle. */
function saveResumeNow() {
  const video = $('#video');
  const n = state.now;
  if (!n || n.kind === 'live' || !video.duration) return;
  resume.save(n.kind, n.id, video.currentTime, video.duration);
}

function startResumeTracking() {
  const video = $('#video');
  let last = 0;
  video.addEventListener('timeupdate', () => {
    const n = state.now;
    if (!n || n.kind === 'live') return;
    if (Date.now() - last < 5000) return; // throttle writes
    last = Date.now();
    resume.save(n.kind, n.id, video.currentTime, video.duration);
  });

  // The throttle would otherwise miss the last few seconds, so a film watched to
  // the end keeps a stale resume point instead of being cleared as finished.
  video.addEventListener('ended', saveResumeNow);
  video.addEventListener('pause', saveResumeNow);
}

/** Called on play; waits for metadata so duration can sanity-check the position. */
function applyResume(kind, id) {
  const video = $('#video');
  const saved = resume.get(kind, id);
  if (!saved || !saved.position) return;
  const seekTo = () => {
    if (video.duration && saved.position < video.duration - 5) {
      video.currentTime = saved.position;
      const m = Math.floor(saved.position / 60);
      const s = String(Math.floor(saved.position % 60)).padStart(2, '0');
      toast(`Resumed from ${m}:${s}`);
    }
  };
  if (video.readyState >= 1) seekTo();
  else video.addEventListener('loadedmetadata', seekTo, { once: true });
}

/* ── D-pad / remote navigation ────────────────────────────── */

const PANES = ['#cat-list', '#item-list', '.stage'];

function focusablesIn(sel) {
  const root = document.querySelector(sel);
  if (!root) return [];
  return [...root.querySelectorAll('button, [href], input, select, video, details summary')]
    .filter((el) => !el.disabled && el.offsetParent !== null && el.tabIndex >= 0);
}

function currentPaneIndex() {
  const el = document.activeElement;
  for (let i = 0; i < PANES.length; i++) {
    if (el && document.querySelector(PANES[i])?.contains(el)) return i;
  }
  return -1;
}

/** Focus an element and mark it, so the highlight never depends on :focus alone. */
function focusEl(el) {
  if (!el) return;
  document.querySelectorAll('.focused').forEach((x) => x.classList.remove('focused'));
  el.classList.add('focused');
  el.focus();
  el.scrollIntoView({ block: 'nearest' });
}

function focusPane(index) {
  const items = focusablesIn(PANES[index]);
  if (!items.length) return false;
  const target = items.find((el) => el.classList.contains('playing') || el.classList.contains('active')) || items[0];
  focusEl(target);
  return true;
}

/**
 * Arrow keys move within a pane, left/right cross between panes. Enter is left
 * to the browser, which already activates a focused button.
 */
/** Remembers which column to drop back into when leaving the top bar. */
let lastPane = 1;

function inTopbar() {
  return !!document.activeElement && $('.topbar').contains(document.activeElement);
}

function focusTopbar(preferEnd) {
  const items = focusablesIn('.topbar');
  if (!items.length) return false;
  focusEl(preferEnd ? items[items.length - 1] : items[0]);
  return true;
}

document.addEventListener('keydown', (e) => {
  if ($('#app').hidden) return;
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  const onSelect = tag === 'SELECT';

  if ((e.key === 'v' || e.key === 'V') && !typing) {
    e.preventDefault();
    voice.toggle();
    return;
  }

  // The update banner and the diagnostics panel sit outside the three columns;
  // without this the arrows would skip straight past their buttons.
  const overlay = ['#diag-panel', '#update-bar'].map((s) => $(s))
    .find((el) => !el.hidden && el.contains(document.activeElement));
  if (overlay && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    if (overlay.id === 'update-bar' && e.key === 'ArrowDown') {
      focusTopbar(false);
      return;
    }
    const items = focusablesIn('#' + overlay.id);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = items[items.indexOf(document.activeElement) + step];
    if (next) focusEl(next);
    return;
  }

  const isFull = document.body.classList.contains('video-full');

  // In full screen there is nothing to focus, so OK and Escape must work no
  // matter where focus happens to be.
  if (isFull && (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) {
    e.preventDefault();
    setVideoFull(false);
    return;
  }
  // OK on the player enters full screen (desktop, where the video is focusable).
  if (!isFull && (e.key === 'Enter' || e.key === ' ') && document.activeElement === $('#video')) {
    e.preventDefault();
    toggleVideoFull();
    return;
  }

  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // let the caret move
  // A dropdown needs up/down for its own options.
  if (onSelect && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;

  // Full-screen multiview: the arrows move the sound from picture to picture.
  if (isFull && mv.active) {
    e.preventDefault();
    const next = document.body.classList.contains('mv-wide')
      ? tileCycle(mv.selected, e.key)
      : tileNeighbour(mv.selected, e.key);
    if (next !== null) {
      selectTile(next);
      mv.tiles[next].pick.focus();
    }
    return;
  }

  // In full screen the panes are hidden; only leaving it makes sense.
  if (document.body.classList.contains('video-full')) {
    e.preventDefault();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setVideoFull(false);
    return;
  }

  // ── the top bar is a row of its own, above the three columns ──
  if (inTopbar()) {
    const items = focusablesIn('.topbar');
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusPane(lastPane);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      // The update banner, when showing, is the only thing above the top bar.
      const bar = focusablesIn('#update-bar');
      if (bar.length) focusEl(bar[0]);
      return;
    }
    const next = items[at + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      focusEl(next);
    }
    return;
  }

  const pane = currentPaneIndex();
  if (pane === -1) {
    e.preventDefault();
    focusPane(lastPane);
    return;
  }
  lastPane = pane;

  // The multiview grid is two columns, so it needs 2-D movement of its own.
  if (mv.active && $('#multiview').contains(document.activeElement)) {
    const target = gridStep(document.activeElement, e.key);
    if (target) {
      e.preventDefault();
      focusEl(target);
      return;
    }
    if (target === false) {
      e.preventDefault();
      focusTopbar(false);
      return;
    }
  }

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const next = pane + (e.key === 'ArrowRight' ? 1 : -1);
    if (next >= 0 && next < PANES.length && focusPane(next)) {
      lastPane = next;
      e.preventDefault();
    }
    return;
  }

  const items = focusablesIn(PANES[pane]);
  const at = items.indexOf(document.activeElement);
  const next = items[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    focusEl(next);
    // keep the lazy list filling as focus walks toward the bottom
    if (at > items.length - 5 && !$('#load-more').hidden) renderMore();
    return;
  }

  // Nothing above in this column: step up into the top bar.
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusTopbar(false);
  }
});

/* ── voice control ────────────────────────────────────────── */

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Score a spoken phrase against an item name; higher is better, 0 means no match. */
function matchScore(spoken, name) {
  const a = normalise(spoken);
  const b = normalise(name);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (b.startsWith(a)) return 800 - (b.length - a.length);
  if (b.includes(a)) return 600 - (b.length - a.length);

  const words = a.split(' ').filter(Boolean);
  const hits = words.filter((w) => b.includes(w)).length;
  if (!hits) return 0;
  return 200 + (hits / words.length) * 200 - b.length * 0.1;
}

function bestMatch(spoken, rows) {
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = matchScore(spoken, row.name || row.title || '');
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore > 150 ? best : null;
}

async function ensureSection(section) {
  if (state.section !== section) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.section === section));
    await loadSection(section);
  }
}

/** Find and play something by name, searching the given sections in order. */
async function playByName(spoken, sections) {
  for (const section of sections) {
    if (!state.cache[section]) {
      try {
        const rows = await api(LIST_ACTION[section]);
        state.cache[section] = Array.isArray(rows) ? rows : [];
      } catch {
        continue;
      }
    }
    const hit = bestMatch(spoken, state.cache[section]);
    if (hit) {
      await ensureSection(section);
      state.catFilter = 'all';
      state.query = '';
      $('#item-search').value = '';
      renderCategories();
      resetList();
      open(hit);
      return hit.name || hit.title;
    }
  }
  return null;
}

const VOICE_HELP = [
  '"watch CNN" · "put on ESPN"',
  '"bring up movies" · "show series"',
  '"play Top Gun" · "search comedy"',
  '"pause" · "play" · "fullscreen"',
  '"multiview" · "add ESPN"',
];

async function handleVoiceCommand(raw) {
  const text = normalise(raw);
  if (!text) return 'Did not catch that.';

  // transport
  if (/^(pause|stop)$/.test(text)) { activeVideo().pause(); return 'Paused'; }
  if (/^(play|resume|continue)$/.test(text)) { activeVideo().play(); return 'Playing'; }
  if (/^mute$/.test(text)) { activeVideo().muted = true; return 'Muted'; }
  if (/^(unmute|sound on)$/.test(text)) { activeVideo().muted = false; return 'Unmuted'; }
  if (/full ?screen/.test(text)) {
    setVideoFull(true);
    return 'Fullscreen';
  }

  // multiview
  if (/^(exit|close|leave|stop|end) (multi ?view|split screen)$/.test(text)) {
    exitMultiview(true);
    return 'Multiview closed';
  }
  const add = text.match(/^(?:add|also watch|and)\s+(.+)$/);
  if (add) {
    if (!state.cache.live) {
      const rows = await api(LIST_ACTION.live);
      state.cache.live = Array.isArray(rows) ? rows : [];
    }
    const hit = bestMatch(add[1], state.cache.live);
    if (!hit) return `Could not find "${add[1]}"`;
    enterMultiview();
    addTile(channelOf(hit));
    return `Added ${hit.name}`;
  }

  // sections
  const section = text.replace(/^(go to|switch to|open|show|bring up|take me to|display)\s+/, '').trim();
  if (/^(multi ?view|split screen)$/.test(section)) { enterMultiview(); return 'Multiview'; }
  if (/^(wide ?screen|ultra ?wide)( mode)?$/.test(section) && mv.active) { setWideFull(); return 'Widescreen'; }
  if (/^(live|live tv|tv|channels)$/.test(section)) { await ensureSection('live'); return 'Live TV'; }
  if (/^(movies|movie|vod|films|film)$/.test(section)) { await ensureSection('movie'); return 'Movies'; }
  if (/^(series|shows|tv shows|episodes)$/.test(section)) { await ensureSection('series'); return 'Series'; }
  if (/^(favourites|favorites|favourite|favorite)$/.test(section)) { await ensureSection('favorites'); return 'Favourites'; }

  // search box
  const search = text.match(/^(?:search|find|look for)\s+(.+)$/);
  if (search) {
    state.query = search[1];
    $('#item-search').value = search[1];
    resetList();
    return `Searching for "${search[1]}"`;
  }

  // "watch X" / "channel X" - live first
  const channel = text.match(/^(?:watch|put on|tune to|switch to|go to|channel)\s+(.+)$/);
  if (channel) {
    const name = await playByName(channel[1], ['live', 'movie', 'series']);
    return name ? `Playing ${name}` : `Could not find "${channel[1]}"`;
  }

  // "play X" - on-demand first
  const play = text.match(/^(?:play|start)\s+(.+)$/);
  if (play) {
    const name = await playByName(play[1], ['movie', 'series', 'live']);
    return name ? `Playing ${name}` : `Could not find "${play[1]}"`;
  }

  // bare name: try everything
  const name = await playByName(text, ['live', 'movie', 'series']);
  return name ? `Playing ${name}` : `Not sure what "${raw}" means. Try ${VOICE_HELP[0]}`;
}

/**
 * Speech input. Android WebView has no Web Speech API, so the APK injects a
 * native bridge (window.AndroidVoice) driving Android's SpeechRecognizer, which
 * calls back into onVoiceResult. Desktop browsers use webkitSpeechRecognition.
 */
const voice = {
  recog: null,
  listening: false,

  available() {
    return !!(window.AndroidVoice || window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  hud(text, kind = '') {
    const el = $('#voice-hud');
    el.hidden = false;
    el.className = 'voice-hud ' + kind;
    el.innerHTML = text;
    clearTimeout(this._t);
    if (kind !== 'listening') this._t = setTimeout(() => (el.hidden = true), 3200);
  },

  toggle() {
    if (this.listening) this.stop();
    else this.start();
  },

  start() {
    if (!this.available()) {
      this.hud('Voice input is not available here.<br><span class="small">It works in the Android app and in Chrome.</span>');
      return;
    }
    this.listening = true;
    $('#mic').classList.add('live');
    $('#mic-label').textContent = 'Listening…';
    this.hud('<b>Listening…</b><br><span class="small">' + VOICE_HELP.join('<br>') + '</span>', 'listening');

    if (window.AndroidVoice) {
      window.AndroidVoice.start();
      return;
    }
    const Recog = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new Recog();
    this.recog = r;
    r.lang = navigator.language || 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => window.onVoiceResult(e.results[0][0].transcript);
    r.onerror = (e) => window.onVoiceError(e.error);
    r.onend = () => this.reset();
    r.start();
  },

  stop() {
    try {
      if (window.AndroidVoice) window.AndroidVoice.stop();
      else this.recog?.stop();
    } catch {}
    this.reset();
  },

  reset() {
    this.listening = false;
    $('#mic').classList.remove('live');
    $('#mic-label').textContent = 'Voice';
  },
};

// Both the native bridge and the browser path funnel through these.
window.onVoiceResult = async (transcript) => {
  voice.reset();
  voice.hud(`<b>&ldquo;${esc(transcript)}&rdquo;</b><br><span class="small">working…</span>`);
  try {
    const result = await handleVoiceCommand(transcript);
    voice.hud(`<b>&ldquo;${esc(transcript)}&rdquo;</b><br><span class="small">${esc(result)}</span>`);
  } catch (ex) {
    voice.hud(`<b>&ldquo;${esc(transcript)}&rdquo;</b><br><span class="small">${esc(ex.message || ex)}</span>`);
  }
};

window.onVoiceError = (err) => {
  voice.reset();
  const friendly = {
    'not-allowed': 'Microphone permission was denied.',
    'no-speech': 'Did not hear anything.',
    'audio-capture': 'No microphone found.',
    network: 'Speech recognition needs a network connection.',
  };
  voice.hud(friendly[err] || `Voice error: ${esc(err)}`);
};

$('#mic').addEventListener('click', () => voice.toggle());

/* ── diagnostics ──────────────────────────────────────────────
 * On a phone there is no terminal, so the proxy's recent activity has to be
 * readable inside the app. Credentials are stripped server-side before they
 * reach this list.
 */

async function showDiagnostics() {
  const panel = $('#diag-panel');
  panel.hidden = false;
  panel.innerHTML = '<div class="diag-head"><b>Diagnostics</b><button id="diag-close" class="ghost">Close</button></div><div class="loading">Loading…</div>';
  $('#diag-close').addEventListener('click', () => (panel.hidden = true));

  let lines = [];
  let health = {};
  try {
    health = (await localJson('/health')).data;
    lines = (await localJson('/log')).data.lines || [];
  } catch (ex) {
    lines = [`Could not read the log: ${ex.message || ex}`];
  }

  const body = lines.length
    ? lines.slice().reverse().map((l) => {
        const bad = /403|502|FAIL|blocked|no-api|5\d\d/.test(l);
        return `<div class="diag-line${bad ? ' bad' : ''}">${esc(l)}</div>`;
      }).join('')
    : '<div class="loading">Nothing logged yet. Try playing a channel, then reopen this.</div>';

  panel.innerHTML =
    `<div class="diag-head"><b>Diagnostics</b>
       <span class="muted small">player ${esc(health.version || '?')} · page ${esc(CLIENT_VERSION)} · ${esc(state.platform || '?')}${window.AndroidPlatform ? ' (app)' : ''}</span>
       <button id="diag-close" class="ghost">Close</button></div>
     <div id="update-settings" class="update-settings"></div>
     <div class="diag-body">${body}</div>`;
  $('#diag-close').addEventListener('click', () => (panel.hidden = true));
  renderUpdateSettings();
  if (!updates.info) runUpdateCheck();
  if (state.platform === 'tv') focusEl($('#update-check') || $('#diag-close'));
}

$('#diag').addEventListener('click', showDiagnostics);

/**
 * A live stream that never starts otherwise sits on "Connecting…" forever,
 * because hls.js retries fragments many times before it calls an error fatal.
 * Say something after 12s and point at the log.
 */
function watchForSlowStart() {
  setInterval(() => {
    const n = state.now;
    if (!n || n.kind !== 'live' || state.started) return;
    if (!n.startedAt || Date.now() - n.startedAt < 12000) return;
    if (n.warned) return;
    n.warned = true;

    const overlay = $('#video-overlay');
    overlay.hidden = false;
    overlay.innerHTML =
      '<b>Still connecting</b><br>The playlist loaded but the video segments are not arriving.' +
      '<br><span class="small">Open Diagnostics in the top bar to see what the panel returned.</span>';
  }, 2000);
}

/* ── platform shell ───────────────────────────────────────────
 * Three shells off one document: phone (bottom nav, stacked, sticky player),
 * TV (10-foot, overscan-safe, focus-driven) and desktop (three panes).
 */

function detectPlatform() {
  let tv = false;
  let nativeApp = false;
  try {
    if (window.AndroidPlatform) {
      nativeApp = true;
      tv = !!window.AndroidPlatform.isTv();
    }
  } catch {
    /* bridge missing or threw - fall through to sniffing */
  }
  if (!nativeApp) {
    // Fire TV reports AFT*, Shield reports SHIELD; the rest cover other boxes.
    tv = /AFT[A-Z]|SHIELD|BRAVIA|GoogleTV|Android TV|SmartTV|Web0S|Tizen|CrKey/i.test(navigator.userAgent);
  }

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const shortEdge = Math.min(window.innerWidth, window.innerHeight);
  const phone = !tv && (coarse || shortEdge < 620) && shortEdge < 820;

  state.platform = tv ? 'tv' : phone ? 'phone' : 'desktop';
  document.body.classList.toggle('tv', tv);
  document.body.classList.toggle('phone', phone);
  document.body.classList.toggle('desktop', !tv && !phone);
  document.body.classList.toggle('native', nativeApp);
  if (document.getElementById('playpause')) applyPlayerControls();
}

window.addEventListener('resize', () => {
  const before = state.platform;
  detectPlatform();
  if (before !== state.platform) resetList(); // card size depends on the shell
});

/* ── on-demand poster grid ────────────────────────────────────
 * Channel logos are small and wide, so live stays a list. Films and series
 * have real artwork, which is the difference between this looking like a
 * directory listing and looking like an app.
 */

function usesGrid() {
  if (state.section === 'movie' || state.section === 'series') return true;
  if (state.section === 'favorites') {
    return favs.read().some((f) => f.kind === 'movie' || f.kind === 'series');
  }
  return false;
}

function cardMarkup(row, idx, kind) {
  const name = row.name || row.title || 'Untitled';
  const art = row.cover || row.stream_icon || row.icon || '';
  const meta = [row.year, row.rating ? `★ ${row.rating}` : ''].filter(Boolean).join(' · ');

  const seen = kind === 'movie' ? resume.get('movie', row.stream_id || row.id) : null;
  const progress = seen && seen.duration
    ? `<span class="card-progress"><i style="width:${Math.min(100, (seen.position / seen.duration) * 100).toFixed(0)}%"></i></span>`
    : '';

  return `<li>
    <button class="item card" data-idx="${idx}">
      <span class="card-art">
        ${art ? `<img loading="lazy" src="${esc(art)}" alt="" onerror="this.closest('.card-art').classList.add('noart')" />` : ''}
        <span class="card-fallback">${esc(name.slice(0, 2).toUpperCase())}</span>
        ${progress}
      </span>
      <span class="card-title">${esc(name)}</span>
      ${meta ? `<span class="card-meta">${esc(meta)}</span>` : ''}
    </button></li>`;
}

/* ── phone: collapsible detail ────────────────────────────────
 * EPG text and plots would push the channel list off a phone screen, so they
 * fold away. Episodes are the exception - that list is the point of opening
 * a series.
 */

function syncDetailCollapse() {
  const detail = $('#now-detail');
  if (state.platform !== 'phone') {
    detail.classList.remove('collapsed');
    $('#now-head-toggle')?.setAttribute('hidden', '');
    return;
  }
  const isSeries = state.now?.kind === 'series' || detail.querySelector('.season');
  detail.classList.toggle('collapsed', !isSeries);
  $('#now-head-toggle')?.removeAttribute('hidden');
}

$('.now-head').addEventListener('click', (e) => {
  if (state.platform !== 'phone') return;
  if (e.target.closest('button')) return;   // let the fav / copy buttons work
  $('#now-detail').classList.toggle('collapsed');
});

/* Keep the player in view when something starts on a phone. */
function scrollPlayerIntoView() {
  if (state.platform !== 'phone') return;
  $('.stage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Shimmer placeholders read as "loading" far better than the word does. */
function skeletonRows(n) {
  return Array.from({ length: n }, () =>
    '<li class="skeleton-row"><span class="skeleton"></span><span class="skeleton"></span></li>'
  ).join('');
}

/**
 * Mirror focus onto a class. Some TV WebViews are unreliable about :focus
 * styling, and the highlight is the only way to know where you are on a remote,
 * so it must not depend solely on the pseudo-class.
 */
document.addEventListener('focusin', (e) => {
  document.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));
  if (e.target && e.target !== document.body) e.target.classList.add('focused');
});
document.addEventListener('focusout', (e) => {
  e.target?.classList?.remove('focused');
});

/* ── full screen ──────────────────────────────────────────────
 * Deliberately CSS-driven rather than the Fullscreen API. In a TV WebView
 * requestFullscreen depends on the host app implementing onShowCustomView and
 * on a gesture the remote may not produce; expanding the video to fill the
 * window always works. A history entry is pushed so the remote's Back button
 * leaves full screen instead of leaving the app.
 */

function setVideoFull(on) {
  const already = document.body.classList.contains('video-full');
  if (on === already) return;
  if (on && mv.active && !mv.tiles.length) {
    toast('Add a channel to multiview first.');
    return;
  }
  document.body.classList.toggle('video-full', on);

  if (on) {
    history.pushState({ videoFull: true }, '');
    if (mv.active) mv.tiles[mv.selected]?.pick.focus();
    else $('#video').focus();
  } else {
    document.body.classList.remove('mv-wide');
    if (history.state && history.state.videoFull) history.back();   // popstate clears the class
  }
  $('#fullscreen').textContent = on ? '⤡ Exit full screen' : '⤢ Full screen';
}

/**
 * Widescreen multiview, for 21:9 monitors like 3440×1440: the tile with sound
 * fills a 16:9 area at full height and the others stack beside it at a third
 * the size. Choosing another tile swaps which one is big.
 */
function setWideFull() {
  if (document.body.classList.contains('video-full')) return;
  document.body.classList.add('mv-wide');
  setVideoFull(true);
  // refused (no tiles yet): don't leave the layout armed for a later full screen
  if (!document.body.classList.contains('video-full')) document.body.classList.remove('mv-wide');
}

function toggleVideoFull() {
  setVideoFull(!document.body.classList.contains('video-full'));
}

window.addEventListener('popstate', () => {
  document.body.classList.remove('video-full', 'mv-wide');
  $('#fullscreen').textContent = '⤢ Full screen';
});

$('#fullscreen').addEventListener('click', toggleVideoFull);
$('#mv-wide').addEventListener('click', setWideFull);

// Double-click / double-tap the picture, as in any other player.
$('#video').addEventListener('dblclick', toggleVideoFull);

/* ── TV: our own transport controls ───────────────────────────
 * A <video controls> element swallows the D-pad: once focus lands on it the
 * browser's own media controls own every arrow key, so the buttons underneath
 * become unreachable. On a TV we turn the native controls off, take the video
 * out of the focus order entirely, and drive it from ordinary buttons that
 * remote navigation already understands.
 */

function applyPlayerControls() {
  const video = $('#video');
  const tv = state.platform === 'tv';
  video.controls = !tv;
  video.tabIndex = tv ? -1 : 0;
  $('#playpause').hidden = !tv;
}

/** The picture the transport controls act on: the tile with sound, in multiview. */
function activeVideo() {
  return (mv.active && mv.tiles[mv.selected]?.video) || $('#video');
}

function syncPlayPauseLabel() {
  const v = activeVideo();
  $('#playpause').textContent = v.paused ? '▶ Play' : '⏸ Pause';
}

$('#playpause').addEventListener('click', () => {
  const v = activeVideo();
  if (v.paused) v.play().catch(() => {});
  else v.pause();
});
$('#video').addEventListener('play', syncPlayPauseLabel);
$('#video').addEventListener('pause', syncPlayPauseLabel);

/* ── multiview ────────────────────────────────────────────────
 * Up to four live channels at once. Every tile is its own <video> with its own
 * hls.js / mpegts.js instance through the same relay, which also makes every
 * tile its own connection on the line - most subscriptions cap that, so the
 * limit the panel reports is shown. Only the selected tile has sound.
 *
 * Tiles are never moved once in the grid: taking a playing <video> out of the
 * document pauses it, so tiles are inserted, swapped in place, or removed.
 */

/** The fields a tile needs, from a live row or a saved favourite. */
function channelOf(row) {
  const id = row.stream_id || row.id;
  const name = row.name || row.title || 'Channel';
  return { id, name, logo: row.stream_icon || row.cover, fav: { kind: 'live', id, name, stream_icon: row.stream_icon } };
}

/**
 * The chosen buffering profile, trimmed. Four pictures each holding a minute of
 * video is enough to run a streaming stick out of memory, and a quarter-screen
 * tile gains nothing from a stream variant bigger than itself.
 */
function tileProfile() {
  const p = bufferProfile();
  return {
    hls: {
      ...p.hls,
      maxBufferLength: Math.min(p.hls.maxBufferLength || 30, 20),
      maxMaxBufferLength: 30,
      maxBufferSize: 30 * 1000 * 1000,
      backBufferLength: 10,
      capLevelToPlayerSize: true,
    },
    ts: { ...p.ts, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 10 },
  };
}

function mvCountNote() {
  const max = state.maxConnections;
  const base = `${mv.tiles.length} of ${MV_MAX} on screen`;
  return max ? `${base} · your line allows ${max} connection${max === 1 ? '' : 's'}` : base;
}

/** Only a tile beyond the line's connection count is the likely casualty. */
function connectionHint(t) {
  const max = state.maxConnections;
  return max && mv.tiles.indexOf(t) >= max
    ? `<br><span class="small">Your line allows ${max} connection${max === 1 ? '' : 's'}, so the provider is probably refusing this one.</span>`
    : '';
}

function showEmptyMultiview() {
  mv.epgFor = null;
  showMeta({ title: 'Multiview', sub: `Pick up to ${MV_MAX} channels from the list.` });
  setFavButton(null);
  $('#now-detail').innerHTML = '';
}

function enterMultiview() {
  if (mv.active) return;
  const n = state.now;
  const seed = n && n.kind === 'live' ? { id: n.id, name: n.meta.title, logo: n.meta.logo, fav: n.meta.fav } : null;

  stopPlayback();                 // frees the connection the first tile is about to need
  state.now = null;
  mv.active = true;
  mv.epgFor = null;
  document.body.classList.add('multiview');
  $('#multiview').hidden = false;
  $('#copy-url').hidden = true;
  $('#mv-toggle').textContent = '✕ Exit multiview';
  $('#mv-wide').hidden = false;

  if (seed) {
    addTile(seed);
    toast('Pick more channels from the list to add them.');
  } else {
    layoutMultiview();
    showEmptyMultiview();
    toast(`Pick channels from the list - up to ${MV_MAX}.`);
  }
}

/** Leave multiview. By default the tile with sound carries on in the normal player. */
function exitMultiview(keepSelected = true) {
  if (!mv.active) return;
  const keep = keepSelected ? mv.tiles[mv.selected] : null;
  setVideoFull(false);
  mv.tiles.forEach(teardownTile);
  mv.tiles = [];
  mv.selected = 0;
  mv.active = false;
  document.body.classList.remove('multiview');
  $('#multiview').hidden = true;
  $('#mv-toggle').textContent = '⊞ Multiview';
  $('#mv-remove').hidden = true;
  $('#mv-wide').hidden = true;

  if (keep) {
    play('live', keep.id, null, { title: keep.name, logo: keep.logo, sub: 'Live', fav: keep.fav });
    loadEpg(keep.id);
  } else {
    showMeta({});
    setFavButton(null);
    $('#now-detail').innerHTML = '';
    const overlay = $('#video-overlay');
    overlay.hidden = false;
    overlay.textContent = 'Pick something on the left to start watching.';
  }
}

function createTile(ch) {
  const el = document.createElement('div');
  el.className = 'mv-tile';
  el.innerHTML = `
    <video playsinline muted preload="none" tabindex="-1"></video>
    <div class="mv-status">Connecting…</div>
    <button class="mv-pick" type="button" aria-label="${esc(ch.name)}">
      <span class="mv-label">${ch.logo ? `<img src="${esc(ch.logo)}" alt="" onerror="this.remove()" />` : ''}<span class="mv-name">${esc(ch.name)}</span></span>
      <span class="mv-audio" aria-hidden="true"></span>
    </button>
    <button class="mv-close" type="button" tabindex="-1" title="Remove from multiview" aria-label="Remove ${esc(ch.name)}">✕</button>`;

  const t = {
    ...ch,
    el,
    video: el.querySelector('video'),
    pick: el.querySelector('.mv-pick'),
    status: el.querySelector('.mv-status'),
    engine: null,
    gen: 0,
  };

  t.video.addEventListener('playing', () => {
    t.started = true;
    setTileStatus(t, '');
  });
  const syncIfSelected = () => t === mv.tiles[mv.selected] && syncPlayPauseLabel();
  t.video.addEventListener('play', syncIfSelected);
  t.video.addEventListener('pause', syncIfSelected);

  // First press moves the sound here. On a remote, OK again goes full screen;
  // with a mouse or finger that's a double-click / double-tap, as on the main player.
  t.pick.addEventListener('click', () => {
    const i = mv.tiles.indexOf(t);
    if (i !== mv.selected) selectTile(i);
    else if (state.platform === 'tv') toggleVideoFull();
  });
  t.pick.addEventListener('dblclick', toggleVideoFull);
  el.querySelector('.mv-close').addEventListener('click', (e) => {
    e.stopPropagation();
    removeTile(mv.tiles.indexOf(t));
  });
  return t;
}

function setTileStatus(t, html) {
  t.status.hidden = !html;
  t.status.innerHTML = html || '';
}

function startTile(t) {
  t.engine?.destroy();
  t.video.removeAttribute('src');
  t.video.load();
  const gen = ++t.gen;
  Object.assign(t, { engine: null, started: false, startedAt: Date.now(), dry: 0, warned: false });
  setTileStatus(t, 'Connecting…');

  const fail = (msg) => {
    if (gen !== t.gen) return;
    setTileStatus(t, `<b>Could not play</b><br>${esc(msg)}${connectionHint(t)}`);
  };
  t.engine = attachLive(t.video, proxied(directUrl('live', t.id)), tileProfile(), fail);
}

function teardownTile(t) {
  t.gen++;                        // late errors from this stream are no longer ours
  t.engine?.destroy();
  t.engine = null;
  t.video.removeAttribute('src');
  t.video.load();
  t.el.remove();
}

function addTile(ch) {
  const dupe = mv.tiles.findIndex((t) => String(t.id) === String(ch.id));
  if (dupe >= 0) {
    selectTile(dupe);
    toast(`${ch.name} is already on screen.`);
    return;
  }

  const t = createTile(ch);
  if (mv.tiles.length >= MV_MAX) {
    // Full grid: the tile with sound is the one that changes, like flipping its channel.
    const old = mv.tiles[mv.selected];
    old.el.replaceWith(t.el);
    teardownTile(old);
    mv.tiles[mv.selected] = t;
    toast(`Swapped ${old.name} for ${ch.name}.`);
  } else {
    $('#multiview').insertBefore(t.el, $('#mv-add'));
    mv.tiles.push(t);
  }

  startTile(t);
  layoutMultiview();
  selectTile(mv.selected);        // re-applies sound, so the new tile stays muted unless it's selected

  const max = state.maxConnections;
  if (max && mv.tiles.length > max) {
    toast(`Your line allows ${max} connection${max === 1 ? '' : 's'} - your provider may refuse this channel or cut off another.`, 5000);
  }
}

function removeTile(i) {
  const t = mv.tiles[i];
  if (!t) return;
  teardownTile(t);
  mv.tiles.splice(i, 1);
  if (i < mv.selected) mv.selected--;
  mv.selected = Math.min(mv.selected, Math.max(0, mv.tiles.length - 1));
  layoutMultiview();

  if (mv.tiles.length) {
    selectTile(mv.selected);
  } else {
    setVideoFull(false);
    showEmptyMultiview();
  }
}

function selectTile(i) {
  const t = mv.tiles[i];
  if (!t) return;
  mv.selected = i;
  mv.tiles.forEach((x, j) => {
    x.el.classList.toggle('selected', j === i);
    x.video.muted = j !== i;
  });
  showMeta({ title: t.name, logo: t.logo, sub: `Multiview · ${mvCountNote()}` });
  setFavButton(t.fav);
  syncPlayPauseLabel();
  if (mv.epgFor !== t.id) {
    mv.epgFor = t.id;
    loadEpg(t.id);
  }
}

function layoutMultiview() {
  const count = mv.tiles.length;
  $('#multiview').dataset.tiles = count;
  $('#mv-add').hidden = count >= MV_MAX;
  $('#mv-add-note').textContent = mvCountNote();
  $('#mv-remove').hidden = !count;
}

/** The main player's stall rules, applied to each tile. */
function watchTiles() {
  setInterval(() => {
    if (!mv.active) return;
    for (const t of mv.tiles) {
      if (!t.started) {
        // Video has arrived but nothing is playing: a start that got cancelled.
        if (t.video.paused && t.video.readyState >= 3) t.video.play().catch(() => {});
        if (!t.warned && Date.now() - t.startedAt > 15000) {
          t.warned = true;
          setTileStatus(t, '<b>Still connecting</b>' +
            (connectionHint(t) || '<br><span class="small">The provider has not started sending this channel.</span>'));
        }
        continue;
      }
      // Browsers pause silent video to save power (a muted tile counts as
      // silent). Nobody can pause a muted tile on purpose, so start it again.
      if (t.video.paused && t !== mv.tiles[mv.selected] && !document.hidden) {
        t.video.play().catch(() => {});
      }
      // Twelve seconds dry on a live feed will not fix itself; rebuild the tile.
      if (!t.video.paused && t.video.readyState < 3) {
        t.dry += 2;
        if (t.dry >= 12 && Date.now() - (t.lastRecover || 0) > 30000) {
          t.lastRecover = Date.now();
          startTile(t);
        }
      } else {
        t.dry = 0;
      }
    }
  }, 2000);
}

/** Tile index an arrow key moves to in the two-column grid, or null. */
function tileNeighbour(i, key) {
  const n = mv.tiles.length;
  let j = null;
  if (key === 'ArrowLeft' && i % 2 === 1) j = i - 1;
  if (key === 'ArrowRight' && i % 2 === 0) j = i + 1;
  if (key === 'ArrowUp') j = i - 2;
  if (key === 'ArrowDown') j = i + 2 < n ? i + 2 : i < 2 && n > 2 ? n - 1 : null;
  return j !== null && j >= 0 && j < n ? j : null;
}

/** Widescreen has one big tile, not a grid: right/down is the next tile, left/up the previous. */
function tileCycle(i, key) {
  const n = mv.tiles.length;
  if (n < 2) return null;
  return key === 'ArrowRight' || key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
}

/**
 * D-pad movement inside the grid (outside full screen). Returns the element to
 * focus, false to go up into the top bar, or null to let normal pane
 * navigation handle the key (left out of the grid goes back to the list).
 */
function gridStep(el, key) {
  const grid = $('#multiview');
  const cells = [...grid.children].filter((c) => !c.hidden).map((c) => c.querySelector('.mv-pick') || c);
  const j = cells.indexOf(el);
  if (j < 0) return null;
  const row = Math.floor(j / 2);
  const lastRow = Math.floor((cells.length - 1) / 2);

  if (key === 'ArrowLeft') return j % 2 === 1 ? cells[j - 1] : null;
  if (key === 'ArrowRight') return j % 2 === 0 && cells[j + 1] ? cells[j + 1] : null;
  if (key === 'ArrowUp') return row > 0 ? cells[j - 2] : false;
  if (row < lastRow) return cells[j + 2] || cells[cells.length - 1];
  return focusablesIn('.stage').find((x) => !grid.contains(x)) || null;
}

$('#mv-toggle').addEventListener('click', () => (mv.active ? exitMultiview(true) : enterMultiview()));
$('#mv-remove').addEventListener('click', () => removeTile(mv.selected));
$('#mv-add').addEventListener('click', async () => {
  if (state.section !== 'live' && state.section !== 'favorites') await ensureSection('live');
  toast('Pick a channel to add it.');
  if (state.platform === 'phone') $('.items').scrollIntoView({ behavior: 'smooth', block: 'start' });
  else focusPane(1);
});

/* ── updates ──────────────────────────────────────────────────
 * Both builds answer /update/status. The desktop server rewrites its own folder
 * and restarts; the Android app swaps in new page files without a reinstall, and
 * hands an APK to the system installer only when native code changed.
 * Automatic mode never cuts off something that is playing.
 */

const AUTO_UPDATE_KEY = 'xtream.autoUpdate';
const AUTO_ASKED_KEY = 'xtream.autoUpdateAsked';
const UPDATE_EVERY = 6 * 60 * 60 * 1000;

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const updates = {
  info: null,
  error: null,
  busy: false,
  dismissed: null,          // the version someone said "Later" to

  auto: () => readPref(AUTO_UPDATE_KEY) === '1',

  setAuto(on) {
    try {
      localStorage.setItem(AUTO_UPDATE_KEY, on ? '1' : '0');
      localStorage.setItem(AUTO_ASKED_KEY, '1');
    } catch {}
  },

  async check(force = false) {
    try {
      const { res, data } = await localJson('/update/status' + (force ? '?force=1' : ''));
      if (!res.ok) throw Object.assign(new Error(data?.error || 'Could not check for updates'), { detail: data?.detail || '' });
      this.info = data;
      this.error = null;
      return data;
    } catch (ex) {
      this.error = ex;
      throw ex;
    }
  },

  async apply() {
    const info = this.info;
    if (!info?.available || !info.canApply || this.busy) return;
    if (info.kind === 'apk') return this.installApk();

    this.busy = true;
    updateBar.progress(`Updating to version ${info.latest}…`);
    try {
      const res = await fetch('/update/apply', { method: 'POST', headers: { 'x-ims7-update': '1' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `Update failed (HTTP ${res.status})`), { detail: data.detail || '' });
      if (info.platform === 'web') {
        updateBar.progress(`Restarting the player on version ${data.to}…`);
        await waitForVersion(data.to);
      }
      location.reload();
    } catch (ex) {
      this.busy = false;
      updateBar.error(ex);
    }
  },

  installApk() {
    if (!window.AndroidUpdate) {
      updateBar.error(new Error('This copy of the app is too old to install updates itself. Reinstall it from Downloader.'));
      return;
    }
    this.busy = true;
    updateBar.progress('Downloading the app update…');
    window.AndroidUpdate.downloadAndInstall();
  },
};

/** The desktop server restarts itself after updating; wait for the new process to answer. */
async function waitForVersion(version) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const data = await (await fetch('/health', { cache: 'no-store' })).json();
      if (data.version === version) return;
    } catch {
      /* still restarting */
    }
  }
  throw new Error('The player did not come back after updating. Close its window and run Start Player again.');
}

// Called by the Android app's UpdateBridge.
window.onApkProgress = (pct) => updateBar.progress(`Downloading the app update… ${pct}%`);

window.onApkResult = (code, detail) => {
  updates.busy = false;
  if (code === 'installing') {
    updateBar.hide();
    return;
  }
  const message = {
    'up-to-date': 'You already have the newest app.',
    'needs-permission': 'IMS7 Player needs permission to install updates. Allow it (on Fire TV: Settings → My Fire TV → ' +
      'Developer options → Install unknown apps), then choose Install update again.',
    'signature-mismatch': 'This update is signed differently from the app you have, so Android will not install it over ' +
      'the top. Uninstall IMS7 Player and install it again from Downloader - this is needed once.',
  }[code] || 'The app update could not be downloaded.';
  updateBar.error(Object.assign(new Error(message), { detail: code === 'failed' ? detail : '' }));
};

/** Something on screen the viewer would notice being cut off. */
function isWatching() {
  if (mv.active && mv.tiles.length) return true;
  return !!state.now && !$('#video').paused;
}

const updateBar = {
  mode: null,

  set({ text, now, later, auto }) {
    $('#update-text').innerHTML = text;
    $('#update-now').hidden = !now;
    if (now) $('#update-now').textContent = now;
    $('#update-later').hidden = !later;
    if (later) $('#update-later').textContent = later;
    $('#update-auto').closest('label').hidden = !auto;
    $('#update-auto').checked = updates.auto();
    $('#update-bar').hidden = false;
  },

  show(info) {
    this.mode = 'update';
    this.set({
      text: `<b>Update available: version ${esc(info.latest)}</b><span class="muted">you have ${esc(info.current)}</span>` +
        (info.notes ? `<span class="update-notes">${esc(info.notes)}</span>` : '') +
        (!info.canApply && info.reason ? `<span class="update-notes">${esc(info.reason)}</span>` : ''),
      now: info.canApply ? (info.kind === 'apk' ? 'Install update' : 'Update now') : '',
      later: 'Later',
      auto: info.canApply,
    });
    this.focus();
  },

  offerAuto() {
    this.mode = 'offer';
    this.set({
      text: '<b>IMS7 Player can now update itself.</b>' +
        '<span class="muted">Turn on automatic updates? They only install when nothing is playing.</span>',
      now: 'Turn on',
      later: 'No thanks',
    });
    this.focus();
  },

  progress(text) {
    this.mode = 'busy';
    this.set({ text: `<b>${esc(text)}</b>` });
  },

  error(ex) {
    this.mode = 'update';
    this.set({
      text: `<b>${esc(ex.message || ex)}</b>${ex.detail ? `<span class="update-notes">${esc(ex.detail)}</span>` : ''}`,
      now: updates.info?.available && updates.info.canApply ? 'Try again' : '',
      later: 'Close',
    });
    this.focus();
  },

  hide() {
    this.mode = null;
    $('#update-bar').hidden = true;
  },

  /** On a remote, move focus to the banner - unless that would disturb someone watching. */
  focus() {
    if (state.platform === 'tv' && !isWatching()) focusEl(focusablesIn('#update-bar')[0]);
  },
};

$('#update-now').addEventListener('click', () => {
  if (updateBar.mode === 'offer') {
    updates.setAuto(true);
    updateBar.hide();
    toast('Automatic updates are on. You can change this in Diagnostics.');
    runUpdateCheck();
    return;
  }
  updates.apply();
});

$('#update-later').addEventListener('click', () => {
  if (updateBar.mode === 'offer') updates.setAuto(false);
  else if (updates.info?.available) updates.dismissed = updates.info.latest;
  updateBar.hide();
});

$('#update-auto').addEventListener('change', (e) => {
  updates.setAuto(e.target.checked);
  renderUpdateSettings();
  toast(e.target.checked ? 'Automatic updates are on.' : 'Automatic updates are off.');
});

async function runUpdateCheck({ force = false, fromUser = false } = {}) {
  let info;
  try {
    info = await updates.check(force);
  } catch (ex) {
    renderUpdateSettings();
    if (fromUser) throw ex;
    return null;
  }
  renderUpdateSettings();
  if (updates.busy) return info;

  if (!info.available) {
    // Ask once whether to update automatically, now that it is possible.
    if (info.canApply && !readPref(AUTO_ASKED_KEY) && $('#update-bar').hidden) updateBar.offerAuto();
    return info;
  }
  if (updates.auto() && info.canApply) {
    waitThenUpdate();
    return info;
  }
  if (fromUser || updates.dismissed !== info.latest) updateBar.show(info);
  return info;
}

let updateWaiter = null;

/**
 * Apply an automatic update at the first quiet moment. Straight away if nothing
 * has been opened; otherwise only after a minute with nothing playing, so a
 * brief pause does not get the stream cut off.
 */
function waitThenUpdate() {
  if (updateWaiter || updates.busy) return;
  if (!isWatching() && !state.now) {
    updates.apply();
    return;
  }
  let quiet = 0;
  updateWaiter = setInterval(() => {
    quiet = isWatching() ? 0 : quiet + 1;
    if (quiet < 2) return;
    clearInterval(updateWaiter);
    updateWaiter = null;
    if (updates.auto() && updates.info?.available) updates.apply();
  }, 30000);
}

function startUpdateChecks() {
  if (startUpdateChecks.started) return;
  startUpdateChecks.started = true;
  setTimeout(() => runUpdateCheck(), 8000);   // after the channel list, not competing with it
  setInterval(() => runUpdateCheck(), UPDATE_EVERY);
}

/** The Updates row at the top of the Diagnostics panel. */
function renderUpdateSettings() {
  const box = $('#update-settings');
  if (!box) return;
  const info = updates.info;
  const focusedId = box.contains(document.activeElement) ? document.activeElement.id : null;

  let line;
  if (updates.error) line = `Could not check: ${updates.error.message}${updates.error.detail ? ' - ' + updates.error.detail : ''}`;
  else if (!info) line = 'Checking…';
  else if (info.available) line = `Version ${info.latest} is available.`;
  else line = 'This is the newest version.';
  if (info && !info.canApply && info.reason) line += ' ' + info.reason;

  const canUpdate = !!(info?.available && info.canApply);
  box.innerHTML = `<b>Updates</b>
    <span class="muted small">Version ${esc(info?.current || CLIENT_VERSION)} · ${esc(line)}</span>
    <button id="update-check" class="ghost${canUpdate ? ' primary' : ''}" type="button">${
      canUpdate ? (info.kind === 'apk' ? 'Install update' : 'Update now') : 'Check for updates'}</button>
    <label class="update-auto"><input id="update-auto-setting" type="checkbox" ${updates.auto() ? 'checked' : ''} /> Update automatically</label>`;

  $('#update-check').addEventListener('click', async () => {
    if (updates.info?.available && updates.info.canApply) {
      updates.apply();
      return;
    }
    $('#update-check').textContent = 'Checking…';
    await runUpdateCheck({ force: true, fromUser: true }).catch(() => {});
    if (updates.info && !updates.info.available && !updates.error) toast('You have the newest version.');
  });
  $('#update-auto-setting').addEventListener('change', (e) => {
    updates.setAuto(e.target.checked);
    toast(e.target.checked ? 'Automatic updates are on. They install only when nothing is playing.' : 'Automatic updates are off.');
    if (e.target.checked && updates.info?.available) waitThenUpdate();
  });
  if (focusedId) focusEl(document.getElementById(focusedId));
}
