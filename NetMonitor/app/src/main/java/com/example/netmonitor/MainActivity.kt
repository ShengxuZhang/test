package com.example.netmonitor

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var tvNetType: TextView
    private lateinit var tvCur: TextView
    private lateinit var tvDetail: TextView
    private lateinit var chart: LatencyChartView
    private lateinit var tvAvg: TextView
    private lateinit var tvMax: TextView
    private lateinit var tvJitter: TextView
    private lateinit var tvLoss: TextView
    private lateinit var btnToggle: Button
    private lateinit var btnSpeed: Button
    private lateinit var btnLog: Button
    private lateinit var btnExport: Button
    private lateinit var tvSpeed: TextView

    private var speedJob: Job? = null

    private val storagePerm =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) doExport() else toast("未授予存储权限，无法导出")
        }

    private val notifPerm =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvNetType = findViewById(R.id.tvNetType)
        tvCur = findViewById(R.id.tvCur)
        tvDetail = findViewById(R.id.tvDetail)
        chart = findViewById(R.id.chart)
        tvAvg = findViewById(R.id.tvAvg)
        tvMax = findViewById(R.id.tvMax)
        tvJitter = findViewById(R.id.tvJitter)
        tvLoss = findViewById(R.id.tvLoss)
        btnToggle = findViewById(R.id.btnToggle)
        btnSpeed = findViewById(R.id.btnSpeed)
        btnLog = findViewById(R.id.btnLog)
        btnExport = findViewById(R.id.btnExport)
        tvSpeed = findViewById(R.id.tvSpeed)

        btnToggle.setOnClickListener { toggle() }
        btnSpeed.setOnClickListener { testSpeed() }
        btnLog.setOnClickListener { startActivity(Intent(this, LogActivity::class.java)) }
        btnExport.setOnClickListener { export() }

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { MonitorState.netType.collect { tvNetType.text = it } }
                launch {
                    combine(MonitorState.netDetail, MonitorState.wifiRssi) { d, rssi ->
                        var s = d
                        if (rssi != null) {
                            val grade = when {
                                rssi >= -55 -> "强"
                                rssi >= -65 -> "良好"
                                rssi >= -75 -> "一般"
                                else -> "弱"
                            }
                            s += "  信号: ${rssi}dBm ($grade)"
                        }
                        s.ifEmpty { "—" }
                    }.collect { tvDetail.text = it }
                }
                launch {
                    MonitorState.latency.collect {
                        tvCur.text = it?.let { ms -> "${ms}ms" } ?: "超时"
                        tvCur.setTextColor(
                            when {
                                it == null -> 0xFFC62828.toInt()
                                it >= MonitorState.SPIKE_MS -> 0xFFE65100.toInt()
                                else -> 0xFF1565C0.toInt()
                            }
                        )
                    }
                }
                launch {
                    MonitorState.stats.collect { st ->
                        tvAvg.text = "${st.avg}ms"
                        tvMax.text = "${st.max}ms"
                        tvJitter.text = "${st.jitter}ms"
                        tvLoss.text = String.format("%.1f%%", st.lossPct)
                    }
                }
                launch { MonitorState.history.collect { chart.invalidate() } }
                launch {
                    MonitorState.running.collect {
                        btnToggle.text = if (it) "停止监测" else "开始监测"
                    }
                }
                launch { MonitorState.speedText.collect { tvSpeed.text = it } }
            }
        }
    }

    private fun toggle() {
        if (MonitorState.running.value) {
            stopService(Intent(this, NetworkMonitorService::class.java))
        } else {
            ContextCompat.startForegroundService(
                this, Intent(this, NetworkMonitorService::class.java)
            )
        }
    }

    private fun testSpeed() {
        if (speedJob?.isActive == true) return
        MonitorState.speedText.value = "测速中…"
        speedJob = lifecycleScope.launch(Dispatchers.IO) {
            val result = SpeedTester.test { s -> MonitorState.speedText.value = s }
            withContext(Dispatchers.Main) {
                MonitorState.speedText.value = result
                MonitorState.addEvent(
                    if (result.startsWith("测速失败")) EventType.BAD else EventType.INFO,
                    "测速: $result"
                )
            }
        }
    }

    private fun export() {
        if (Build.VERSION.SDK_INT >= 29) {
            doExport()
        } else if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED
        ) {
            doExport()
        } else {
            storagePerm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }

    private fun doExport() {
        lifecycleScope.launch(Dispatchers.IO) {
            val msg = Exporter.export(this@MainActivity)
            withContext(Dispatchers.Main) { toast(msg) }
        }
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
