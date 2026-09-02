package com.picksmith.xtream

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var server: LocalProxyServer? = null
    private var voiceBridge: VoiceBridge? = null

    // Fullscreen video state (a <video> going fullscreen hands us its own view)
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var savedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val proxy = LocalProxyServer(assets)
        proxy.start(NanoTimeout, false)
        server = proxy

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true          // the app keeps creds + favourites in localStorage
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.databaseEnabled = true
            webViewClient = WebViewClient()
            webChromeClient = FullscreenChromeClient()
        }
        val bridge = VoiceBridge(this, webView)
        voiceBridge = bridge
        webView.addJavascriptInterface(bridge, "AndroidVoice")

        setContentView(webView)

        // Streaming for hours with no touch input should not dim the screen.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView.loadUrl("http://127.0.0.1:${proxy.listeningPort}/")
    }

    override fun onBackPressed() {
        when {
            customView != null -> (webView.webChromeClient as? FullscreenChromeClient)?.onHideCustomView()
            webView.canGoBack() -> webView.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onDestroy() {
        voiceBridge?.destroy()
        server?.stop()
        webView.destroy()
        super.onDestroy()
    }

    /** Lets a fullscreen <video> take over the whole activity, in landscape. */
    private inner class FullscreenChromeClient : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            savedOrientation = requestedOrientation
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

            (window.decorView as FrameLayout).addView(
                view,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }

        override fun onHideCustomView() {
            val view = customView ?: return
            (window.decorView as FrameLayout).removeView(view)
            customView = null
            customViewCallback?.onCustomViewHidden()
            customViewCallback = null
            requestedOrientation = savedOrientation
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    companion object {
        /** NanoHTTPD's socket read timeout, in ms. */
        const val NanoTimeout = 10_000
        private const val MIC_REQUEST = 42

        fun hasMicPermission(activity: Activity): Boolean =
            activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED

        fun requestMicPermission(activity: Activity) {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC_REQUEST)
        }
    }
}
