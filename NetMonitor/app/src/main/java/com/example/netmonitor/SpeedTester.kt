package com.example.netmonitor

import android.os.SystemClock
import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 下载测速：依次尝试多个测速源，限制 10MB / 15s。
 */
object SpeedTester {

    private const val MAX_BYTES = 10L * 1024 * 1024
    private const val MAX_MS = 15_000L

    private val URLS = listOf(
        "https://speed.cloudflare.com/__down?bytes=25000000",
        "https://dldir1.qq.com/qqfile/cl/QQInstall.exe"
    )

    fun test(onProgress: (String) -> Unit): String {
        var lastError: Exception? = null
        for (u in URLS) {
            try {
                return download(u, onProgress)
            } catch (e: Exception) {
                lastError = e
            }
        }
        return "测速失败: ${lastError?.message ?: "未知错误"}"
    }

    private fun download(url: String, onProgress: (String) -> Unit): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 10000
        conn.useCaches = false
        conn.setRequestProperty("User-Agent", "NetMonitor/1.0")
        try {
            conn.connect()
            if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode}")
            val start = SystemClock.elapsedRealtime()
            var bytes = 0L
            val buf = ByteArray(64 * 1024)
            BufferedInputStream(conn.inputStream).use { input ->
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    bytes += n
                    val el = SystemClock.elapsedRealtime() - start
                    if (el > 500) onProgress(format(bytes, el))
                    if (bytes >= MAX_BYTES || el >= MAX_MS) break
                }
            }
            val el = SystemClock.elapsedRealtime() - start
            if (bytes == 0L) throw IllegalStateException("无数据返回")
            return format(bytes, el)
        } finally {
            conn.disconnect()
        }
    }

    private fun format(bytes: Long, ms: Long): String {
        val mbps = bytes * 8.0 / (ms / 1000.0) / 1_000_000.0
        return String.format("下载 %.2f MB · %.1f Mbps", bytes / 1048576.0, mbps)
    }
}
