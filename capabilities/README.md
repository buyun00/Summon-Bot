# Summon Capabilities

The host gateway exposes Summon Bot's core microkernel capabilities:

- **Chatrooms & Bots** (`capabilities/chatroom/`, `capabilities/bot-management/`): group chatrooms, direct Bot management, bundled Bot templates (`bundled-bots/`), and standalone per-Bot folders (`bots/<bot-id>/{bot.json, instructions.md, skills/, scripts/, .local/}`).
- **Local Execution Primitive** (`capabilities/services/exec-runner.mjs`): executes Bot folder scripts via Summon's built-in Node runtime, host CLI commands, or shell one-liners with `summon-jsonl` live progress streaming and host secret env injection.
- **Models & Secrets** (`capabilities/models/`, `capabilities/services/secrets.mjs`): LLM provider catalog (Codex/Grok subscriptions and OpenAI/Anthropic/DeepSeek/custom APIs) and out-of-band secret storage (`runtime.env`).
- **Gateway API** (`capabilities/gateway/`): loopback HTTP + SSE API consumed by the Web UI, Desktop shell, iOS, and Android clients.
