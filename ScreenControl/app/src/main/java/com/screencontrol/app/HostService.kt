package com.screencontrol.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.screencontrol.app.host.ScreenEncoder
import com.screencontrol.app.net.Protocol
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 被控端前台服务：
 * 1. 持有 MediaProjection 采集屏幕并编码为 H.264；
 * 2. 监听 TCP 端口，将视频帧推送给已认证的客户端；
 * 3. 接收客户端的触控/按键 JSON，交给无障碍服务注入。
 */
class HostService : Service() {

    companion object {
        const val ACTION_START = "com.screencontrol.app.START"
        const val ACTION_STOP = "com.screencontrol.app.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        private const val TAG = "HostService"
        private const val NOTIF_ID = 1
        private const val CHANNEL_ID = "screenctl"
        private const val MAX_LONG_SIDE = 1280

        @Volatile
        var running = false
            private set

        @Volatile
        var statusText = "未启动"

        @Volatile
        var pin = "123456"
    }

    private var projection: MediaProjection? = null
    private var encoder: ScreenEncoder? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var client: Socket? = null

    @Volatile
    private var out: DataOutputStream? = null

    private val videoQueue = LinkedBlockingQueue<ByteArray>(240)
    private var videoW = 1280
    private var videoH = 720

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                if (running) return START_NOT_STICKY // 防止重复启动
                val code = intent.getIntExtra(EXTRA_RESULT_CODE, -1)
                val data = androidx.core.content.IntentCompat.getParcelableExtra(
                    intent, EXTRA_RESULT_DATA, Intent::class.java
                )
                if (code < 0 || data == null) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                startForegroundWithType()
                startCapture(code, data)
                startServer()
                running = true
                statusText = "等待连接… ${Protocol.localIpAddress()}:${Protocol.PORT}"
            }
            else -> if (!running) stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun startForegroundWithType() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "屏幕共享", NotificationManager.IMPORTANCE_LOW)
        )
        val notif = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("投屏遥控")
            .setContentText("正在共享屏幕，可随时停止")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun startCapture(resultCode: Int, data: Intent) {
        val mpm = getSystemService(MediaProjectionManager::class.java) ?: return
        val p = mpm.getMediaProjection(resultCode, data)
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                stopSelf()
            }
        }, null)

        val dm = resources.displayMetrics
        val scale = MAX_LONG_SIDE.toFloat() /
            maxOf(dm.widthPixels, dm.heightPixels).coerceAtLeast(1)
        val s = minOf(scale, 1f)
        videoW = ((dm.widthPixels * s).toInt() / 2) * 2
        videoH = ((dm.heightPixels * s).toInt() / 2) * 2

        val enc = ScreenEncoder(videoW, videoH) { pts, flags, bytes ->
            val packet = videoPacket(pts, flags, bytes)
            if (!videoQueue.offer(packet)) {
                videoQueue.poll() // 丢最旧帧，保证实时性
                videoQueue.offer(packet)
            }
        }
        encoder = enc
        virtualDisplay = p.createVirtualDisplay(
            "ScreenCtl", videoW, videoH, dm.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            enc.inputSurface, null, null
        )
        enc.startDrain()
    }

    private fun videoPacket(pts: Long, flags: Int, data: ByteArray): ByteArray {
        val bos = ByteArrayOutputStream(16 + data.size)
        DataOutputStream(bos).use { d ->
            d.writeInt(1 + 12 + data.size)
            d.writeByte(Protocol.MSG_VIDEO)
            d.writeLong(pts)
            d.writeInt(flags)
            d.write(data)
        }
        return bos.toByteArray()
    }

    private fun startServer() {
        thread(name = "accept") {
            try {
                val ss = ServerSocket(Protocol.PORT)
                serverSocket = ss
                while (running && !ss.isClosed) {
                    val s = ss.accept()
                    s.tcpNoDelay = true
                    handleClient(s)
                }
            } catch (e: Exception) {
                if (running) {
                    statusText = "服务异常: ${e.message}"
                    Log.e(TAG, "server error", e)
                }
            }
        }
    }

    private fun handleClient(s: Socket) {
        // 单客户端：替换旧连接
        client?.let { old ->
            try {
                old.close()
            } catch (_: Exception) {
            }
        }
        client = s
        statusText = "设备接入 ${s.inetAddress.hostAddress}，等待验证…"
        val o = DataOutputStream(BufferedOutputStream(s.getOutputStream(), 128 * 1024))
        out = o
        videoQueue.clear()
        thread(name = "recv-${s.port}") { receiver(s, o) }
        thread(name = "send-${s.port}") { sender(s, o) }
    }

    private fun sender(s: Socket, o: DataOutputStream) {
        try {
            while (running && !s.isClosed) {
                val packet = videoQueue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                synchronized(o) {
                    o.write(packet)
                    o.flush()
                }
            }
        } catch (_: Exception) {
        }
        disconnect(s)
    }

    private fun receiver(s: Socket, o: DataOutputStream) {
        var authorized = false
        try {
            val i = DataInputStream(BufferedInputStream(s.getInputStream(), 128 * 1024))
            while (running && !s.isClosed) {
                val (type, payload) = Protocol.readFrame(i)
                if (type != Protocol.MSG_JSON) continue
                val obj = JSONObject(String(payload, Charsets.UTF_8))
                when (obj.optString("t")) {
                    "auth" -> {
                        if (obj.optString("pin") == pin) {
                            authorized = true
                            val hello = JSONObject()
                                .put("t", "hello")
                                .put("device", Build.MODEL)
                                .put("w", videoW)
                                .put("h", videoH)
                            Protocol.writeJson(o, hello.toString())
                            statusText = "已连接 ${s.inetAddress.hostAddress}"
                        } else {
                            statusText = "密码错误，连接已拒绝"
                            disconnect(s)
                            return
                        }
                    }
                    "touch" -> if (authorized) {
                        val x = obj.getDouble("x").toFloat() * videoW
                        val y = obj.getDouble("y").toFloat() * videoH
                        ControlAccessibilityService.inject(obj.optString("a"), x, y)
                    }
                    "key" -> if (authorized) {
                        ControlAccessibilityService.global(obj.optString("k"))
                    }
                }
            }
        } catch (_: Exception) {
        }
        disconnect(s)
    }

    private fun disconnect(s: Socket) {
        try {
            s.close()
        } catch (_: Exception) {
        }
        if (client === s) {
            client = null
            out = null
            videoQueue.clear()
            if (running) statusText = "连接断开，等待重连…"
        }
    }

    override fun onDestroy() {
        running = false
        statusText = "未启动"
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        try {
            client?.close()
        } catch (_: Exception) {
        }
        try {
            virtualDisplay?.release()
        } catch (_: Exception) {
        }
        encoder?.stop()
        try {
            projection?.stop()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
