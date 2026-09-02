package com.picksmith.xtream

import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.webkit.JavascriptInterface

/**
 * Tells the web app what kind of device it is running on.
 *
 * User-agent sniffing gets this wrong often enough to matter — a Fire TV stick
 * reports a fairly ordinary Android UA — so ask the system instead. The page
 * falls back to UA matching when this bridge is absent (i.e. in a browser).
 */
class PlatformBridge(private val activity: Activity) {

    @JavascriptInterface
    fun isTv(): Boolean {
        val uiMode = activity.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        if (uiMode?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION) return true

        // Leanback is the reliable marker for Fire TV and Shield; touchscreen
        // absence catches set-top boxes that do not declare leanback.
        val pm = activity.packageManager
        return pm.hasSystemFeature("android.software.leanback") ||
            !pm.hasSystemFeature("android.hardware.touchscreen")
    }

    @JavascriptInterface
    fun isAndroidApp(): Boolean = true
}
