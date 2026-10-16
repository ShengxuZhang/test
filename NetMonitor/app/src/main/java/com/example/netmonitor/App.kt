package com.example.netmonitor

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "网络监测", NotificationManager.IMPORTANCE_LOW).apply {
                description = "持续监测网络延迟与连接状态"
                setShowBadge(false)
            }
        )
        NetworkWatcher.register(this)
    }

    companion object {
        const val CHANNEL_ID = "network_monitor"
    }
}
