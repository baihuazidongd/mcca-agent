package com.mcca.mobile.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "mcca")

data class Args(
    val relayHost: String = DEFAULT_RELAY_HOST,
    val token: String = "",
    val lanHost: String = "",
    val notify: Boolean = true,
    /** system | dark | light */
    val theme: String = "system",
    /** auto | lan | relay —— 连接方式（App「我的」里可切） */
    val connMode: String = "auto",
    /** 上次成功的 ws 端点：冷启动先直连它，不用等 UDP 发现 */
    val lastEndpoint: String = "",
    /** 事件板清空水位：≤ 这个 id 的条目不显示（与 portal 端 localStorage 同语义） */
    val boardClearedUpTo: Long = 0,
    /** 事件板已读水位：用于底部 tab 未读角标 */
    val boardSeenUpTo: Long = 0,
    /** 右滑删掉的事件 id，逗号分隔。服务端没删成时刷新也不会再冒出来。 */
    val boardDismissed: String = "",
) {
    companion object {
        /** 留空即仅局域网可用；在「我的 → 服务器」填一次自己的中转地址后走公网 */
        const val DEFAULT_RELAY_HOST = ""

        /** 旧中转（203.195.206.245，租约到期弃用）：存量配置自动迁到新地址 */
        const val LEGACY_RELAY_HOST = "203.195.206.245/mcca"
    }
}

class Prefs(private val context: Context) {
    private val kRelay = stringPreferencesKey("relayHost")
    private val kToken = stringPreferencesKey("token")
    private val kLan = stringPreferencesKey("lanHost")
    private val kNotify = booleanPreferencesKey("notify")
    private val kTheme = stringPreferencesKey("theme")
    private val kConnMode = stringPreferencesKey("connMode")
    private val kLastEndpoint = stringPreferencesKey("lastEndpoint")
    private val kBoardCleared = longPreferencesKey("boardClearedUpTo")
    private val kBoardSeen = longPreferencesKey("boardSeenUpTo")
    private val kBoardDismissed = stringPreferencesKey("boardDismissed")

    val flow: Flow<Args> = context.dataStore.data.map { p ->
        Args(
            // 没填过、或还指着已弃用的旧中转，都落到默认地址（默认留空 = 仅局域网）
            relayHost = when (val v = p[kRelay]) {
                null -> Args.DEFAULT_RELAY_HOST
                Args.LEGACY_RELAY_HOST -> Args.DEFAULT_RELAY_HOST
                Args.LEGACY_RELAY_HOST.trimEnd('/') -> Args.DEFAULT_RELAY_HOST
                else -> v
            },
            token = p[kToken] ?: "",
            lanHost = p[kLan] ?: "",
            notify = p[kNotify] ?: true,
            theme = p[kTheme] ?: "system",
            connMode = p[kConnMode] ?: "auto",
            lastEndpoint = p[kLastEndpoint] ?: "",
            boardClearedUpTo = p[kBoardCleared] ?: 0L,
            boardSeenUpTo = p[kBoardSeen] ?: 0L,
            boardDismissed = p[kBoardDismissed] ?: "",
        )
    }

    suspend fun save(args: Args) {
        context.dataStore.edit { p ->
            p[kRelay] = args.relayHost.trim()
            p[kToken] = args.token.trim()
            p[kLan] = args.lanHost.trim()
            p[kNotify] = args.notify
            p[kTheme] = args.theme
            p[kConnMode] = args.connMode
            p[kLastEndpoint] = args.lastEndpoint
            p[kBoardCleared] = args.boardClearedUpTo
            p[kBoardSeen] = args.boardSeenUpTo
            p[kBoardDismissed] = args.boardDismissed
        }
    }
}
