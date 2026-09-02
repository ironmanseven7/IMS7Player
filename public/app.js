/* Xtream Web Player - browser app. Talks to the local proxy at /api and /stream. */

const $ = (sel) => document.querySelector(sel);
// Bump together with VERSION in server.js. The page comes off disk on every request,
// so a server process left running from an older build serves this newer page.
const CLIENT_VERSION = '1.7.0';
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
  hls: null,
  mpegts: null,
  cache: { live: null, movie: null, series: null }, // all-streams cache per section
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
  const exp = ui.exp_date ? new Date(Number(ui.exp_date) * 1000).toLocaleDateString() : 'never';
  $('#acct-info').textContent =
    `${ui.username} · ${ui.status || 'Active'} · expires ${exp} · ${ui.active_cons || 0}/${ui.max_connections || '?'} connections`;

  $('#login').hidden = true;
  $('#app').hidden = false;
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
    state.categories = Array.isArray(cats) ? cats : [];
    renderCategories();

    if (!state.cache[section]) {
      const all = await api(LIST_ACTION[section]);
      state.cache[section] = Array.isArray(all) ? all : [];
    }
    state.items = state.cache[section];
    resetList();
  } catch (ex) {
    $('#cat-list').innerHTML = '';
    $('#item-list').innerHTML = `<li class="error-row">${esc(ex.message || ex)}</li>`;
  }
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
  $('#now-detail').innerHTML = '<div class="loading">Loading guide…</div>';
  try {
    const data = await api('get_short_epg', { stream_id: streamId, limit: 8 });
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
    $('#now-detail').innerHTML = `<div class="error-row">${esc(ex.message || ex)}</div>`;
  }
}

/* ── playback ─────────────────────────────────────────────── */

function stopPlayback() {
  const video = $('#video');
  // Switching away clears currentTime, so bank the position first.
  if (typeof saveResumeNow === 'function') saveResumeNow();
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  if (state.mpegts) {
    try {
      state.mpegts.pause();
      state.mpegts.unload();
      state.mpegts.detachMediaElement();
      state.mpegts.destroy();
    } catch {}
    state.mpegts = null;
  }
  video.removeAttribute('src');
  video.load();
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

  const isHls = kind === 'live' && state.creds.fmt === 'm3u8';
  const isTs = kind === 'live' && state.creds.fmt === 'ts';

  if (isHls) {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls(bufferProfile().hls);
      state.hls = hls;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else fail(`${data.details || data.type}`);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      video.play().catch(() => {});
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
    } else {
      fail('This browser cannot play HLS.');
    }
    return;
  }

  if (isTs) {
    if (window.mpegts && mpegts.isSupported()) {
      const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src }, bufferProfile().ts);
      state.mpegts = p;
      p.on(mpegts.Events.ERROR, (type, detail) => fail(`${type} ${detail || ''}`));
      p.attachMediaElement(video);
      p.load();
      p.play().catch(() => {});
    } else {
      fail('MPEG-TS playback is not supported in this browser. Switch the live format to HLS.');
    }
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
  const n = state.now;
  if (n) play(n.kind, n.id, n.ext, n.meta || {}); // reload so the new settings take effect
});

/* ── boot ─────────────────────────────────────────────────── */

/** Warn up front if the running process is older than the page it just served. */
async function checkServerVersion() {
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
    .filter((el) => !el.disabled && el.offsetParent !== null);
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

  // OK / Enter on the player toggles full screen - the native video controls
  // are effectively unusable from a remote.
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement === $('#video')) {
    e.preventDefault();
    toggleVideoFull();
    return;
  }
  if (e.key === 'Escape' && document.body.classList.contains('video-full')) {
    e.preventDefault();
    setVideoFull(false);
    return;
  }

  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // let the caret move
  // A dropdown needs up/down for its own options.
  if (onSelect && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;

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
      return;                            // already at the top
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
];

async function handleVoiceCommand(raw) {
  const text = normalise(raw);
  if (!text) return 'Did not catch that.';

  // transport
  if (/^(pause|stop)$/.test(text)) { $('#video').pause(); return 'Paused'; }
  if (/^(play|resume|continue)$/.test(text)) { $('#video').play(); return 'Playing'; }
  if (/^mute$/.test(text)) { $('#video').muted = true; return 'Muted'; }
  if (/^(unmute|sound on)$/.test(text)) { $('#video').muted = false; return 'Unmuted'; }
  if (/full ?screen/.test(text)) {
    const v = $('#video');
    if (v.requestFullscreen) v.requestFullscreen();
    return 'Fullscreen';
  }

  // sections
  const section = text.replace(/^(go to|switch to|open|show|bring up|take me to|display)\s+/, '').trim();
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
     <div class="diag-body">${body}</div>`;
  $('#diag-close').addEventListener('click', () => (panel.hidden = true));
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
  document.body.classList.toggle('video-full', on);

  if (on) {
    history.pushState({ videoFull: true }, '');
    $('#video').focus();
  } else if (history.state && history.state.videoFull) {
    history.back();                 // popstate clears the class
  }
  $('#fullscreen').textContent = on ? '⤡ Exit full screen' : '⤢ Full screen';
}

function toggleVideoFull() {
  setVideoFull(!document.body.classList.contains('video-full'));
}

window.addEventListener('popstate', () => {
  document.body.classList.remove('video-full');
  $('#fullscreen').textContent = '⤢ Full screen';
});

$('#fullscreen').addEventListener('click', toggleVideoFull);

// Double-click / double-tap the picture, as in any other player.
$('#video').addEventListener('dblclick', toggleVideoFull);
