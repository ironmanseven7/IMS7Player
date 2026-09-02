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

It binds to `127.0.0.1` only. If you expose it with `BIND=0.0.0.0`, set `XTREAM_PASSCODE`
too — `/stream` will relay any http(s) URL handed to it, which is an open proxy if it is
reachable from outside and ungated.

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

## Three shells, one document

The app detects what it is running on and switches layout accordingly. In the APK the answer
comes from `PlatformBridge.kt` (`UiModeManager`, leanback feature, touchscreen absence) rather
than the user agent, because a Fire TV stick reports a fairly ordinary Android UA. In a plain
browser it falls back to UA matching plus pointer/size checks.

**Phone** — a bottom navigation bar with icons, the player sticky at the top of the scroll,
categories as a horizontal chip strip instead of a pane, larger rows and touch targets, and
safe-area padding for notches and gesture bars. Choosing something scrolls the player into
view. EPG text and plots fold away so they cannot push the list off screen; episode lists stay
open, since that is the reason you opened a series.

**TV (Fire TV, Shield, Android TV)** — larger type throughout, overscan-safe padding, and
proportional columns so the player cannot be squeezed out on a 720p panel. Focus is the whole
interface on a remote, so it is loud: a 3 px accent outline, a lift in background, and a slight
scale. The highlight is driven by a class as well as `:focus`, because some TV WebViews are
unreliable about the pseudo-class.

**Desktop** — the three-pane layout, unchanged apart from the shared polish.

Films and series now render as artwork cards rather than list rows, with a 2:3 poster, a
two-line title, and a progress bar for part-watched films. Titles with no artwork get their
initials on a gradient instead of a broken image. Channels stay a list — channel logos are
small and wide, and a grid of them reads worse than rows. The middle column widens
automatically when artwork is showing. Loading states are shimmer placeholders rather than the
word "Loading".

## Voice, remote and resume

**Voice.** The mic button in the top bar, or the **V** key. In the Android app it drives the
device's own `SpeechRecognizer` through a native bridge, because a WebView has no Web Speech
API; in a desktop browser it uses `webkitSpeechRecognition` (Chrome and Edge, not Firefox).
Both paths end up in the same command handler.

| Say | What happens |
| --- | --- |
| "watch CNN", "put on ESPN", "tune to BBC One" | Finds the channel and plays it |
| "bring up movies", "show series", "go to live", "favourites" | Switches section |
| "play Top Gun" | Searches movies, then series, then live |
| "search comedy" | Types it into the search box |
| "pause", "play", "mute", "fullscreen" | Transport controls |

Names are matched loosely — exact, then prefix, then substring, then word overlap — so "watch
cnn" finds "CNN International HD". Anything below a confidence floor reports that it could not
find it rather than playing something random.

**Remote / D-pad.** Arrows move within a column and cross between the three columns; Enter
activates. **Up** from the top of a column steps into the **top bar**, where left and right
reach the tabs, Voice, Buffering, Diagnostics and Sign out, and **Down** drops back into the
column you came from. Focus is drawn with a solid accent outline, since a remote gives no
hover. Walking toward the bottom of a list keeps loading more automatically.

**Full screen.** The **Full screen** button beside the title, **OK** on the player itself, or
saying "fullscreen". Any arrow key, **Back** or Escape leaves it. This expands the video to
fill the window rather than calling the Fullscreen API — a TV WebView may not implement that
API, and entering full screen must not depend on it. Entering pushes a history entry, so the
remote's Back button leaves full screen rather than the app.

**Resume.** Movies and episodes remember where you stopped, and jump back there with a
"Resumed from 12:34" toast. Positions under 30 seconds are ignored and anything past 95 % is
treated as finished and cleared. Movie rows show a thin progress bar of how far you got. Live
TV is excluded. Positions are stored per browser (or per app install), newest 300 kept.

## Sharing the web version

The web player is not a file you can send. It needs `server.js` running somewhere, because
the CORS relay, the HLS manifest rewriting and `Range` forwarding all happen server-side.
So the question is where that server runs.

### Best: your friend runs their own copy

Nothing of yours is exposed, and it works wherever they are.

1. Install Node.js LTS from <https://nodejs.org>.
2. Download this repository: **Code → Download ZIP** on GitHub, then unzip it.
3. Double-click **Start Player.bat** (on macOS or Linux: `node server.js`).
4. It opens at <http://127.0.0.1:8787>.

The launcher checks for Node and points at the download if it is missing.

### If you want to host it for them

Your machine has to stay on, and the player becomes reachable by whoever has the address, so
set a passcode. Without one, `/stream` will relay to any host it is handed — an open proxy
running on your connection.

```
set BIND=0.0.0.0
set XTREAM_PASSCODE=pick-something-long
node server.js
```

Every route then returns **401** with an unlock page until the passcode is entered once; it is
remembered in a cookie for 30 days. Only `/health` stays open, so the app can compare versions.
The passcode is redacted from the log.

On your own network that is all you need — give them `http://<your-lan-ip>:8787`. To reach it
from outside your house you would also need a tunnel (for example Cloudflare Tunnel) or port
forwarding. Think carefully before doing that: it puts a relay on your home connection.

### What sharing actually shares

The player keeps no accounts of its own. Whoever uses it types **your panel credentials** into
their own browser, so sharing the player means sharing your line. Two consequences:

- Your line has a **maximum number of simultaneous connections**. The account line at the top
  of the app shows it, as `active / max`. Past that, streams fail with HTTP 513.
- They can see and use the whole subscription.

If that is not what you want, share the guide and let them use their own line — the player
works with any Xtream panel, not just yours.

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

## Installing on Fire TV / Shield with Downloader

First, on the device: **Settings → My Fire TV → Developer Options → Install unknown apps →
Downloader → On**. (On a Shield: Settings → Security & restrictions → Unknown sources →
Downloader.) Without this, Downloader fetches the file and the install is refused.

Then pick one of these.

### The URL to type into Downloader

```
github.com/ironmanseven7/IMS7Player/releases/latest/download/app-debug.apk
```

That address is stable — every build replaces the file behind it, so re-running the same
download is how you update. Downloader keeps it in its history, so you only type it once.

A release must **not** be marked as a prerelease for this to work: GitHub excludes prereleases
from `/releases/latest/`, and the URL 404s even though the release and its asset exist. The
tag-addressed form `…/releases/download/latest/app-debug.apk` works either way.

For a shorter address to type on a remote, enable GitHub Pages (**Settings → Pages → Source:
deploy from branch, `main`, folder `/docs`**). Then `ironmanseven7.github.io/IMS7Player`
forwards to the current APK.

### Option A — public repo, permanent URL (easiest to live with)

If the repository is public, the release asset is a plain public download and this URL never
changes between builds:

```
https://github.com/<user>/<repo>/releases/latest/download/app-debug.apk
```

Type that into Downloader once. Every future build replaces the file at the same address, so
re-downloading it is how you update.

Nothing in this repository is secret — no credentials, no panel address, no username. The
player keeps all of that in the browser's localStorage on your own device, never in a file.
Making it public exposes only the code.

### Option B — keep the repo private, serve it from your PC over the LAN

The private-repo release URL needs a GitHub login, which Downloader cannot do. Instead, hand
the file to the TV from the machine that already runs the desktop player:

1. Download `app-debug.apk` from the release on your PC.
2. Drop it in the `xtream-player` folder, next to `server.js`.
3. Start the server so the network can reach it:

   ```
   set BIND=0.0.0.0 && node server.js
   ```

   It prints the exact address to type, e.g. `http://192.168.1.50:8787/apk`.
4. Enter that in Downloader. It downloads and offers to install.
5. Stop the server when you are done — `BIND=0.0.0.0` also exposes `/stream` to your network.

The PC only needs to be on for the install itself, not for watching afterwards.

### Option C — sideload over adb

With the TV's ADB debugging enabled and on the same network:

```
adb connect <tv-ip>:5555 && adb install -r app-debug.apk
```

### Limits

- Debug signing means Android shows an "unknown developer" warning on install.
- Phone, TV and desktop each get their own layout; see "Three shells, one document" above.
- MKV/AVI movies fail in a WebView exactly as they do in a desktop browser — the container is
  the limit, not the player.

## Troubleshooting

Every request is logged with the username and password redacted — status code, timing and
response size. On desktop it prints to the terminal running `server.js`; in the Android app,
and also on desktop, the **Diagnostics** button in the top bar shows the same log (served from
`/log`). A live stream that has not started after 12 seconds says so and points you there.

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
