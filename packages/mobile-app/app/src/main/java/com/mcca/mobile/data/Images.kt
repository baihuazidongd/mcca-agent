package com.mcca.mobile.data

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.LruCache
import com.google.gson.JsonObject
import com.mcca.mobile.net.Hub
import com.mcca.mobile.net.Proto
import com.mcca.mobile.store.Img
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 图片：拉取（桥 RPC）→ 解码 → 内存缓存；保存到相册。
 * 三类来源：内联 base64（pi 工具缩略图）、dsh 附件 id、pi 工作区文件路径。
 */
object Images {
    private val cache = object : LruCache<String, Bitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val failures = mutableSetOf<String>()

    fun cached(img: Img): Bitmap? = cache.get(img.key)

    fun failed(img: Img): Boolean = failures.contains(img.key)

    suspend fun load(agent: String, sessionId: String, img: Img): Bitmap? {
        cache.get(img.key)?.let { return it }
        if (failures.contains(img.key)) return null
        val bitmap = withContext(Dispatchers.IO) {
            try {
                val base64 = when {
                    img.data.isNotEmpty() -> img.data
                    else -> fetch(agent, sessionId, img)
                }
                if (base64.isEmpty()) null else decode(base64)
            } catch (_: Throwable) {
                null
            }
        }
        if (bitmap != null) cache.put(img.key, bitmap) else failures.add(img.key)
        return bitmap
    }

    private suspend fun fetch(agent: String, sessionId: String, img: Img): String {
        val params = JsonObject().apply {
            addProperty("agent", agent)
            addProperty("sessionId", sessionId)
            if (img.attachmentId.isNotEmpty()) addProperty("attachmentId", img.attachmentId)
            if (img.path.isNotEmpty()) addProperty("path", img.path)
        }
        val res = Hub.call("file.get", params, 40_000)
        val d = Proto.obj(res, "d") ?: return ""
        if (d.has("ok") && !Proto.bool(d, "ok", true)) return ""
        return Proto.str(d, "data")
    }

    fun decode(base64: String): Bitmap? = try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        val maxSide = maxOf(bounds.outWidth, bounds.outHeight)
        while (maxSide / sample > 1600) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    } catch (_: Throwable) {
        null
    }

    /** 保存到相册：API 29+ 走 MediaStore，低版本落到应用专属目录。 */
    suspend fun saveToGallery(context: Context, bitmap: Bitmap, name: String = "mcca-${System.currentTimeMillis()}.png"): String? =
        withContext(Dispatchers.IO) {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    val values = ContentValues().apply {
                        put(MediaStore.Images.Media.DISPLAY_NAME, name)
                        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/mcca")
                    }
                    val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return@withContext null
                    context.contentResolver.openOutputStream(uri)?.use { out ->
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                    } ?: return@withContext null
                    "相册/Pictures/mcca"
                } else {
                    val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_PICTURES), "mcca").apply { mkdirs() }
                    val file = File(dir, name)
                    file.outputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) }
                    file.absolutePath
                }
            } catch (_: Throwable) {
                null
            }
        }
}
