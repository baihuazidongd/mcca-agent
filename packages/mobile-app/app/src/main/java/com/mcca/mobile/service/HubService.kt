package com.mcca.mobile.service

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.mcca.mobile.Notifier
import com.mcca.mobile.net.Hub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** 前台服务：把 WS 连接与任务通知钉在后台（QQ 式的「在线」语义）。 */
class HubService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var job: Job? = null

    override fun onCreate() {
        super.onCreate()
        val notification = Notifier.connection(this, "正在连接桌面…")
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(Notifier.ID_CONN, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(Notifier.ID_CONN, notification)
        }
        job = scope.launch {
            Hub.conn.collect { conn ->
                val text = when {
                    conn.online && conn.mode == Hub.Mode.LAN -> "局域网直连 · ${conn.desktop?.name ?: "桌面"}"
                    conn.online -> "公网中转 · ${conn.desktop?.name ?: "桌面"}"
                    else -> conn.detail
                }
                val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
                nm.notify(Notifier.ID_CONN, Notifier.connection(this@HubService, text))
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
