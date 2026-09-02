# Xtream Web Player

A browser player for an existing Xtream Codes / `player_api.php` server. Live TV, movies,
series, EPG and favourites. No dependencies, no build step — Node 18+ and a browser.

## Run

```bash
node xtream-player/server.js
```

Then open <http://127.0.0.1:8787> and enter your panel URL, username and password.
Credentials are never written to disk by the server; "Remember" stores them in the
browser's localStorage only.

Change the port with `PORT=9000 node server.js`.

## Parameters it uses

Login: `http://host:port/player_api.php?username=USER&password=PASS`

| Purpose | action |
| --- | --- |
| Account / server info | *(no action)* → `user_info`, `server_info` |
| Live categories / channels | `get_live_categories`, `get_live_streams` |
| Movie categories / titles | `get_vod_categories`, `get_vod_streams`, `get_vod_info` |
| Series categories / titles | `get_series_categories`, `get_series`, `get_series_info` |
| Now/next guide | `get_short_epg&stream_id=&limit=8` |

Playback URLs:

```
live    http://host:port/live/USER/PASS/<stream_id>.m3u8   (or .ts)
movie   http://host:port/movie/USER/PASS/<stream_id>.<container_extension>
series  http://host:port/series/USER/PASS/<episode_id>.<container_extension>
```

## Why the local server exists

Panels don't send `Access-Control-Allow-Origin`, so a page opened as `file://` or from any
other origin cannot call `player_api.php` or fetch `.m3u8` — the browser blocks it. `server.js`:

- relays `/api` → `player_api.php` from the same origin as the page
- relays `/stream?url=…`, following redirects to the panel's load balancer
- **rewrites HLS manifests** so segment, key and variant URIs keep going through the relay
  (they are relative to the *final* upstream URL, which the browser can't resolve on its own)
- forwards `Range` headers so seeking works on movies and episodes

It binds to `127.0.0.1` only. Don't expose it — `/stream` will relay any http(s) URL handed
to it, which is an open proxy if it's reachable from outside.

## Format notes

- **Live** defaults to HLS via hls.js. If your panel only serves MPEG-TS, pick
  `MPEG-TS (.ts)` on the login screen — mpegts.js handles it.
- **Movies/series** play natively. MP4 works everywhere; MKV/AVI usually won't decode in a
  browser. Use **Copy direct URL** and open it in VLC for those.
- hls.js and mpegts.js are bundled in `public/vendor/`, so the player needs no CDN.

## Finding the right address

The address printed on a provider's website is often the customer portal, not the machine
running `player_api.php`. Two shortcuts on the login screen:

- **Paste your whole M3U link** into the Server URL box — anything shaped like
  `http://host:port/get.php?username=U&password=P&type=m3u_plus` is split into the three
  fields for you.
- **Find my server** tries the ports and subdomains Xtream/XUI panels are normally published
  on (80, 8080, 8000, 8880, 2082/2086/2095, 25461/25462, https on 443/2083/2096/8443, plus
  `line.` / `tv.` / `panel.` / `api.` / `portal.` subdomains) and reports which one answers
  with real player API JSON. Fill in the username and password first — a live panel and a
  dead one are only distinguishable by whether the API accepts a line. Green means it works;
  amber means that host IS the API but rejected those credentials.

## Buffering

The **Buffering** control in the top bar trades latency for stability. It applies on the next
stream you open (switching it reloads what is playing) and is remembered.

| Profile | Live edge distance | Use when |
| --- | --- | --- |
| **Smooth** (default) | ~6 segments / up to 60 s held ahead | Anything that stutters. Best default. |
| **Balanced** | ~4 segments / 30 s | Stable connection, want less delay |
| **Low latency** | ~3 segments / 12 s | Live sport, and only if the feed is solid |

The readout at the bottom-right of the video shows seconds of buffer ahead and how many times
playback has rebuffered since the stream started. It turns amber under 2 s — if it sits there,
move a profile toward Smooth. Counting starts after playback begins, so the initial fill is not
counted as a stall.

Other things that reduce stalling, already applied:

- The proxy keeps connections to the panel alive (`keepAlive`, 32 sockets). Without this every
  HLS segment paid a fresh TCP/TLS handshake, which on a 6-second segment cycle is a large slice
  of the budget.
- `TCP_NODELAY` on upstream sockets, so small frequent writes are not held back by Nagle batching.
- The stream timeout is 45 s rather than 15 s, so a feed that pauses between bursts is not killed.
- A live stream that runs dry for 12 s straight is rebuilt automatically, at most once per 30 s.
- If the panel stops sending entirely, the player says so instead of showing a frozen frame.

If a channel still stutters on Smooth, the bottleneck is upstream of this player — your line's
bandwidth or that channel's source. Compare with the same channel in VLC via **Copy direct URL**.

## Android APK

`android/` is a complete Android Studio / Gradle project that wraps this exact web app.

**How it works.** The same three problems that need `server.js` on the desktop exist in a
WebView: panels send no CORS headers, HLS manifests carry URIs relative to the panel, and the
WebView's media stack speaks plain HTTP rather than going through `fetch()`. So
`LocalProxyServer.kt` is a port of `server.js` — NanoHTTPD on `127.0.0.1` with an ephemeral
port, OkHttp upstream, the same `/api`, `/stream`, `/probe` and `/health` routes, the same
manifest rewriting and `Range` forwarding. The WebView loads `http://127.0.0.1:<port>/` and
every line of the web app runs unchanged.

`public/` stays the single source of truth: a Gradle `Copy` task pulls it into
`app/src/main/assets/www` at build time, so there is no second copy to keep in sync.

**Hardening vs the desktop build.** `/stream` only relays to a host that has already answered
a successful `/api` call, so another app on the device cannot use the localhost server as a
general-purpose proxy.

**Android specifics handled:** cleartext HTTP enabled (panels are almost all `http://`, which
Android blocks by default since API 28), `INTERNET` permission, DOM storage on so credentials
and favourites persist, fullscreen video with landscape rotation, screen kept awake during
playback, back button mapped to leave fullscreen then navigate, and a leanback launcher entry
plus TV banner so it installs on Android TV as well as phones.

### Building it

Nothing to install locally — push this folder as a GitHub repo and
`.github/workflows/android.yml` builds it, with the APK in the run's **Artifacts**:

```bash
gh repo create xtream-player --private --source=. --push
```

To build locally instead you need a JDK 17 and the Android SDK (~5 GB). With Android Studio,
open the `android/` folder and it will fetch the SDK and generate the Gradle wrapper; then
Build → Build APK. From a terminal with the SDK already present:

```bash
cd android && gradle assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/`. It is debug-signed — fine for
sideloading onto your own devices, not for the Play Store. Enable "install unknown apps" on
the phone, or `adb install app-debug.apk`.

### Limits

- Debug signing means Android shows an "unknown developer" warning on install.
- The UI is mouse/touch shaped. It runs on Android TV but D-pad navigation is not tuned, so a
  box with a mouse or air-remote is the better experience for now.
- MKV/AVI movies fail in a WebView exactly as they do in a desktop browser — the container is
  the limit, not the player.

## Troubleshooting

Every request is logged to the terminal running `server.js`, with the username and password
redacted — status code, timing and response size. Start there.

| Symptom | Cause |
| --- | --- |
| "Login rejected by the panel" | The API answered, but with `auth: 0` — wrong credentials or expired line |
| HTTP **511** | The panel got no usable credentials |
| HTTP **512** | The panel rejected the line. Wrong username/password, expired, **or the line belongs to a different host/port than the one entered** |
| HTTP **513** | Line is at its connection limit |
| "answered with a web page" | That address is the customer portal, not the API host |
| "untrusted certificate" | Self-signed cert — restart with `XTREAM_INSECURE_TLS=1`, or use the `http://` address |
| Live loads then stalls | Your line's max connections are in use elsewhere |
| Movie plays audio, no video | MKV/HEVC container the browser can't decode — use VLC |

**Getting the right address.** The panel's own homepage is often *not* the API host. Take the
M3U link your provider issued — it looks like
`http://some-host.tld:8080/get.php?username=…&password=…&type=m3u_plus` — and use exactly the
`http://some-host.tld:8080` part as the Server URL, with the same username and password.

To accept a self-signed certificate:

```bash
XTREAM_INSECURE_TLS=1 node xtream-player/server.js
```
