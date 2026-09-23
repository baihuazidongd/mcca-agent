package com.mcca.mobile.data

import android.content.Context
import java.io.File

/**
 * 本地快照：会话列表 + 每个会话最近的消息。
 *
 * 目的：进程重启/应用升级后**秒开**（先渲染上次的快照，再后台与服务端对齐），
 * 而不是每次都白屏等网络。卸载重装会连内部存储一起清掉（Android 行为），
 * 那种情况只能重新拉；升级安装、杀进程重启都会命中这里的缓存。
 */
object Cache {
    private const val MAX_MESSAGES = 400

    private fun dir(context: Context): File =
        File(context.filesDir, "cache").apply { if (!exists()) mkdirs() }

    private fun sessionsFile(context: Context): File = File(dir(context), "sessions.json")

    private fun messagesFile(context: Context, key: String): File {
        val safe = key.replace(Regex("[^A-Za-z0-9_.-]"), "_").take(120)
        return File(dir(context), "msg-$safe.json")
    }

    fun saveSessions(context: Context, json: String) {
        runCatching {
            val tmp = File(dir(context), "sessions.json.tmp")
            tmp.writeText(json)
            tmp.renameTo(sessionsFile(context))
        }
    }

    fun loadSessions(context: Context): String? =
        runCatching { sessionsFile(context).takeIf { it.isFile }?.readText() }.getOrNull()

    fun saveMessages(context: Context, key: String, json: String) {
        runCatching {
            val file = messagesFile(context, key)
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(json)
            tmp.renameTo(file)
        }
    }

    fun loadMessages(context: Context, key: String): String? =
        runCatching { messagesFile(context, key).takeIf { it.isFile }?.readText() }.getOrNull()

    fun removeMessages(context: Context, key: String) {
        runCatching { messagesFile(context, key).delete() }
    }

    fun messagesLimit(): Int = MAX_MESSAGES
}
