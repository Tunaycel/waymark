# Roadmap

Each phase ships as one or more reviewed pull requests. The next phase starts only after the
maintainer has reviewed the previous one.

| Phase | Scope | Outcome | Status |
|---|---|---|---|
| **0 · Foundation** | Monorepo, CI, Postgres + Redis, GitHub webhook → queue → worker → DB | Every push is captured reliably and idempotently | 🚧 in review |
| **1 · Living map** | Repo indexing (tree-sitter + LLM topic grouping), incremental map updates, "where you left off" card, dashboard with interactive map | First public demo | 📋 |
| **2 · Review** | Per-push triage, nightly review, pattern memory, email/Telegram delivery | End-of-day report | 📋 |
| **3 · Life layer** | Google Calendar, task sources, signal model + importance scoring, morning brief, WhatsApp | Personal agent | 📋 |
| **4 · Ecosystem** | MCP server, OpenClaw skill, weekly progress report | Works inside other agents | 📋 |
| **5 · Watches** | Watch templates: payments, regulations, events; community connector SDK | Tracks "everything you add" | 📋 |
