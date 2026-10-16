package com.example.netmonitor

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities

/**
 * 监听系统默认网络的切换、能力与链路信息，写入全局状态并记录事件。
 */
object NetworkWatcher {

    @Volatile
    private var registered = false
    private var lastType = "—"

    fun register(context: Context) {
        if (registered) return
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        registered = true
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                report(cm, network, justAvailable = true)
            }

            override fun onLost(network: Network) {
                MonitorState.addEvent(EventType.WARN, "网络连接丢失")
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                report(cm, network, justAvailable = false)
            }

            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                report(cm, network, justAvailable = false)
            }
        })
    }

    private fun typeName(caps: NetworkCapabilities?): String = when {
        caps == null -> "未知网络"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WiFi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "移动数据"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "以太网"
        else -> "其他网络"
    }

    @Synchronized
    private fun report(cm: ConnectivityManager, network: Network, justAvailable: Boolean) {
        val caps = cm.getNetworkCapabilities(network)
        val lp = cm.getLinkProperties(network)
        val type = typeName(caps)

        val sb = StringBuilder()
        lp?.linkAddresses
            ?.firstOrNull { it.address?.address?.size == 4 }
            ?.let { sb.append("IP: ").append(it.address.hostAddress).append("   ") }
        lp?.dnsServers
            ?.take(2)
            ?.forEach { sb.append("DNS: ").append(it.hostAddress).append("   ") }
        MonitorState.netType.value = type
        MonitorState.netDetail.value = sb.toString().trim()

        if (type != lastType) {
            if (lastType == "—") {
                MonitorState.addEvent(EventType.INFO, "当前网络: $type")
            } else {
                MonitorState.addEvent(
                    if (justAvailable) EventType.INFO else EventType.WARN,
                    "网络切换: $lastType → $type"
                )
            }
            lastType = type
        }
    }
}
