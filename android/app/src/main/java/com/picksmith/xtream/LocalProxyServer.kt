package com.picksmith.xtream

import android.content.res.AssetManager
import fi.iki.elonen.NanoHTTPD
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * The Android port of server.js.
 *
 * The web app is unchanged from the desktop version, so it still needs a
 * same-origin HTTP endpoint: panels send no Access-Control-Allow-Origin, HLS
 * manifests carry URIs relative to the panel, and the WebView's media stack
 * speaks plain HTTP rather than going through fetch(). A localhost server gives
 * all three, exactly as the Node one does.
 *
 * Bound to 127.0.0.1 on a FIXED port. This matters more than it looks: localStorage
 * is keyed by origin, so an ephemeral port would give the page a different origin on
 * every launch and silently discard the saved login, favourites and resume points.
 *
 * /stream will only relay to a host the app has actually logged into, so another app
 * on the device cannot use it as a general-purpose proxy.
 */
class LocalProxyServer(private val assets: AssetManager, port: Int) : NanoHTTPD("127.0.0.1", port) {

    companion object {
        const val VERSION = "1.9.0"
        private val PANEL_STATUS_HINTS = mapOf(
            511 to "The panel wants credentials it did not get (HTTP 511). Check the username and password.",
            512 to "The panel rejected this line (HTTP 512). Usually a wrong username/password, an expired " +
                "line, or a line bound to a different host/port - check your provider's M3U link.",
            513 to "The panel says this line is already at its connection limit (HTTP 513).",
            521 to "The panel is blocking this IP or device (HTTP 521)."
        )
        private val MIME_TYPES = mapOf(
            "html" to "text/html", "js" to "text/javascript", "css" to "text/css",
            "json" to "application/json", "svg" to "image/svg+xml", "png" to "image/png",
            "ico" to "image/x-icon", "woff2" to "font/woff2"
        )
    }

    /** Hosts seen in a successful API call; /stream relays to these only. */
    private val knownHosts = mutableSetOf<String>()

    /** Last 120 proxy events, readable from /log - there is no terminal on a phone. */
    private val recentLog = ArrayDeque<String>()

    private fun logLine(msg: String) {
        val line = "${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())}  $msg"
        android.util.Log.i("XtreamPlayer", line)
        synchronized(recentLog) {
            recentLog.addLast(line)
            while (recentLog.size > 120) recentLog.removeFirst()
        }
    }

    /** Credentials must never reach a log line or the diagnostics screen. */
    private fun redact(url: String): String = url
        .replace(Regex("([?&](username|password)=)[^&]*"), "$1***")
        .replace(Regex("/(live|movie|series)/[^/]+/[^/]+/"), "/$1/***/***/")

    /** panel.example.com and cdn5.panel.example.com are the same operator. */
    private fun baseDomain(host: String): String =
        host.split('.').let { if (it.size >= 2) it.takeLast(2).joinToString(".") else host }

    /**
     * Panels redirect streams to load balancers on sibling hosts, so an exact
     * match on the login host would block every segment. Accept the same base
     * domain, plus any host a permitted request actually redirected to.
     */
    private fun hostAllowed(host: String): Boolean = synchronized(knownHosts) {
        knownHosts.any { it == host || baseDomain(it).equals(baseDomain(host), ignoreCase = true) }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)   // live feeds pause between bursts
        .followRedirects(true)               // panels redirect to a load balancer
        .followSslRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    private fun status(code: Int) = object : Response.IStatus {
        override fun getRequestStatus() = code
        override fun getDescription() = "$code"
    }

    private fun json(code: Int, body: JSONObject): Response =
        newFixedLengthResponse(status(code), "application/json", body.toString()).apply {
            addHeader("Cache-Control", "no-store")
        }

    private fun error(code: Int, message: String, detail: String = ""): Response =
        json(code, JSONObject().put("error", message).put("detail", detail))

    override fun serve(session: IHTTPSession): Response = try {
        when (session.uri) {
            "/health" -> json(200, JSONObject().put("ok", true).put("version", VERSION))
            "/log" -> json(200, JSONObject().put("lines",
                org.json.JSONArray(synchronized(recentLog) { recentLog.toList() })))
            "/api" -> handleApi(session)
            "/stream" -> handleStream(session)
            "/probe" -> handleProbe(session)
            else -> serveAsset(session.uri)
        }
    } catch (e: Exception) {
        error(500, "Player error", e.message ?: e.toString())
    }

    /** Turn whatever the user typed into scheme://host[:port]. */
    private fun normaliseHost(raw: String): String {
        val v = if (raw.matches(Regex("^https?://.*", RegexOption.IGNORE_CASE))) raw else "http://$raw"
        val u = URI(v)
        val port = if (u.port == -1) "" else ":${u.port}"
        return "${u.scheme}://${u.host}$port"
    }

    private fun firstParam(session: IHTTPSession, name: String): String? =
        session.parameters[name]?.firstOrNull()

    private fun request(url: String, range: String? = null): okhttp3.Response {
        val b = Request.Builder().url(url)
            .header("User-Agent", "VLC/3.0.20 LibVLC/3.0.20")
            .header("Accept", "*/*")
        if (range != null) b.header("Range", range)
        return client.newCall(b.build()).execute()
    }

    // ── player_api.php relay ────────────────────────────────────────────────

    private fun handleApi(session: IHTTPSession): Response {
        val rawHost = firstParam(session, "host") ?: return error(400, "Missing server address")
        val origin = try {
            normaliseHost(rawHost)
        } catch (e: Exception) {
            return error(400, "That does not look like a server address")
        }

        val endpoint = if (firstParam(session, "endpoint") == "xmltv") "xmltv.php" else "player_api.php"
        val url = StringBuilder("$origin/$endpoint?")
        session.parameters.forEach { (k, values) ->
            if (k != "host" && k != "endpoint") {
                values.forEach { v -> url.append(java.net.URLEncoder.encode(k, "UTF-8")).append('=')
                    .append(java.net.URLEncoder.encode(v, "UTF-8")).append('&') }
            }
        }

        val resp = try {
            request(url.toString())
        } catch (e: Exception) {
            return error(502, "Could not reach the panel", e.message ?: e.toString())
        }

        resp.use {
            val body = it.body?.string().orEmpty()
            if (endpoint == "xmltv.php") {
                return newFixedLengthResponse(status(it.code), "application/xml", body)
            }
            // Valid JSON means the panel really is the API; remember the host so
            // /stream is willing to relay to it.
            val looksLikeJson = try {
                JSONObject(body); true
            } catch (e: Exception) {
                body.trimStart().startsWith("[")
            }
            if (!looksLikeJson) {
                val hint = PANEL_STATUS_HINTS[it.code] ?: when {
                    body.isBlank() -> "The panel answered HTTP ${it.code} with an empty body, so it is not " +
                        "serving the player API at this address."
                    body.contains("<html", true) -> "The panel answered HTTP ${it.code} with a web page, not " +
                        "API data - this is probably the customer portal rather than the API host."
                    else -> "HTTP ${it.code}: ${body.take(300)}"
                }
                logLine("API " + it.code + " no-api " + redact(url.toString()))
                return error(502, "The panel did not return player API data", hint)
            }
            synchronized(knownHosts) { knownHosts.add(URI(origin).host) }
            logLine("API " + it.code + " " + body.length + "B " + redact(url.toString()))
            return newFixedLengthResponse(status(it.code), "application/json", body)
                .apply { addHeader("Cache-Control", "no-store") }
        }
    }

    // ── media relay ─────────────────────────────────────────────────────────

    private fun handleStream(session: IHTTPSession): Response {
        val target = firstParam(session, "url") ?: return error(400, "Missing url parameter")
        val host = try {
            URI(target).host
        } catch (e: Exception) {
            return error(400, "Bad stream URL")
        }
        if (!hostAllowed(host)) {
            logLine("PLAY 403 blocked host $host")
            return error(403, "Not a panel this app is signed into")
        }

        val resp = try {
            request(target, session.headers["range"])
        } catch (e: Exception) {
            logLine("PLAY FAIL ${redact(target)} - ${e.message}")
            return error(502, "Upstream request failed", e.message ?: e.toString())
        }

        val finalUrl = resp.request.url.toString()
        // A permitted request that redirected vouches for wherever it landed;
        // segment URIs are resolved against that host next.
        synchronized(knownHosts) { knownHosts.add(resp.request.url.host) }
        if (session.headers["range"] == null) {
            logLine("PLAY ${resp.code} ${redact(finalUrl)}")
        }
        val ctype = resp.header("Content-Type").orEmpty()
        val isManifest = ctype.contains("mpegurl", true) || finalUrl.substringBefore('?').endsWith(".m3u8", true)

        if (isManifest) {
            val raw = resp.use { it.body?.string().orEmpty() }
            if (!raw.contains("#EXTM3U")) {
                return error(502, "Server did not return a playlist", raw.take(300))
            }
            val rewritten = rewriteManifest(raw, finalUrl)
            return newFixedLengthResponse(status(200), "application/vnd.apple.mpegurl", rewritten)
                .apply { addHeader("Cache-Control", "no-store") }
        }

        // Stream the body straight through; NanoHTTPD closes it with the response.
        val body = resp.body ?: return error(502, "Empty response from the panel")
        val out = newChunkedResponse(status(resp.code), ctype.ifEmpty { "video/mp2t" }, body.byteStream())
        resp.header("Content-Range")?.let { out.addHeader("Content-Range", it) }
        resp.header("Accept-Ranges")?.let { out.addHeader("Accept-Ranges", it) }
        out.addHeader("Cache-Control", "no-store")
        return out
    }

    /**
     * Segment, key and variant URIs in a playlist are relative to the panel, not
     * to us, so resolve each against the final upstream URL and point it back at
     * /stream.
     */
    private fun rewriteManifest(text: String, finalUrl: String): String {
        val base = URI(finalUrl)
        fun proxied(u: String): String = try {
            "/stream?url=" + java.net.URLEncoder.encode(base.resolve(u.trim()).toString(), "UTF-8")
        } catch (e: Exception) {
            u
        }

        return text.split("\n").joinToString("\n") { line ->
            val t = line.trim()
            when {
                t.isEmpty() -> line
                t.startsWith("#") -> Regex("URI=\"([^\"]+)\"").replace(line) { m ->
                    "URI=\"${proxied(m.groupValues[1])}\""
                }
                else -> proxied(t)
            }
        }
    }

    // ── server discovery ────────────────────────────────────────────────────

    private fun handleProbe(session: IHTTPSession): Response {
        val rawHost = firstParam(session, "host").orEmpty()
        val user = firstParam(session, "username").orEmpty()
        val pass = firstParam(session, "password").orEmpty()
        if (rawHost.isEmpty() || user.isEmpty() || pass.isEmpty()) {
            return error(400, "Need host, username and password to search.")
        }

        val hostname = try {
            URI(if (rawHost.startsWith("http")) rawHost else "http://$rawHost").host
        } catch (e: Exception) {
            return error(400, "That does not look like a server address.")
        }

        val ports = listOf(
            "http" to 80, "http" to 8080, "http" to 8000, "http" to 8880,
            "http" to 2082, "http" to 2086, "http" to 2095, "http" to 25461,
            "http" to 25462, "http" to 8081, "https" to 443, "https" to 2083,
            "https" to 2096, "https" to 8443
        )
        val origins = ports.map { (scheme, port) ->
            val bare = if ((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) "" else ":$port"
            "$scheme://$hostname$bare"
        }.distinct()

        val results = origins.parallelStream().map { origin -> probeOne(origin, user, pass) }.toList()
        val rank = mapOf("works" to 0, "wrong-credentials" to 1, "no-api" to 2, "unreachable" to 3)
        val sorted = results.sortedBy { rank[it.getString("verdict")] ?: 9 }

        return json(200, JSONObject()
            .put("tried", origins.size)
            .put("results", org.json.JSONArray(sorted)))
    }

    private fun probeOne(origin: String, user: String, pass: String): JSONObject {
        val row = JSONObject().put("origin", origin)
        val url = "$origin/player_api.php?username=" +
            java.net.URLEncoder.encode(user, "UTF-8") + "&password=" + java.net.URLEncoder.encode(pass, "UTF-8")
        return try {
            request(url).use { resp ->
                val body = resp.body?.string().orEmpty()
                val info = try {
                    JSONObject(body).optJSONObject("user_info")
                } catch (e: Exception) {
                    null
                }
                if (info != null) {
                    val ok = info.opt("auth").toString() == "1"
                    row.put("verdict", if (ok) "works" else "wrong-credentials")
                        .put("status", resp.code)
                        .put("note", if (ok) "Player API works here (${info.optString("status", "active")})"
                        else "This IS the API host, but it rejected this username/password")
                } else {
                    row.put("verdict", "no-api").put("status", resp.code)
                        .put("note", if (body.isBlank()) "HTTP ${resp.code}, empty response"
                        else "HTTP ${resp.code}, not API data")
                }
            }
        } catch (e: Exception) {
            row.put("verdict", "unreachable").put("note", (e.message ?: "unreachable").take(80))
        }
    }

    // ── static files (the same public/ folder as the desktop build) ──────────

    private fun serveAsset(uri: String): Response {
        val path = "www/" + (if (uri == "/") "index.html" else uri.trimStart('/'))
        return try {
            val bytes = assets.open(path).readBytes()
            val ext = path.substringAfterLast('.', "")
            newFixedLengthResponse(
                status(200),
                MIME_TYPES[ext] ?: "application/octet-stream",
                ByteArrayInputStream(bytes),
                bytes.size.toLong()
            )
        } catch (e: Exception) {
            newFixedLengthResponse(status(404), "text/plain", "Not found")
        }
    }
}
