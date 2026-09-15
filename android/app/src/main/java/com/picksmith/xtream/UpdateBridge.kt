package com.picksmith.xtream

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Full app updates, for releases that change native code. Exposed to the page as
 * window.AndroidUpdate.downloadAndInstall(); results come back through
 * window.onApkProgress(percent) and window.onApkResult(code, detail).
 *
 * An app cannot install itself silently. This downloads the APK, checks it is a
 * newer build of this same app signed with the same key - a mismatch otherwise
 * surfaces as the installer's unhelpful "App not installed" - and then hands it
 * to the system installer, which asks the user to confirm.
 */
class UpdateBridge(private val activity: Activity, private val webView: WebView) {

    @Volatile private var running = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    @JavascriptInterface
    fun downloadAndInstall() {
        if (running) return
        running = true
        Thread {
            try {
                install(download())
            } catch (e: Exception) {
                report("failed", e.message ?: e.toString())
            } finally {
                running = false
            }
        }.start()
    }

    private fun download(): File {
        val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
        val out = File(dir, "ims7-player.apk")
        val request = Request.Builder().url(WebUpdates.APK_URL)
            .header("User-Agent", "IMS7-Player/${BuildConfig.VERSION_NAME}")
            .build()
        client.newCall(request).execute().use { resp ->
            if (resp.code != 200) throw IllegalStateException("GitHub answered HTTP ${resp.code}")
            val body = resp.body ?: throw IllegalStateException("The download was empty")
            val total = body.contentLength()
            var done = 0L
            var lastReported = -1
            body.byteStream().use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val pct = (done * 100 / total).toInt()
                            if (pct >= lastReported + 5) {
                                lastReported = pct
                                eval("window.onApkProgress && window.onApkProgress($pct)")
                            }
                        }
                    }
                }
            }
        }
        return out
    }

    private fun install(apk: File) {
        val pm = activity.packageManager
        val archive = pm.getPackageArchiveInfo(apk.path, signatureFlag())
            ?: throw IllegalStateException("The download is not a valid app")
        if (archive.packageName != activity.packageName) throw IllegalStateException("The download is a different app")

        val newCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        if (newCode <= BuildConfig.VERSION_CODE) {
            report("up-to-date", "")
            return
        }

        val installed = try {
            pm.getPackageInfo(activity.packageName, signatureFlag())
        } catch (e: Exception) {
            null
        }
        val fresh = signatures(archive)
        val mine = signatures(installed)
        if (fresh.isNotEmpty() && mine.isNotEmpty() && fresh != mine) {
            report("signature-mismatch", "")
            return
        }

        if (!pm.canRequestPackageInstalls()) {
            activity.runOnUiThread {
                try {
                    activity.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                    )
                } catch (e: ActivityNotFoundException) {
                    // Fire OS has no per-app screen to jump to; the message explains where it lives.
                }
            }
            report("needs-permission", "")
            return
        }

        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.runOnUiThread {
            try {
                activity.startActivity(intent)
                report("installing", "")
            } catch (e: ActivityNotFoundException) {
                report("failed", "This device has no app installer to hand the update to.")
            }
        }
    }

    private fun signatureFlag(): Int =
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

    private fun signatures(info: PackageInfo?): Set<String> {
        if (info == null) return emptySet()
        val sigs = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return sigs?.map { it.toCharsString() }?.toSet() ?: emptySet()
    }

    private fun report(code: String, detail: String) =
        eval("window.onApkResult && window.onApkResult(${JSONObject.quote(code)}, ${JSONObject.quote(detail)})")

    private fun eval(js: String) {
        activity.runOnUiThread { webView.evaluateJavascript(js, null) }
    }
}
