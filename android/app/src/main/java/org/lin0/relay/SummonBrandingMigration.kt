package org.lin0.relay

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.io.IOException

object SummonBrandingMigration {
    fun run(context: Context) {
        val connection = runCatching { movePreferences(context, "RelayNative.connection.v1", "SummonNative.connection.v1") }
        val display = runCatching { movePreferences(context, "RelayNative.display", "SummonNative.display") }
        val credentials = runCatching { moveCredentials(context) }
        connection.getOrThrow()
        credentials.getOrThrow()
        display.getOrThrow()
    }

    private fun moveCredentials(context: Context) {
        val previousName = "relay_connection_tokens"
        if (!File(context.applicationInfo.dataDir, "shared_prefs/$previousName.xml").exists()) return
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        fun encrypted(name: String) = EncryptedSharedPreferences.create(
            context, name, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        val previous = encrypted(previousName)
        val current = encrypted("summon_connection_tokens")
        val editor = current.edit()
        var unresolved = false
        for ((key, value) in previous.all) {
            if (current.contains(key)) continue
            if (value is String) editor.putString(key, value) else unresolved = true
        }
        if (!editor.commit()) throw IOException("无法保存迁移后的连接凭据")
        if (unresolved) throw IOException("部分旧连接凭据等待迁移")
        if (!context.deleteSharedPreferences(previousName)) throw IOException("无法移除已迁移的连接凭据")
    }

    private fun movePreferences(context: Context, previousName: String, currentName: String) {
        val previous = context.getSharedPreferences(previousName, Context.MODE_PRIVATE)
        if (previous.all.isEmpty()) return
        val current = context.getSharedPreferences(currentName, Context.MODE_PRIVATE)
        val editor = current.edit()
        var unresolved = false
        for ((oldKey, value) in previous.all) {
            val key = oldKey.replace("RelayNative", "SummonNative")
            if (current.contains(key)) continue
            when (value) {
                is String -> editor.putString(key, value)
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is Float -> editor.putFloat(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Set<*> -> {
                    val strings = value.filterIsInstance<String>()
                    if (strings.size == value.size) editor.putStringSet(key, strings.toSet()) else unresolved = true
                }
                else -> unresolved = true
            }
        }
        if (!editor.commit()) throw IOException("无法保存迁移后的本机设置")
        if (unresolved) throw IOException("部分旧设置项等待迁移")
        if (!context.deleteSharedPreferences(previousName)) throw IOException("无法移除已迁移的本机设置")
    }
}
