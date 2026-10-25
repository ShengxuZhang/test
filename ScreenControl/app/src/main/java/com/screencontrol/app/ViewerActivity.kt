package com.screencontrol.app

import android.os.Bundle
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.screencontrol.app.net.Protocol
import com.screencontrol.app.viewer.VideoDecoder
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * 控制端（平板）：
 * - 进入页面后自动扫描同一局域网网段内开启投屏服务的设备（TCP 端口探测，不依赖 mDNS）；
 * - 只发现一台时自动连接，多台时点击列表选择；
 * - 连接后接收 H.264 流解码渲染，并把触摸事件换算为归一化坐标发送给被控端注入。
 */
class ViewerActivity : AppCompatActivity(), SurfaceHolder.Callback {

    private lateinit var surfaceView: SurfaceView
    private lateinit var panelConnect: View
    private lateinit var tvStatus: TextView
    private lateinit var tvScanStatus: TextView
    private lateinit var deviceList: LinearLayout
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

    private val found = ConcurrentLinkedQueue<String>()

    @Volatile
    private var scanning = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_viewer)

        surfaceView = findViewById(R.id.surfaceView)
        panelConnect = findViewById(R.id.panelConnect)
        tvStatus = findViewById(R.id.tvViewerStatus)
        tvScanStatus = findViewById(R.id.tvScanStatus)
        deviceList = findViewById(R.id.deviceList)
        etIp = findViewById(R.id.etIp)
        etPin = findViewById(R.id.etPin)

        surfaceView.holder.addCallback(this)
        surfaceView.setOnTouchListener { v, e -> handleTouch(v, e) }

        findViewById<Button>(R.id.btnScan).setOnClickListener { startScan() }

        findViewById<Button>(R.id.btnConnect).setOnClickListener {
            val ip = etIp.text.toString().trim()
            if (ip.isNotEmpty()) startConnect(ip, etPin.text.toString().ifBlank { "123456" })
        }

        findViewById<Button>(R.id.btnDisconnect).setOnClickListener { disconnect() }

        fun sendKey(k: String) = sendJson(JSONObject().put("t", "key").put("k", k))
        findViewById<Button>(R.id.btnBack).setOnClickListener { sendKey("back") }
        findViewById<Button>(R.id.btnHome).setOnClickListener { sendKey("home") }
        findViewById<Button>(R.id.btnRecents).setOnClickListener { sendKey("recents") }
    }

    override fun onResume() {
        super.onResume()
        if (!connected && !scanning) startScan()
    }

    // ---------------- 局域网扫描 ----------------

    /** 扫描本机所在 /24 网段的 4747 端口，找出开了投屏服务的设备 */
    private fun startScan() {
        if (scanning || connected) return
        scanning = true
        found.clear()
        deviceList.removeAllViews()
        tvScanStatus.text = "正在扫描局域网…"

        val myIp = localLanIp()
        if (myIp == null) {
            tvScanStatus.text = "未检测到 Wi-Fi 网络，请确认平板已连接 Wi-Fi"
            scanning = false
            return
        }
        val prefix = myIp.substringBeforeLast('.') + "."

        val pool = Executors.newFixedThreadPool(64)
        val done = AtomicInteger()
        val total = 254
        for (i in 1..254) {
            val ip = prefix + i
            if (ip == myIp) {
                if (done.incrementAndGet() == total) pool.shutdown()
                continue
            }
            pool.execute {
                try {
                    val s = Socket()
                    s.connect(InetSocketAddress(ip, Protocol.PORT), 250)
                    found.add(ip)
                    runOnUiThread {
                        addDeviceButton(ip)
                        tvScanStatus.text = "发现设备：${found.size} 台"
                    }
                    try { s.close() } catch (_: Exception) {}
                } catch (_: Exception) {
                } finally {
                    if (done.incrementAndGet() == total) {
                        pool.shutdown()
                        runOnUiThread { onScanFinished() }
                    }
                }
            }
        }
    }

    private fun onScanFinished() {
        scanning = false
        val list = found.toList()
        when {
            list.isEmpty() -> tvScanStatus.text =
                "未发现被控端。请确认：\n1. 手机端已点击「开始投屏」并授权\n2. 两台设备连接同一 Wi-Fi\n3. 路由器未开启「AP 隔离/访客网络」"
            list.size == 1 -> {
                tvScanStatus.text = "发现设备 ${list[0]}，正在连接…"
                startConnect(list[0], etPin.text.toString().ifBlank { "123456" })
            }
            else -> tvScanStatus.text = "发现 ${list.size} 台设备，请点击列表中的按钮连接"
        }
    }

    private fun addDeviceButton(ip: String) {
        val b = Button(this)
        b.text = "连接 $ip"
        b.setOnClickListener {
            startConnect(ip, etPin.text.toString().ifBlank { "123456" })
        }
        deviceList.addView(b)
    }

    /** 取本机局域网 IPv4，优先私网地址 */
    private fun localLanIp(): String? {
        val candidates = ArrayList<String>()
        try {
            val en = NetworkInterface.getNetworkInterfaces()
            while (en.hasMoreElements()) {
                val nif = en.nextElement()
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        addr.hostAddress?.let { candidates.add(it) }
                    }
                }
            }
        } catch (_: Exception) {
        }
        return candidates.firstOrNull { it.startsWith("192.168.") }
            ?: candidates.firstOrNull { it.startsWith("10.") }
            ?: candidates.firstOrNull { it.startsWith("172.") }
            ?: candidates.firstOrNull()
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
                    tvScanStatus.text =
                        "连接 $ip 失败（${e.message ?: "超时"}）。\n若是密码错误请修改密码后重试；否则请确认手机端投屏仍在运行。"
                    panelConnect.visibility = View.VISIBLE
                }
                connected = false
                try {
                    socket?.close()
                } catch (_: Exception) {
                }
                socket = null
                out = null
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

    override fun onDestroy() {
        super.onDestroy()
        connected = false
        try {
            socket?.close()
        } catch (_: Exception) {
        }
        decoder?.release()
        decoder = null
    }
}
