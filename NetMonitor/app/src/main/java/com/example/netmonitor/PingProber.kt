package com.example.netmonitor

import android.os.SystemClock
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToInt

/**
 * 延迟探测：优先使用系统 ping（ICMP，最贴近真实体验），
 * 设备不支持时退化为 HTTP 探测（204 端点，含 TCP 握手）。
 */
object PingProber {

    const val HOST = "223.5.5.5" // 阿里公共 DNS，国内可达性好
    private const val HTTP_URL = "http://connect.rom.miui.com/generate_204"

    @Volatile
    private var pingBroken = false

    fun probe(timeoutSec: Int = 2): Int? {
        if (pingBroken) return httpProbe(timeoutSec * 1000)
        return try {
            val p = ProcessBuilder("/system/bin/ping", "-c", "1", "-W", timeoutSec.toString(), HOST)
                .start()
            val out = p.inputStream.bufferedReader().use { it.readText() }
            p.errorStream?.close()
            when (val code = p.waitFor()) {
                0 -> Regex("time[=<]([0-9.]+)\\s*ms").find(out)
                    ?.groupValues?.get(1)?.toFloatOrNull()?.roundToInt()

                1 -> null // 真实超时/丢包
                else -> {
                    // ping 不可用（权限/二进制缺失等），永久切换
                    if (!pingBroken) {
                        pingBroken = true
                        MonitorState.addEvent(EventType.INFO, "系统 ping 不可用(exit=$code)，改用 HTTP 探测")
                    }
                    httpProbe(timeoutSec * 1000)
                }
            }
        } catch (e: Exception) {
            pingBroken = true
            MonitorState.addEvent(EventType.INFO, "系统 ping 不可用，改用 HTTP 探测")
            httpProbe(timeoutSec * 1000)
        }
    }

    private fun httpProbe(timeoutMs: Int): Int? {
        var conn: HttpURLConnection? = null
        return try {
            val start = SystemClock.elapsedRealtime()
            conn = (URL(HTTP_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                useCaches = false
                setRequestProperty("Connection", "close")
            }
            val code = conn.responseCode
            if (code in 200..399) (SystemClock.elapsedRealtime() - start).toInt() else null
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }
}
