# Summon Bot runtime

The platform gateway embeds `BotRuntime` from `bot/src/runtime/bot.mjs`. The runtime uses the platform's tool definitions, authorization, persistence and host resource limits. Startup uses the project's managed installation.

The per-Bot SQLite store records events and deliveries, independent wait processing, conversation and run state, call receipts, and original transcripts. Public messages come from the platform `send` operation. The host reads the original call identity when recovering interrupted effects.

A Bot's `material_index_ref` points to an optional ordinary File. Entries declare a stable `id`, `revision`, `applies_to`, and a `note` or accessible `material_ref`. Selected entries can specify a `target_ref` for consolidation. A knowledge write receipt or a valid explicit `no_change` result advances the corresponding internal consumption records.
