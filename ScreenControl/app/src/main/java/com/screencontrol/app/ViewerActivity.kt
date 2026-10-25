package com.screencontrol.app

import android.os.Bundle
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.screencontrol.app.net.Protocol
import com.screencontrol.app.viewer.VideoDecoder
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo

/**
 * 控制端（平板）：
 * - 连接被控端 TCP，接收 H.264 流解码渲染到 SurfaceView；
 * - 把画面上的触摸事件换算为归一化坐标发送给被控端注入；
 * - 顶部按钮可发送 返回/主页/多任务。
 */
class ViewerActivity : AppCompatActivity(), SurfaceHolder.Callback {

    private lateinit var surfaceView: SurfaceView
    private lateinit var panelConnect: View
    private lateinit var tvStatus: TextView
    private lateinit var tvDevices: TextView
    private lateinit var etIp: EditText
    private lateinit var etPin: EditText

    private var socket: Socket? = null

    @Volatile
    private var out: DataOutputStream? = null

    @Volatile
    private var connected = false

    private var decoder: VideoDecoder? = null
    private val pendingPackets = ArrayDeque<VideoDecoder.Packet>()
    private var surfaceReady = false

    @Volatile
    private var streamW = 1280

    @Volatile
    private var streamH = 720
    private var lastMoveSent = 0L

    private var nsdManager: NsdManager? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_viewer)

        surfaceView = findViewById(R.id.surfaceView)
        panelConnect = findViewById(R.id.panelConnect)
        tvStatus = findViewById(R.id.tvViewerStatus)
        tvDevices = findViewById(R.id.tvDevices)
        etIp = findViewById(R.id.etIp)
        etPin = findViewById(R.id.etPin)

        surfaceView.holder.addCallback(this)

        surfaceView.setOnTouchListener { v, e -> handleTouch(v, e) }

        findViewById<Button>(R.id.btnConnect).setOnClickListener {
            val ip = etIp.text.toString().trim()
            if (ip.isNotEmpty()) startConnect(ip, etPin.text.toString().ifBlank { "123456" })
        }

        findViewById<Button>(R.id.btnDiscover).setOnClickListener { startDiscover() }

        findViewById<Button>(R.id.btnDisconnect).setOnClickListener { disconnect() }

        fun sendKey(k: String) = sendJson(JSONObject().put("t", "key").put("k", k))
        findViewById<Button>(R.id.btnBack).setOnClickListener { sendKey("back") }
        findViewById<Button>(R.id.btnHome).setOnClickListener { sendKey("home") }
        findViewById<Button>(R.id.btnRecents).setOnClickListener { sendKey("recents") }
    }

    // ---------------- 连接 ----------------

    private fun startConnect(ip: String, pin: String) {
        if (connected) return
        tvStatus.text = "连接中…"
        thread(name = "connect") {
            try {
                val s = Socket()
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(ip, Protocol.PORT), 4000)
                socket = s
                val o = DataOutputStream(BufferedOutputStream(s.getOutputStream(), 128 * 1024))
                out = o
                val auth = JSONObject().put("t", "auth").put("pin", pin)
                Protocol.writeJson(o, auth.toString())
                connected = true
                runOnUiThread {
                    tvStatus.text = "已连接 $ip"
                    panelConnect.visibility = View.GONE
                }
                receiverLoop(s)
            } catch (e: Exception) {
                runOnUiThread {
                    tvStatus.text = "连接失败：${e.message ?: e.javaClass.simpleName}"
                }
                disconnect()
            }
        }
    }

    private fun receiverLoop(s: Socket) {
        try {
            val i = DataInputStream(BufferedInputStream(s.getInputStream(), 256 * 1024))
            while (connected && !s.isClosed) {
                val (type, payload) = Protocol.readFrame(i)
                when (type) {
                    Protocol.MSG_JSON -> {
                        val obj = JSONObject(String(payload, Charsets.UTF_8))
                        if (obj.optString("t") == "hello") {
                            streamW = obj.optInt("w", streamW)
                            streamH = obj.optInt("h", streamH)
                            val name = obj.optString("device", "设备")
                            runOnUiThread { tvStatus.text = "正在观看 $name" }
                        }
                    }
                    Protocol.MSG_VIDEO -> {
                        val (pts, flags, data) = Protocol.parseVideo(payload)
                        onVideoPacket(pts, flags, data)
                    }
                }
            }
        } catch (_: Exception) {
        }
        if (connected) disconnect()
    }

    private fun onVideoPacket(pts: Long, flags: Int, data: ByteArray) {
        val d = decoder
        if (d != null) {
            d.enqueue(pts, flags, data)
        } else {
            synchronized(pendingPackets) {
                if (pendingPackets.size > 120) pendingPackets.removeFirst()
                pendingPackets.addLast(VideoDecoder.Packet(pts, flags, data))
            }
        }
    }

    private fun disconnect() {
        connected = false
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        socket = null
        out = null
        synchronized(pendingPackets) { pendingPackets.clear() }
        runOnUiThread {
            tvStatus.text = getString(R.string.viewer_status)
            panelConnect.visibility = View.VISIBLE
        }
    }

    private fun sendJson(json: JSONObject) {
        val o = out ?: return
        if (!connected) return
        try {
            Protocol.writeJson(o, json.toString())
        } catch (_: Exception) {
            disconnect()
        }
    }

    // ---------------- 触控 ----------------

    private fun handleTouch(v: View, e: MotionEvent): Boolean {
        if (!connected) return false
        // 视频在 SurfaceView 内等比居中（可能有黑边），先把触摸点映射到视频区域
        val vw = v.width.toFloat()
        val vh = v.height.toFloat()
        if (vw <= 0 || vh <= 0) return false
        val scale = minOf(vw / streamW, vh / streamH)
        val offX = (vw - streamW * scale) / 2f
        val offY = (vh - streamH * scale) / 2f
        val nx = ((e.x - offX) / (streamW * scale)).coerceIn(0f, 1f)
        val ny = ((e.y - offY) / (streamH * scale)).coerceIn(0f, 1f)

        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN ->
                sendJson(JSONObject().put("t", "touch").put("a", "down").put("x", nx.toDouble()).put("y", ny.toDouble()))
            MotionEvent.ACTION_MOVE -> {
                val now = System.currentTimeMillis()
                if (now - lastMoveSent >= 15) { // 节流，约 60Hz
                    lastMoveSent = now
                    sendJson(JSONObject().put("t", "touch").put("a", "move").put("x", nx.toDouble()).put("y", ny.toDouble()))
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                sendJson(JSONObject().put("t", "touch").put("a", "up").put("x", nx.toDouble()).put("y", ny.toDouble()))
        }
        return true
    }

    // ---------------- Surface ----------------

    override fun surfaceCreated(holder: SurfaceHolder) {
        surfaceReady = true
        restartDecoder()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        surfaceReady = false
        decoder?.release()
        decoder = null
    }

    private fun restartDecoder() {
        decoder?.release()
        decoder = null
        if (!surfaceReady) return
        val d = VideoDecoder(surfaceView.holder.surface) { w, h ->
            streamW = w
            streamH = h
        }
        decoder = d
        d.start()
        synchronized(pendingPackets) {
            for (p in pendingPackets) d.enqueue(p.ptsUs, p.flags, p.data)
            pendingPackets.clear()
        }
    }

    // ---------------- NSD 局域网发现 ----------------

    private fun startDiscover() {
        val nsd = nsdManager ?: getSystemService(NsdManager::class.java)?.also { nsdManager = it }
        if (nsd == null) {
            tvDevices.text = "设备发现不可用，请手动输入 IP"
            return
        }
        stopDiscover()
        tvDevices.text = "搜索中…"
        val found = HashSet<String>()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                runOnUiThread { tvDevices.text = "搜索失败，请手动输入 IP" }
            }
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                nsd.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
                    override fun onServiceResolved(info: NsdServiceInfo) {
                        val host = info.host?.hostAddress ?: return
                        val name = info.serviceName
                        if (found.add("$name|$host")) {
                            runOnUiThread {
                                tvDevices.append("$name\nIP: $host\n\n")
                                etIp.setText(host)
                            }
                        }
                    }
                })
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }
        discoveryListener = listener
        try {
            nsd.discoverServices(Protocol.NSD_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: Exception) {
            tvDevices.text = "搜索失败，请手动输入 IP"
        }
    }

    private fun stopDiscover() {
        val nsd = nsdManager ?: return
        discoveryListener?.let {
            try {
                nsd.stopServiceDiscovery(it)
            } catch (_: Exception) {
            }
        }
        discoveryListener = null
    }

    override fun onDestroy() {
        super.onDestroy()
        connected = false
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        decoder?.release()
        decoder = null
        stopDiscover()
    }
}
