package com.mcca.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机 / 覆盖安装后把前台服务拉起来：不然重启手机后要等用户手动打开 App 才恢复在线。
 * Android 12+ 对后台启动前台服务有限制，BOOT_COMPLETED / MY_PACKAGE_REPLACED 属于豁免场景。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                runCatching { context.startForegroundService(Intent(context, HubService::class.java)) }
            }
        }
    }
}
