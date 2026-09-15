package com.picksmith.xtream

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * In-app updates, in two sizes.
 *
 * Most releases only change the page (public/), and those need no reinstall: the
 * files are downloaded from one exact commit, each is checked against the git
 * hash GitHub lists for it, and they are served from app storage in place of the
 * copies inside the APK.
 *
 * A release whose page needs newer native code (version.json "minApkForWeb") is
 * only offered as a whole APK, taken from the GitHub release - which CI publishes
 * only after the build succeeds - and installed by UpdateBridge.
 */
class WebUpdates(private val context: Context) {

    companion object {
        const val REPO = "ironmanseven7/IMS7Player"
        private const val API = "https://api.github.com"
        private const val RAW = "https://raw.githubusercontent.com"
        const val APK_URL = "https://github.com/$REPO/releases/latest/download/app-debug.apk"
        private const val RELEASE_VERSION_URL = "https://github.com/$REPO/releases/latest/download/version.json"

        /** True when [a] is a later dotted version than [b]. */
        fun newer(a: String, b: String): Boolean {
            val pa = a.split('.').map { it.toIntOrNull() ?: 0 }
            val pb = b.split('.').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val d = pa.getOrElse(i) { 0 } - pb.getOrElse(i) { 0 }
                if (d != 0) return d > 0
            }
            return false
        }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val root = File(context.filesDir, "web")
    private val pointer = File(root, "current.txt")
    private val apkVersionCode = BuildConfig.VERSION_CODE.toLong()

    // Every page request asks which folder to serve from, so resolve it once.
    @Volatile private var resolved = false
    @Volatile private var active: File? = null

    private fun get(url: String, accept: String? = null): ByteArray {
        val b = Request.Builder().url(url).header("User-Agent", "IMS7-Player/${BuildConfig.VERSION_NAME}")
        if (accept != null) b.header("Accept", accept)
        client.newCall(b.build()).execute().use { resp ->
            if (resp.code != 200) throw IllegalStateException("${resp.request.url.host} answered HTTP ${resp.code}")
            return resp.body?.bytes() ?: ByteArray(0)
        }
    }

    private fun getJson(url: String, accept: String? = null) = JSONObject(String(get(url, accept), Charsets.UTF_8))

    /** Folder of downloaded page files in use, or null to serve the APK's own. */
    fun activeDir(): File? {
        if (!resolved) synchronized(this) {
            if (!resolved) {
                active = findActive()
                resolved = true
            }
        }
        return active
    }

    private fun findActive(): File? {
        val version = try {
            pointer.readText().trim()
        } catch (e: Exception) {
            return null
        }
        // An APK installed afterwards carries newer page files than anything downloaded before it.
        if (!newer(version, BuildConfig.VERSION_NAME)) return null
        val dir = File(root, version)
        val meta = try {
            JSONObject(File(dir, "version.json").readText())
        } catch (e: Exception) {
            return null
        }
        if (meta.optLong("minApkForWeb", 0) > apkVersionCode) return null
        return if (File(dir, "index.html").isFile) dir else null
    }

    fun webVersion(): String = activeDir()?.name ?: BuildConfig.VERSION_NAME

    /** The downloaded copy of a page file, if downloaded files are in use. */
    fun overrideFile(rel: String): File? {
        val dir = activeDir() ?: return null
        val f = File(dir, rel)
        return if (f.canonicalPath.startsWith(dir.canonicalPath + File.separator) && f.isFile) f else null
    }

    fun status(): JSONObject {
        val current = webVersion()
        val latest = getJson("$RAW/$REPO/main/version.json?t=${System.currentTimeMillis()}")
        val latestVersion = latest.getString("version")
        val out = JSONObject()
            .put("platform", "android")
            .put("current", current)
            .put("apkVersionCode", apkVersionCode)
            .put("latest", latestVersion)
            .put("notes", latest.optString("notes"))
            .put("canApply", true)
            .put("reason", "")

        if (newer(latestVersion, current) && latest.optLong("minApkForWeb", 0) <= apkVersionCode) {
            return out.put("available", true).put("kind", "web")
        }

        // Native changes come as an APK, which exists only once CI has built and published it.
        val release = try {
            getJson(RELEASE_VERSION_URL)
        } catch (e: Exception) {
            null
        }
        if (release != null && release.optLong("apkVersionCode", 0) > apkVersionCode) {
            return out.put("available", true).put("kind", "apk")
                .put("latest", release.optString("version", latestVersion))
                .put("notes", release.optString("notes"))
        }
        return out.put("available", false).put("kind", "none")
    }

    @Synchronized
    fun apply(): JSONObject {
        val commit = getJson("$API/repos/$REPO/commits/main", "application/vnd.github+json")
        val sha = commit.getString("sha")
        val meta = JSONObject(String(get("$RAW/$REPO/$sha/version.json"), Charsets.UTF_8))
        val version = meta.getString("version")
        val current = webVersion()
        if (!newer(version, current)) throw IllegalStateException("GitHub has $version, which is not newer than $current")
        if (meta.optLong("minApkForWeb", 0) > apkVersionCode) {
            throw IllegalStateException("Version $version needs the app itself updated first")
        }

        val tree = getJson("$API/repos/$REPO/git/trees/$sha?recursive=1", "application/vnd.github+json")
        if (tree.optBoolean("truncated")) throw IllegalStateException("GitHub sent a partial file list")

        root.mkdirs()
        val staging = File(root, "$version.partial")
        staging.deleteRecursively()
        try {
            val items = tree.getJSONArray("tree")
            var count = 0
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                val path = item.getString("path")
                if (item.getString("type") != "blob" || !path.startsWith("public/")) continue

                val encoded = path.split('/').joinToString("/") {
                    java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20")
                }
                val data = get("$RAW/$REPO/$sha/$encoded")
                if (gitBlobSha(data) != item.getString("sha")) {
                    throw IllegalStateException("$path did not match GitHub's checksum")
                }
                val dest = File(staging, path.removePrefix("public/"))
                if (!dest.canonicalPath.startsWith(staging.canonicalPath + File.separator)) {
                    throw IllegalStateException("Refusing to write $path")
                }
                dest.parentFile?.mkdirs()
                dest.writeBytes(data)
                count++
            }
            if (!File(staging, "index.html").isFile) throw IllegalStateException("The release is missing the player files")
            File(staging, "version.json").writeText(meta.toString())

            val dir = File(root, version)
            dir.deleteRecursively()
            if (!staging.renameTo(dir)) throw IllegalStateException("Could not move the update into place")
            pointer.writeText(version)
            resolved = false

            // Keep only the version now in use.
            root.listFiles()?.forEach { if (it.isDirectory && it.name != version) it.deleteRecursively() }
            return JSONObject().put("ok", true).put("from", current).put("to", version).put("files", count)
        } finally {
            if (staging.exists()) staging.deleteRecursively()
        }
    }

    /** The hash git (and so GitHub's tree listing) gives a file's contents. */
    private fun gitBlobSha(data: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-1")
        md.update("blob ${data.size} ".toByteArray(Charsets.UTF_8))
        md.update(data)
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
