package com.mcca.mobile.net

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** 与 mobile-bridge / relay 共用的帧协议。 */
object Proto {
    const val T_REQ = "req"
    const val T_RES = "res"
    const val T_EVT = "evt"

    fun parse(text: String): JsonObject? = try {
        JsonParser.parseString(text).takeIf { it.isJsonObject }?.asJsonObject
    } catch (_: Throwable) {
        null
    }

    fun obj(vararg pairs: Pair<String, Any?>): JsonObject {
        val o = JsonObject()
        for ((k, v) in pairs) o.add(k, any(v))
        return o
    }

    fun any(value: Any?): JsonElement = when (value) {
        null -> com.google.gson.JsonNull.INSTANCE
        is JsonElement -> value
        is String -> com.google.gson.JsonPrimitive(value)
        is Number -> com.google.gson.JsonPrimitive(value)
        is Boolean -> com.google.gson.JsonPrimitive(value)
        is Map<*, *> -> {
            val o = JsonObject()
            for ((k, v) in value) o.add(k.toString(), any(v))
            o
        }
        is List<*> -> {
            val a = JsonArray()
            for (v in value) a.add(any(v))
            a
        }
        else -> com.google.gson.JsonPrimitive(value.toString())
    }

    fun str(o: JsonObject?, key: String, fallback: String = ""): String {
        val v = o?.get(key) ?: return fallback
        return if (v.isJsonPrimitive) v.asString else fallback
    }

    fun long(o: JsonObject?, key: String, fallback: Long = 0L): Long {
        val v = o?.get(key) ?: return fallback
        return if (v.isJsonPrimitive && v.asJsonPrimitive.isNumber) v.asLong else fallback
    }

    fun bool(o: JsonObject?, key: String, fallback: Boolean = false): Boolean {
        val v = o?.get(key) ?: return fallback
        return if (v.isJsonPrimitive && v.asJsonPrimitive.isBoolean) v.asBoolean else fallback
    }

    fun arr(o: JsonObject?, key: String): JsonArray? {
        val v = o?.get(key) ?: return null
        return if (v.isJsonArray) v.asJsonArray else null
    }

    /** 安全取对象：字段缺失 / JsonNull / 类型不符都返回 null（Gson 的 getAsJsonObject 会抛异常）。 */
    fun obj(o: JsonObject?, key: String): JsonObject? {
        val v = o?.get(key) ?: return null
        return if (v.isJsonObject) v.asJsonObject else null
    }
}
