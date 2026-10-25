package com.screencontrol.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * 无障碍服务：负责把远端（平板）发来的触控事件注入到本机。
 *
 * 使用 StrokeDescription 的 willContinue/continueStroke 机制实现连续手势：
 * down 开始一条描边链，move 追加线段，up 发送最后一段结束。
 * 心跳定时器保证手指悬停（长按）时接触不中断。
 */
class ControlAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "TouchInjector"
        private const val SEGMENT_MS = 30L        // 每段描边时长
        private const val HEARTBEAT_MS = 80L      // 悬停续命间隔

        @Volatile
        private var instance: ControlAccessibilityService? = null

        val enabled: Boolean get() = instance != null

        fun inject(action: String, x: Float, y: Float) {
            val svc = instance ?: return
            svc.handler.post { svc.onRemoteTouch(action, x, y) }
        }

        fun global(key: String) {
            val svc = instance ?: return
            svc.handler.post {
                when (key) {
                    "back" -> svc.performGlobalAction(GLOBAL_ACTION_BACK)
                    "home" -> svc.performGlobalAction(GLOBAL_ACTION_HOME)
                    "recents" -> svc.performGlobalAction(GLOBAL_ACTION_RECENTS)
                }
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())

    // 以下状态仅主线程访问
    private var chain: GestureDescription.StrokeDescription? = null // 最近一次已派发的描边
    private var lastX = 0f   // 已包含在 chain 路径中的点
    private var lastY = 0f
    private var targetX = 0f // 最新目标点
    private var targetY = 0f
    private var upPending = false
    private var inFlight = false
    private var heartbeat: Runnable? = null
    // 每次新触摸自增；旧手势的回调通过代数比对避免误清新手势状态
    private var generation = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        stopHeartbeat()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    fun onRemoteTouch(action: String, x: Float, y: Float) {
        when (action) {
            "down" -> beginTouch(x, y)
            "move" -> if (chain != null && !upPending) {
                targetX = x
                targetY = y
                pump()
            }
            "up" -> if (chain != null) {
                targetX = x
                targetY = y
                upPending = true
                pump()
            }
        }
    }

    private fun beginTouch(x: Float, y: Float) {
        // 上一次手势未正常结束时，直接重新开始（系统会取消旧手势）
        generation++
        upPending = false
        inFlight = false
        targetX = x
        targetY = y
        lastX = x
        lastY = y
        val path = Path().apply {
            moveTo(x, y)
            lineTo(x + 0.5f, y + 0.5f) // 避免零长度路径被拒绝
        }
        chain = GestureDescription.StrokeDescription(path, 0, SEGMENT_MS, true)
        dispatchCurrent()
        startHeartbeat()
    }

    /** 尝试把「上次已发送点到目标点」的一段追加到手势链上 */
    private fun pump() {
        val base = chain ?: return
        if (inFlight) return
        if (targetX == lastX && targetY == lastY && !upPending) return // 无新数据
        val g = generation
        val path = Path().apply {
            moveTo(lastX, lastY)
            lineTo(targetX, targetY)
        }
        val seg = base.continueStroke(path, 0, SEGMENT_MS, !upPending)
        inFlight = true
        val gesture = GestureDescription.Builder().addStroke(seg).build()
        val ok = dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    if (g != generation) return
                    inFlight = false
                    lastX = targetX
                    lastY = targetY
                    if (upPending) {
                        chain = null
                        upPending = false
                        stopHeartbeat()
                    } else {
                        chain = seg
                        pump()
                    }
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    if (g != generation) return
                    Log.w(TAG, "gesture cancelled")
                    inFlight = false
                    chain = null
                    upPending = false
                    stopHeartbeat()
                }
            },
            null
        )
        if (!ok) {
            if (g != generation) return
            inFlight = false
            chain = null
            upPending = false
            stopHeartbeat()
        }
    }

    private fun dispatchCurrent() {
        val base = chain ?: return
        val g = generation
        val gesture = GestureDescription.Builder().addStroke(base).build()
        val ok = dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    if (g != generation) return
                    pump()
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    if (g != generation) return
                    Log.w(TAG, "initial gesture cancelled")
                    chain = null
                    upPending = false
                    stopHeartbeat()
                }
            },
            null
        )
        if (!ok) {
            if (g != generation) return
            chain = null
            stopHeartbeat()
        }
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        val r = object : Runnable {
            override fun run() {
                if (chain != null && !upPending) pump()
                if (chain != null) {
                    handler.postDelayed(this, HEARTBEAT_MS)
                }
            }
        }
        heartbeat = r
        handler.postDelayed(r, HEARTBEAT_MS)
    }

    private fun stopHeartbeat() {
        heartbeat?.let { handler.removeCallbacks(it) }
        heartbeat = null
    }
}
