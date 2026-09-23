package com.mcca.mobile.data

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.google.gson.JsonObject
import com.mcca.mobile.net.Proto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * 应用内更新：中转上的 version.json 判断版本 → 下载 APK（校验 sha256）→ 系统安装器安装。
 *
 * 两种判定路径：
 *  1. 中转发布了 version.json：只读元数据就能判断，不用下整包；
 *  2. 没有元数据：下载整包后用 PackageManager 读包内版本号再判断（兜底）。
 */
object Updater {

    data class Info(
        val versionCode: Int,
        val versionName: String,
        val sha256: String,
        val size: Long,
        val apkUrl: String,
        val builtAt: String,
    )

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    fun currentVersion(context: Context): Pair<Int, String> = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else info.versionCode
        code to info.versionName.orEmpty()
    } catch (_: Throwable) {
        0 to "?"
    }

    private fun baseUrl(relayHost: String): String? {
        val host = relayHost.trim().trimEnd('/')
        if (host.isEmpty()) return null
        return when {
            host.startsWith("http://") || host.startsWith("https://") -> host
            else -> "http://$host"
        }
    }

    /** 没有 version.json 时的兜底下载地址。 */
    fun apkUrl(relayHost: String): String? = baseUrl(relayHost)?.let { "$it/app.apk" }

    /** 读中转上的版本元数据；没有（404/ok:false）返回 null，交给下载后判定的兜底。 */
    suspend fun check(relayHost: String): Info? = withContext(Dispatchers.IO) {
        val base = baseUrl(relayHost) ?: return@withContext null
        try {
            val req = Request.Builder().url("$base/version.json").header("cache-control", "no-store").build()
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return@withContext null
                val json = Proto.parse(res.body?.string() ?: "") ?: return@withContext null
                if (!Proto.bool(json, "ok", false)) return@withContext null
                val code = Proto.long(json, "versionCode").toInt()
                if (code <= 0) return@withContext null
                Info(
                    versionCode = code,
                    versionName = Proto.str(json, "versionName", "?"),
                    sha256 = Proto.str(json, "sha256"),
                    size = Proto.long(json, "size"),
                    apkUrl = "$base${Proto.str(json, "apk", "/app.apk")}",
                    builtAt = Proto.str(json, "builtAt"),
                )
            }
        } catch (_: Throwable) {
            null
        }
    }

    /** 下载安装包到 cacheDir/update；返回文件（失败抛异常）。 */
    suspend fun download(
        context: Context,
        info: Info,
        onProgress: (percent: Int, done: Long, total: Long) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "update").apply { mkdirs() }
        val target = File(dir, "mcca-${info.versionName}-${info.versionCode}.apk")
        if (target.exists() && target.length() > 0 && info.size > 0 && target.length() == info.size
            && (info.sha256.isEmpty() || sha256Of(target) == info.sha256)
        ) {
            onProgress(100, target.length(), target.length())
            return@withContext target
        }
        val tmp = File(dir, "${target.name}.part")
        val req = Request.Builder().url(info.apkUrl).header("cache-control", "no-store").build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("下载失败：HTTP ${res.code}")
            val body = res.body ?: throw IllegalStateException("下载失败：空响应")
            val total = if (body.contentLength() > 0) body.contentLength() else info.size
            var done = 0L
            body.byteStream().use { input ->
                tmp.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buf)
                        if (read <= 0) break
                        output.write(buf, 0, read)
                        done += read
                        if (total > 0) onProgress(((done * 100) / total).toInt().coerceIn(0, 100), done, total)
                    }
                }
            }
        }
        if (tmp.length() == 0L) throw IllegalStateException("下载失败：文件为空")
        if (info.sha256.isNotEmpty()) {
            val got = sha256Of(tmp)
            if (!got.equals(info.sha256, ignoreCase = true)) {
                tmp.delete()
                throw IllegalStateException("校验失败：sha256 不一致")
            }
        }
        if (target.exists()) target.delete()
        if (!tmp.renameTo(target)) {
            tmp.copyTo(target, overwrite = true)
            tmp.delete()
        }
        onProgress(100, target.length(), target.length())
        target
    }

    /** 兜底：直接读包内版本号（version.json 缺失时用）。 */
    fun readApkVersion(context: Context, file: File): Pair<Int, String>? {
        val info = try {
            context.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
        } catch (_: Throwable) {
            null
        } ?: return null
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else info.versionCode
        return code to info.versionName.orEmpty()
    }

    fun canInstall(context: Context): Boolean =
        try {
            if (Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls() else true
        } catch (_: Throwable) {
            true
        }

    fun openInstallPermission(context: Context) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Throwable) {
            // 厂商 ROM 没有该页面时，退到应用详情页
            try {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (_: Throwable) {
                // 忽略：用户自己去找也行
            }
        }
    }

    fun install(context: Context, file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    private fun sha256Of(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buf)
                if (read <= 0) break
                md.update(buf, 0, read)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
