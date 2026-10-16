package com.example.netmonitor

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 前台服务：每 2 秒探测一次延迟，统计丢包/抖动，
 * 并把结果实时更新到通知栏，方便锁屏观察卡顿。
 */
class NetworkMonitorService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private var lastWifiGrade = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val n = buildNotification("启动中…")
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTI_ID, n)
        }
        if (job?.isActive != true) {
            MonitorState.reset()
            lastWifiGrade = ""
            MonitorState.addEvent(EventType.INFO, "开始监测（每 ${PROBE_INTERVAL_MS / 1000}s 探测一次）")
            MonitorState.running.value = true
            job = scope.launch {
                var tick = 0
                while (isActive) {
                    val ms = PingProber.probe()
                    MonitorState.pushSample(ms)
                    tick++
                    if (tick % 3 == 0) refreshWifiRssi()
                    notifySafely(buildNotification(ms?.let { "延迟 ${it}ms" } ?: "超时/丢包"))
                    delay(PROBE_INTERVAL_MS)
                }
            }
        }
        return START_STICKY
    }

    @Suppress("DEPRECATION")
    private fun refreshWifiRssi() {
        if (MonitorState.netType.value != "WiFi") {
            MonitorState.wifiRssi.value = null
            lastWifiGrade = ""
            return
        }
        try {
            val wm = getSystemService(WifiManager::class.java)
            val rssi = wm?.connectionInfo?.rssi
                ?.takeIf { it in -100..-10 } // 过滤无效值(127/200等)
            MonitorState.wifiRssi.value = rssi
            if (rssi != null) {
                val grade = rssiGrade(rssi)
                if (grade != lastWifiGrade) {
                    if (lastWifiGrade.isNotEmpty()) {
                        val warn = grade == "弱" || grade == "一般"
                        MonitorState.addEvent(
                            if (warn) EventType.WARN else EventType.INFO,
                            "WiFi 信号: $lastWifiGrade → $grade"
                        )
                    }
                    lastWifiGrade = grade
                }
            }
        } catch (e: Exception) {
            MonitorState.wifiRssi.value = null
        }
    }

    private fun rssiGrade(rssi: Int): String = when {
        rssi >= -55 -> "强"
        rssi >= -65 -> "良好"
        rssi >= -75 -> "一般"
        else -> "弱"
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, NetworkMonitorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, App.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_signal)
            .setContentTitle("网络监测中 · ${MonitorState.netType.value}")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .addAction(0, "停止", stop)
            .build()
    }

    private fun notifySafely(n: Notification) {
        try {
            getSystemService(NotificationManager::class.java).notify(NOTI_ID, n)
        } catch (e: Exception) {
            // 未授予通知权限时静默忽略
        }
    }

    override fun onDestroy() {
        job?.cancel()
        scope.cancel()
        MonitorState.running.value = false
        MonitorState.addEvent(EventType.INFO, "监测已停止")
        super.onDestroy()
    }

    companion object {
        const val NOTI_ID = 1001
        const val ACTION_STOP = "com.example.netmonitor.STOP"
        const val PROBE_INTERVAL_MS = 2000L
    }
}
