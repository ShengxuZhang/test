package com.example.netmonitor

import kotlinx.coroutines.flow.MutableStateFlow

enum class EventType { INFO, WARN, BAD }

data class LogEvent(val time: Long, val type: EventType, val message: String)

data class NetStats(
    val avg: Int = 0,
    val max: Int = 0,
    val jitter: Int = 0,
    val lossPct: Double = 0.0,
)

/**
 * 全局共享的监测状态：前台服务写入，UI 采集展示。
 */
object MonitorState {
    const val SPIKE_MS = 200      // 延迟尖峰阈值
    const val LOSS_STREAK = 3     // 连续丢包判定次数
    private const val MAX_POINTS = 120
    private const val MAX_EVENTS = 500

    val netType = MutableStateFlow("—")
    val netDetail = MutableStateFlow("")
    val wifiRssi = MutableStateFlow<Int?>(null)
    val latency = MutableStateFlow<Int?>(null)
    val history = MutableStateFlow<List<Int?>>(emptyList())
    val stats = MutableStateFlow(NetStats())
    val running = MutableStateFlow(false)
    val events = MutableStateFlow<List<LogEvent>>(emptyList())
    val speedText = MutableStateFlow("")

    private val hist = ArrayList<Int?>(MAX_POINTS)
    private var total = 0
    private var lost = 0
    private var sum = 0L
    private var peak = 0
    private var lastOk = 0
    private var jitterSum = 0L
    private var jitterCnt = 0
    private var lossStreak = 0

    fun addEvent(type: EventType, msg: String) {
        val list = events.value.toMutableList()
        list.add(0, LogEvent(System.currentTimeMillis(), type, msg))
        while (list.size > MAX_EVENTS) list.removeAt(list.size - 1)
        events.value = list
    }

    fun reset() {
        synchronized(this) {
            hist.clear()
            total = 0; lost = 0; sum = 0; peak = 0
            lastOk = 0; jitterSum = 0; jitterCnt = 0; lossStreak = 0
            history.value = emptyList()
            stats.value = NetStats()
            latency.value = null
        }
    }

    fun pushSample(ms: Int?) {
        synchronized(this) {
            total++
            if (ms == null) {
                lost++
                lossStreak++
                if (lossStreak == LOSS_STREAK) {
                    addEvent(EventType.BAD, "连续 $LOSS_STREAK 次探测超时，疑似断流")
                }
            } else {
                if (lossStreak >= LOSS_STREAK) {
                    addEvent(EventType.WARN, "断流恢复（此前连续丢包 $lossStreak 次）")
                }
                lossStreak = 0
                sum += ms
                if (ms > peak) peak = ms
                if (lastOk > 0) {
                    jitterSum += Math.abs(ms - lastOk)
                    jitterCnt++
                }
                lastOk = ms
                if (ms >= SPIKE_MS) {
                    addEvent(EventType.WARN, "延迟尖峰 ${ms}ms（${netType.value}）")
                }
            }
            hist.add(ms)
            while (hist.size > MAX_POINTS) hist.removeAt(0)
            history.value = hist.toList()
            latency.value = ms
            val ok = total - lost
            stats.value = NetStats(
                avg = if (ok > 0) (sum / ok).toInt() else 0,
                max = peak,
                jitter = if (jitterCnt > 0) (jitterSum / jitterCnt).toInt() else 0,
                lossPct = if (total > 0) lost * 100.0 / total else 0.0
            )
        }
    }
}
