package com.example.netmonitor

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class LogAdapter : RecyclerView.Adapter<LogAdapter.VH>() {

    private val data = ArrayList<LogEvent>()
    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())

    fun submit(list: List<LogEvent>) {
        data.clear()
        data.addAll(list)
        notifyDataSetChanged()
    }

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val msg: TextView = v.findViewById(R.id.tvMsg)
        val time: TextView = v.findViewById(R.id.tvTime)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(LayoutInflater.from(parent.context).inflate(R.layout.item_log, parent, false))

    override fun getItemCount() = data.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val e = data[position]
        holder.msg.text = e.message
        holder.msg.setTextColor(
            when (e.type) {
                EventType.INFO -> 0xFF444444.toInt()
                EventType.WARN -> 0xFFE65100.toInt()
                EventType.BAD -> 0xFFC62828.toInt()
            }
        )
        holder.time.text = fmt.format(Date(e.time))
    }
}
