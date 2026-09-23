package com.mcca.mobile.data

import android.content.Context
import android.graphics.Bitmap
import android.util.Base64
import android.util.LruCache
import com.google.gson.JsonObject
import com.mcca.mobile.net.Hub
import com.mcca.mobile.net.Proto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

/**
 * 角色头像（pi 的像素画）：桥从 pi-web 的 avatars 素材里按同一套 hash 取。
 * 失败会在一段时间后允许重试（早先一次性失败就永远缺失，列表里就会缺口）；
 * 会话列表刷新时后台批量预取，滚到哪都有图。
 */
object Avatars {
    private val cache = object : LruCache<String, Bitmap>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val missAt = ConcurrentHashMap<String, Long>()
    private val loading = ConcurrentHashMap.newKeySet<String>()
    private const val RETRY_MS = 8_000L

    private fun keyOf(agent: String, id: String, role: String) = "av:$agent:$role:$id"

    fun cached(agent: String, id: String, role: String = ""): Bitmap? = cache.get(keyOf(agent, id, role))

    private fun recentlyMissing(key: String): Boolean {
        val at = missAt[key] ?: return false
        if (System.currentTimeMillis() - at < RETRY_MS) return true
        missAt.remove(key)
        return false
    }

    suspend fun load(agent: String, id: String, role: String = ""): Bitmap? {
        if (agent != "pi") return null
        val key = keyOf(agent, id, role)
        cache.get(key)?.let { return it }
        if (recentlyMissing(key)) return null
        if (!loading.add(key)) return null
        val bitmap = withContext(Dispatchers.IO) {
            try {
                val params = JsonObject().apply {
                    addProperty("agent", agent)
                    addProperty("id", id)
                    if (role.isNotEmpty()) addProperty("role", role)
                }
                val res = Hub.call("avatar.get", params, 20_000)
                val d = Proto.obj(res, "d") ?: return@withContext null
                val data = Proto.str(d, "data")
                if (data.isEmpty()) null else decode(data)
            } catch (_: Throwable) {
                null
            } finally {
                loading.remove(key)
            }
        }
        if (bitmap != null) {
            cache.put(key, bitmap)
            missAt.remove(key)
        } else {
            missAt[key] = System.currentTimeMillis()
        }
        return bitmap
    }

    /** 会话列表刷新后批量预取（限制并发，别把 WS 打满）。 */
    fun prefetch(scope: CoroutineScope, items: List<Triple<String, String, String>>) {
        val targets = items
            .filter { it.first == "pi" }
            .filter { cached(it.first, it.second, it.third) == null }
            .filter { !recentlyMissing(keyOf(it.first, it.second, it.third)) }
            .take(60)
        if (targets.isEmpty()) return
        targets.chunked(4).forEachIndexed { index, chunk ->
            scope.launch {
                if (index > 0) kotlinx.coroutines.delay(index * 150L)
                for ((agent, id, role) in chunk) load(agent, id, role)
            }
        }
    }

    private fun decode(base64: String): Bitmap? = try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (_: Throwable) {
        null
    }
}
