package com.screencontrol.app.net

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.net.Inet4Address
import java.net.NetworkInterface
import java.nio.ByteBuffer

/**
 * TCP 帧协议。
 *
 * 帧格式（大端）：
 * [4 字节 length][1 字节 type][payload]
 * length = type + payload 的总字节数。
 *
 * type = 1 : JSON 消息（握手认证 / 触控 / 按键）
 * type = 2 : 视频帧，payload = [8 字节 ptsUs][4 字节 flags][H.264 数据]
 */
object Protocol {

    const val PORT = 4747
    const val MSG_JSON = 1
    const val MSG_VIDEO = 2
    const val NSD_SERVICE_TYPE = "_screenctl._tcp."
    private const val MAX_FRAME = 16 * 1024 * 1024

    /** 写一条 JSON 消息（线程安全，发送视频与 JSON 共用同一把锁） */
    fun writeJson(out: DataOutputStream, json: String) {
        val payload = json.toByteArray(Charsets.UTF_8)
        synchronized(out) {
            out.writeInt(payload.size + 1)
            out.writeByte(MSG_JSON)
            out.write(payload)
            out.flush()
        }
    }

    /** 读一帧，返回 type 与 payload；流结束或帧非法时抛 EOFException */
    fun readFrame(inp: DataInputStream): Pair<Int, ByteArray> {
        val len = inp.readInt()
        if (len < 1 || len > MAX_FRAME) throw EOFException("bad frame length $len")
        val type = inp.readByte().toInt()
        val payload = ByteArray(len - 1)
        inp.readFully(payload)
        return type to payload
    }

    /** 解析视频帧 payload，返回 (ptsUs, flags, h264数据) */
    fun parseVideo(payload: ByteArray): Triple<Long, Int, ByteArray> {
        val buf = ByteBuffer.wrap(payload)
        val pts = buf.long
        val flags = buf.int
        val data = ByteArray(buf.remaining())
        buf.get(data)
        return Triple(pts, flags, data)
    }

    /** 本机局域网 IPv4 地址 */
    fun localIpAddress(): String {
        try {
            val en = NetworkInterface.getNetworkInterfaces()
            while (en.hasMoreElements()) {
                val nif = en.nextElement()
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        return addr.hostAddress ?: continue
                    }
                }
            }
        } catch (_: Exception) {
        }
        return "?"
    }
}
