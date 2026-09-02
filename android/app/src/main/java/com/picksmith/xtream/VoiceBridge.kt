package com.picksmith.xtream

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * Android WebView has no Web Speech API, so the page cannot listen for speech on
 * its own. This exposes window.AndroidVoice.start()/stop() to JavaScript, drives
 * Android's own SpeechRecognizer, and calls the same window.onVoiceResult /
 * window.onVoiceError entry points the desktop browser path uses.
 *
 * Everything here hops to the UI thread: SpeechRecognizer must be created and
 * called there, and WebView.evaluateJavascript likewise.
 */
class VoiceBridge(private val activity: Activity, private val webView: WebView) {

    private var recognizer: SpeechRecognizer? = null

    @JavascriptInterface
    fun start() {
        activity.runOnUiThread {
            if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                fail("audio-capture")
                return@runOnUiThread
            }
            if (!MainActivity.hasMicPermission(activity)) {
                // The prompt is async; the user taps the mic again once granted.
                MainActivity.requestMicPermission(activity)
                fail("not-allowed")
                return@runOnUiThread
            }

            recognizer?.destroy()
            val r = SpeechRecognizer.createSpeechRecognizer(activity)
            recognizer = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle?) {
                    val text = results
                        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()
                    if (text.isNullOrBlank()) fail("no-speech") else deliver(text)
                }

                override fun onError(error: Int) = fail(
                    when (error) {
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "not-allowed"
                        SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_NO_MATCH -> "no-speech"
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network"
                        SpeechRecognizer.ERROR_AUDIO -> "audio-capture"
                        else -> "error-$error"
                    }
                )

                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.packageName)
            }
            r.startListening(intent)
        }
    }

    @JavascriptInterface
    fun stop() {
        activity.runOnUiThread {
            recognizer?.stopListening()
            recognizer?.destroy()
            recognizer = null
        }
    }

    fun destroy() {
        activity.runOnUiThread {
            recognizer?.destroy()
            recognizer = null
        }
    }

    /** JSONObject.quote gives us correct escaping for the JS string literal. */
    private fun deliver(text: String) = eval("window.onVoiceResult(${JSONObject.quote(text)})")

    private fun fail(code: String) = eval("window.onVoiceError(${JSONObject.quote(code)})")

    private fun eval(js: String) {
        activity.runOnUiThread { webView.evaluateJavascript(js, null) }
    }
}
