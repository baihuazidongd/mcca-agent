package com.mcca.mobile.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/**
 * 局域网发现：向 255.255.255.255:3472 广播 MCCA_DISCOVER，桥（mobile-bridge）回
 * 一条 {t:"mcca-desktop", port, addresses, name}。换网段/DHCP 换 IP 后照样能找到，
 * 不依赖公网中转。返回候选地址列表（"ip:port"）。
 */
object LanDiscovery {
    private const val DISCOVERY_PORT = 3472
    private const val MAGIC = "MCCA_DISCOVER"
    private const val BROADCAST = "255.255.255.255"

    suspend fun discover(timeoutMs: Long = 1200): List<String> = withContext(Dispatchers.IO) {
        val results = mutableListOf<String>()
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket().apply {
                broadcast = true
                soTimeout = 250
            }
            val payload = MAGIC.toByteArray(Charsets.UTF_8)
            repeat(2) {
                try {
                    socket.send(DatagramPacket(payload, payload.size, InetAddress.getByName(BROADCAST), DISCOVERY_PORT))
                } catch (_: Throwable) {
                    // 某些网络禁广播：忽略，继续等回包
                }
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                } catch (_: SocketTimeoutException) {
                    continue
                } catch (_: Throwable) {
                    break
                }
                val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                val json = Proto.parse(text) ?: continue
                if (Proto.str(json, "t") != "mcca-desktop") continue
                val port = Proto.long(json, "port", 3471).toInt()
                Proto.arr(json, "addresses")?.forEach { el ->
                    val ip = el.takeIf { it.isJsonPrimitive }?.asString ?: return@forEach
                    if (ip.isNotEmpty()) results.add("$ip:$port")
                }
                // 回包源地址本身也能用（多网卡时比广播里的列表更准）
                packet.address?.hostAddress?.takeIf { it.isNotEmpty() }?.let { results.add("$it:$port") }
                if (results.isNotEmpty()) break // 第一条有效应答就够了，别白等满超时
            }
        } catch (_: Throwable) {
            // 发现失败不是错误：还有记住的地址与中转兜底
        } finally {
            try { socket?.close() } catch (_: Throwable) { /* ignore */ }
        }
        results.distinct()
    }
}
