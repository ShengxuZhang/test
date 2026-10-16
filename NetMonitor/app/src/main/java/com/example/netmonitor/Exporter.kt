package com.example.netmonitor

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 把事件日志导出为文本文件（下载/NetMonitor/ 目录）。
 */
object Exporter {

    fun export(context: Context): String {
        val ts = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
        val name = "netmonitor_$ts.txt"
        val text = buildString {
            appendLine("网络监测日志  (导出于 ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())})")
            appendLine("--------------------------------------------------")
            val events = MonitorState.events.value
            if (events.isEmpty()) appendLine("(无事件)")
            events.forEach { e ->
                appendLine(
                    "[${SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(e.time))}] " +
                        label(e.type) + " " + e.message
                )
            }
        }
        return try {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NetMonitor")
                }
                val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return "导出失败：无法创建文件"
                context.contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
                    ?: return "导出失败：无法写入文件"
                "已导出到 下载/NetMonitor/$name"
            } else {
                @Suppress("DEPRECATION")
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "NetMonitor")
                dir.mkdirs()
                val f = File(dir, name)
                f.writeText(text)
                "已导出到 ${f.absolutePath}"
            }
        } catch (e: Exception) {
            "导出失败: ${e.message}"
        }
    }

    private fun label(t: EventType) = when (t) {
        EventType.INFO -> "[信息]"
        EventType.WARN -> "[警告]"
        EventType.BAD -> "[严重]"
    }
}
