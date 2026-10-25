package com.screencontrol.app

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        findViewById<Button>(R.id.btnHost).setOnClickListener {
            startActivity(Intent(this, HostActivity::class.java))
        }
        findViewById<Button>(R.id.btnViewer).setOnClickListener {
            startActivity(Intent(this, ViewerActivity::class.java))
        }
    }
}
