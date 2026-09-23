package com.mcca.mobile

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.mcca.mobile.data.Prefs
import com.mcca.mobile.net.Hub
import com.mcca.mobile.store.Notice
import com.mcca.mobile.store.Store
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

object AppState {
    @Volatile var foreground = false
    @Volatile var currentSession = ""
    @Volatile var notifyEnabled = true
}

object Notifier {
    const val CH_CONN = "conn"
    /** 任务提醒用新通道：IMPORTANCE_HIGH 才能弹横幅（通道建好后重要性改不了，只能换 id） */
    const val CH_TASK = "task_alert"
    const val CH_BOARD = "board"
    const val ID_CONN = 1
    const val ID_SUMMARY = 2
    private const val GROUP = "mcca"
    private var seq = 100
    private var badge = 0

    fun init(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CH_CONN, "连接状态", NotificationManager.IMPORTANCE_MIN).apply {
                description = "保持与桌面的连接"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_TASK, "任务通知", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "任务完成 / 失败提醒（弹横幅 + 提示音）"
                enableVibration(true)
                setShowBadge(true)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_BOARD, "事件板", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "你在会话里要求推到事件板的记录"
                enableVibration(true)
            },
        )
    }

    fun enabled(context: Context): Boolean = Background.notificationsOn(context)

    /** 「我的」里的测试按钮：确认通知能弹（后台/锁屏时也该弹）。 */
    fun test(context: Context) {
        push(
            context,
            Notice(
                id = "test",
                title = "mcca 测试通知",
                body = "看到这条说明通知正常。把 App 划到后台，任务跑完也会这样提醒你。",
                at = System.currentTimeMillis(),
                kind = "auto",
            ),
        )
    }

    private fun contentIntent(context: Context, sessionId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra("sessionId", sessionId)
        }
        return PendingIntent.getActivity(
            context,
            sessionId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun boardIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra("openBoard", true)
        }
        return PendingIntent.getActivity(
            context,
            "board".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun builder(context: Context, channel: String) =
        if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, channel)
        else @Suppress("DEPRECATION") Notification.Builder(context)

    fun connection(context: Context, text: String): Notification =
        builder(context, CH_CONN)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("mcca")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent(context, ""))
            .build()

    /** 事件板条目走「事件板」通道（高优先、有震动），自动播报走「任务通知」。 */
    fun push(context: Context, notice: Notice) {
        if (!AppState.notifyEnabled) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val id = ++seq
        badge += 1
        val isBoard = notice.isBoard
        val n = builder(context, if (isBoard) CH_BOARD else CH_TASK)
            .setSmallIcon(
                when {
                    notice.kind == "error" -> android.R.drawable.stat_notify_error
                    isBoard -> android.R.drawable.ic_dialog_info
                    else -> android.R.drawable.stat_notify_sync_noanim
                },
            )
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setStyle(Notification.BigTextStyle().bigText(notice.body))
            .setAutoCancel(true)
            .setGroup(GROUP)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .setNumber(badge)
            .setCategory(if (isBoard) Notification.CATEGORY_MESSAGE else Notification.CATEGORY_STATUS)
            .setContentIntent(
                if (notice.sessionId.isNotEmpty()) contentIntent(context, notice.sessionId)
                else boardIntent(context),
            )
            .build()
        try {
            nm.notify(id, n)
            // 摘要（QQ/微信式分组）：走静默通道，只为把多条收进一组，不额外响一声
            nm.notify(
                ID_SUMMARY,
                builder(context, CH_CONN)
                    .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                    .setContentTitle("mcca · $badge 条新消息")
                    .setContentText("点开查看任务完成 / 事件板提醒")
                    .setGroup(GROUP)
                    .setGroupSummary(true)
                    .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
                    .setAutoCancel(true)
                    .setContentIntent(boardIntent(context))
                    .build(),
            )
        } catch (_: SecurityException) {
            // 通知权限未授予：连接服务仍在，事件在 App 内仍可见
        }
    }
}

class MccaApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    lateinit var prefs: Prefs
        private set

    override fun onCreate() {
        super.onCreate()
        Notifier.init(this)
        prefs = Prefs(this)
        Store.init(this)
        Store.attach(scope)
        // 探测/发现到可用的局域网地址就记住（覆盖旧的过期地址）：下次冷启动直接直连
        Hub.onLearnLan = { host ->
            scope.launch {
                val current = prefs.flow.first()
                if (host.isNotBlank() && current.lanHost != host) {
                    prefs.save(current.copy(lanHost = host))
                }
            }
        }
        // 记住最后成功的 WS 端点：划掉 App 重开直接连它，不再等 UDP 发现
        Hub.onLearnEndpoint = { endpoint ->
            scope.launch {
                val current = prefs.flow.first()
                if (endpoint.isNotBlank() && current.lastEndpoint != endpoint) {
                    prefs.save(current.copy(lastEndpoint = endpoint))
                }
            }
        }
        Store.onNotice = { notice ->
            // 事件板条目一定弹（那是用户点名要推的）；会话内的自动播报正在看就不打扰
            val viewing = AppState.foreground &&
                notice.sessionId.isNotEmpty() &&
                notice.sessionId == AppState.currentSession
            if (notice.isBoard || !viewing) Notifier.push(this, notice)
        }
        // 事件板水位：清空/已读都落盘，跟 portal 端 localStorage 一样跨重启保留
        Store.onBoardCursor = { cleared, seen ->
            scope.launch {
                val current = prefs.flow.first()
                prefs.save(current.copy(boardClearedUpTo = cleared, boardSeenUpTo = seen))
            }
        }
        Store.onBoardDismiss = { dismissed ->
            scope.launch {
                val current = prefs.flow.first()
                if (current.boardDismissed != dismissed) prefs.save(current.copy(boardDismissed = dismissed))
            }
        }
        scope.launch {
            prefs.flow.collect { args ->
                AppState.notifyEnabled = args.notify
                Store.syncBoardCursor(args.boardClearedUpTo, args.boardSeenUpTo)
                Store.syncDismissed(args.boardDismissed)
                Hub.start(this@MccaApp, args)
            }
        }
    }
}
