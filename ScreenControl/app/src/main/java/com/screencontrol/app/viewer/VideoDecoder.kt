package com.screencontrol.app.viewer

import android.media.MediaCodec
import android.media.MediaFormat
import android.view.Surface
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 控制端视频解码器：H.264 硬解，输出渲染到 Surface。
 * 配置帧（CODEC_CONFIG）作为带 flag 的输入缓冲喂给解码器。
 */
class VideoDecoder(
    private val surface: Surface,
    private val onFormatChanged: ((width: Int, height: Int) -> Unit)? = null
) {

    data class Packet(val ptsUs: Long, val flags: Int, val data: ByteArray)

    private val queue = ArrayBlockingQueue<Packet>(64)
    private val codec: MediaCodec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)

    @Volatile
    private var running = false
    private var thread: Thread? = null

    fun start() {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1280, 720)
        codec.configure(format, surface, null, 0)
        codec.start()
        running = true
        thread = thread(name = "decode") {
            val info = MediaCodec.BufferInfo()
            while (running) {
                try {
                    // 喂输入
                    val packet = queue.poll(20, TimeUnit.MILLISECONDS)
                    if (packet != null) {
                        val idx = codec.dequeueInputBuffer(10_000)
                        if (idx >= 0) {
                            val ib = codec.getInputBuffer(idx)
                            if (ib != null && ib.capacity() >= packet.data.size) {
                                ib.clear()
                                ib.put(packet.data)
                                codec.queueInputBuffer(idx, 0, packet.data.size, packet.ptsUs, packet.flags)
                            }
                        } else {
                            queue.offer(packet) // 输入缓冲暂满，放回
                        }
                    }
                    // 取输出并渲染
                    var outIdx = codec.dequeueOutputBuffer(info, 0)
                    while (outIdx >= 0) {
                        codec.releaseOutputBuffer(outIdx, true)
                        outIdx = codec.dequeueOutputBuffer(info, 0)
                    }
                    if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        val f = codec.outputFormat
                        onFormatChanged?.invoke(
                            f.getInteger(MediaFormat.KEY_WIDTH),
                            f.getInteger(MediaFormat.KEY_HEIGHT)
                        )
                    }
                } catch (e: Exception) {
                    if (running) break
                }
            }
        }
    }

    fun enqueue(ptsUs: Long, flags: Int, data: ByteArray) {
        if (!running) return
        val p = Packet(ptsUs, flags, data)
        if (!queue.offer(p)) {
            queue.poll() // 丢旧帧保实时
            queue.offer(p)
        }
    }

    fun release() {
        running = false
        try {
            thread?.join(500)
        } catch (_: InterruptedException) {
        }
        try {
            codec.stop()
        } catch (_: Exception) {
        }
        try {
            codec.release()
        } catch (_: Exception) {
        }
    }
}
