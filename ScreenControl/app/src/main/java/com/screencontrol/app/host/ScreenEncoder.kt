package com.screencontrol.app.host

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.view.Surface
import kotlin.concurrent.thread

/**
 * 屏幕编码器：MediaCodec 硬编码 H.264，输入为 VirtualDisplay 的 Surface，
 * 输出回调（含 CODEC_CONFIG 配置帧）交给上层写入网络。
 */
class ScreenEncoder(
    width: Int,
    height: Int,
    private val onFrame: (ptsUs: Long, flags: Int, data: ByteArray) -> Unit
) {

    private val codec: MediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    val inputSurface: Surface
    private val info = MediaCodec.BufferInfo()

    @Volatile
    private var running = false
    private var drainThread: Thread? = null

    init {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 8_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0) // 降低延迟
            }
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        inputSurface = codec.createInputSurface()
        codec.start()
    }

    fun startDrain() {
        running = true
        drainThread = thread(name = "encoder-drain") {
            while (running) {
                try {
                    val index = codec.dequeueOutputBuffer(info, 20_000)
                    if (index >= 0) {
                        val buf = codec.getOutputBuffer(index)
                        if (buf != null && info.size > 0) {
                            val data = ByteArray(info.size)
                            buf.position(info.offset)
                            buf.limit(info.offset + info.size)
                            buf.get(data)
                            onFrame(info.presentationTimeUs, info.flags, data)
                        }
                        codec.releaseOutputBuffer(index, false)
                    }
                    // INFO_OUTPUT_FORMAT_CHANGED / INFO_TRY_AGAIN_LATER 继续循环即可
                } catch (e: Exception) {
                    if (running) break
                }
            }
        }
    }

    fun stop() {
        running = false
        try {
            drainThread?.join(600)
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
        try {
            inputSurface.release()
        } catch (_: Exception) {
        }
    }

    companion object {
        const val FLAG_CODEC_CONFIG = MediaCodec.BUFFER_FLAG_CODEC_CONFIG
        const val FLAG_KEY_FRAME = MediaCodec.BUFFER_FLAG_KEY_FRAME
    }
}
