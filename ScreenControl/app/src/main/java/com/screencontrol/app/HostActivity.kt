package com.screencontrol.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.screencontrol.app.net.Protocol

class HostActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var tvA11y: TextView
    private lateinit var etPin: EditText

    private val handler = Handler(Looper.getMainLooper())

    private val poll = object : Runnable {
        override fun run() {
            tvStatus.text = "状态：" + HostService.statusText
            tvA11y.text = if (ControlAccessibilityService.enabled) {
                "无障碍服务：已开启（可接收触控）"
            } else {
                "无障碍服务：未开启（无法接收触控）"
            }
            handler.postDelayed(this, 500)
        }
    }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            launchProjection()
        }

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            if (r.resultCode == RESULT_OK && r.data != null) {
                val i = Intent(this, HostService::class.java)
                    .setAction(HostService.ACTION_START)
                    .putExtra(HostService.EXTRA_RESULT_CODE, r.resultCode)
                    .putExtra(HostService.EXTRA_RESULT_DATA, r.data)
                ContextCompat.startForegroundService(this, i)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_host)

        tvStatus = findViewById(R.id.tvStatus)
        tvA11y = findViewById(R.id.tvA11y)
        etPin = findViewById(R.id.etPin)

        findViewById<TextView>(R.id.tvIp).text =
            "本机 IP：${Protocol.localIpAddress()}（端口 ${Protocol.PORT}）"

        findViewById<Button>(R.id.btnStart).setOnClickListener {
            HostService.pin = etPin.text.toString().ifBlank { "123456" }
            if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                launchProjection()
            }
        }

        findViewById<Button>(R.id.btnStop).setOnClickListener {
            stopService(Intent(this, HostService::class.java))
        }

        findViewById<Button>(R.id.btnA11y).setOnClickListener {
            startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
    }

    private fun launchProjection() {
        val mpm = getSystemService(MediaProjectionManager::class.java) ?: return
        projectionLauncher.launch(mpm.createScreenCaptureIntent())
    }

    override fun onResume() {
        super.onResume()
        handler.post(poll)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(poll)
    }
}
