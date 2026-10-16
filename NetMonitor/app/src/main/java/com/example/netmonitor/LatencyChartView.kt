package com.example.netmonitor

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import kotlin.math.max

/**
 * 轻量延迟曲线图（无第三方依赖）：
 * 蓝线为延迟，底部红色竖条为超时/丢包，红色虚线为尖峰阈值。
 */
class LatencyChartView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF1565C0.toInt()
        style = Paint.Style.STROKE
        strokeWidth = dp(4f)
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF1565C0.toInt() }
    private val badTick = Paint().apply {
        color = 0xFFE53935.toInt()
        strokeWidth = dp(2f)
    }
    private val grid = Paint().apply {
        color = 0x1F888888.toInt()
        strokeWidth = dp(1f)
    }
    private val threshold = Paint().apply {
        color = 0x66E53935.toInt()
        strokeWidth = dp(1.5f)
        pathEffect = DashPathEffect(floatArrayOf(dp(6f), dp(4f)), 0f)
    }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF9E9E9E.toInt()
        textSize = sp(11f)
    }
    private val empty = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF9E9E9E.toInt()
        textSize = sp(13f)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val data = MonitorState.history.value
        val w = width.toFloat()
        val h = height.toFloat()
        val padL = sp(38f)
        val padB = sp(16f)
        val padT = dp(10f)

        if (data.isEmpty()) {
            val tip = "开始监测后显示延迟曲线"
            canvas.drawText(tip, (w - empty.measureText(tip)) / 2, h / 2, empty)
            return
        }

        val peak = data.filterNotNull().maxOrNull() ?: 0
        val yMax = (max(300, (peak * 1.2).toInt()) + 99) / 100 * 100
        val bottom = h - padB
        val usableH = bottom - padT

        // 网格与刻度
        for (i in 0..4) {
            val y = padT + usableH * i / 4f
            canvas.drawLine(padL, y, w, y, grid)
            val ms = yMax * (4 - i) / 4
            canvas.drawText("${ms}ms", dp(4f), y + sp(4f), label)
        }

        // 尖峰阈值线
        if (yMax >= MonitorState.SPIKE_MS) {
            val ty = bottom - usableH * MonitorState.SPIKE_MS / yMax
            canvas.drawLine(padL, ty, w, ty, threshold)
        }

        // 曲线（null 产生断点）
        val n = data.size
        val usableW = w - padL
        val xAt = { i: Int ->
            if (n <= 1) w / 2 else padL + usableW * i / (n - 1)
        }
        val yAt = { ms: Int -> bottom - usableH * ms / yMax }

        var lastX = 0f
        var lastY = 0f
        var hasLast = false
        for (i in 0 until n) {
            val v = data[i]
            if (v == null) {
                canvas.drawLine(xAt(i), bottom - dp(8f), xAt(i), bottom, badTick)
                hasLast = false
            } else {
                val x = xAt(i)
                val y = yAt(v)
                if (hasLast) canvas.drawLine(lastX, lastY, x, y, line)
                lastX = x; lastY = y; hasLast = true
            }
        }
        if (hasLast) {
            canvas.drawCircle(lastX, lastY, dp(4f), dot)
        }
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun sp(v: Float) = v * resources.displayMetrics.scaledDensity
}
