package org.lin0.relay

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

sealed class RelayJson {
    data class Str(val value: String) : RelayJson()
    data class Num(val value: Double) : RelayJson()
    data class Bool(val value: Boolean) : RelayJson()
    data class Obj(val value: Map<String, RelayJson>) : RelayJson()
    data class Arr(val value: List<RelayJson>) : RelayJson()
    data object Null : RelayJson()

    operator fun get(key: String): RelayJson {
        val map = (this as? Obj)?.value ?: return Null
        return map[key] ?: Null
    }

    val stringValue: String
        get() {
            return when (this) {
                is Str -> value
                is Num -> {
                    if (value.isFinite() && value % 1.0 == 0.0 && value >= Long.MIN_VALUE.toDouble() && value <= Long.MAX_VALUE.toDouble()) {
                        value.toLong().toString()
                    } else value.toString()
                }
                is Bool -> value.toString()
                Null -> ""
                is Arr -> value.joinToString("、") { it.stringValue }
                is Obj -> {
                    for (key in listOf("content", "text", "message", "summary")) {
                        val nested = value[key]
                        if (nested is Str) return nested.value
                    }
                    encode().toString()
                }
            }
        }

    val string: String? get() = (this as? Str)?.value
    val array: List<RelayJson>? get() = (this as? Arr)?.value
    val obj: Map<String, RelayJson>? get() = (this as? Obj)?.value
    val bool: Boolean? get() = (this as? Bool)?.value
    val int: Int?
        get() {
            val number = (this as? Num)?.value ?: return null
            if (!number.isFinite() || number < Int.MIN_VALUE.toDouble() || number >= Int.MAX_VALUE.toDouble()) return null
            return number.toInt()
        }

    val pretty: String
        get() = try {
            when (val encoded = encode()) {
                is JSONObject -> encoded.toString(2)
                is JSONArray -> encoded.toString(2)
                else -> encoded.toString()
            }
        } catch (_: Exception) {
            stringValue
        }

    fun encode(): Any = when (this) {
        is Str -> value
        is Num -> if (value.isFinite() && value % 1.0 == 0.0) value.toLong() else value
        is Bool -> value
        Null -> JSONObject.NULL
        is Arr -> JSONArray().also { array -> value.forEach { array.put(it.encode()) } }
        is Obj -> JSONObject().also { json ->
            value.forEach { (key, item) -> json.put(key, item.encode()) }
        }
    }

    fun bytes(): ByteArray = encode().let { encoded ->
        when (encoded) {
            is JSONObject -> encoded.toString().toByteArray(Charsets.UTF_8)
            is JSONArray -> encoded.toString().toByteArray(Charsets.UTF_8)
            else -> encoded.toString().toByteArray(Charsets.UTF_8)
        }
    }

    companion object {
        fun parse(text: String): RelayJson = from(JSONTokener(text).nextValue())

        fun from(raw: Any?): RelayJson = when (raw) {
            null, JSONObject.NULL -> Null
            is String -> Str(raw)
            is Boolean -> Bool(raw)
            is Number -> Num(raw.toDouble())
            is JSONObject -> Obj(buildMap {
                val keys = raw.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    put(key, from(raw.opt(key)))
                }
            })
            is JSONArray -> Arr(List(raw.length()) { index -> from(raw.opt(index)) })
            else -> Str(raw.toString())
        }

        fun obj(vararg pairs: Pair<String, RelayJson>): RelayJson = Obj(mapOf(*pairs))
    }
}
