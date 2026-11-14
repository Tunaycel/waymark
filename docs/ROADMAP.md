# Roadmap

Each phase ships as one or more reviewed pull requests. The next phase starts only after the
maintainer has reviewed the previous one.

| Phase | Scope | Outcome | Status |
|---|---|---|---|
| **0 · Foundation** | Monorepo, CI, Postgres + Redis, GitHub webhook → queue → worker → DB | Every push is captured reliably and idempotently | ✅ merged |
| **1a · Indexer** | Tarball download via the GitHub App, JS/TS · Python · Go import graph, modules, dependencies, frameworks, TODO markers, snapshots; debounced re-index on push, initial index on install | The structural map data exists for every repository | ✅ merged |
| **1b · Topics** | Louvain clustering into topics with stable ids; Claude Haiku 5.5 (or Ollama) names and summarises them under a monthly budget; descriptions reused until a topic changes | Map nodes people recognise ("Session Auth", "Stripe Webhooks") | ✅ merged |
| **1c · Dashboard** | Next.js + React Flow interactive map, recent-change highlights; 1c-1: local dashboard and 2D map, 1c-2: 3D overview and polish | First public demo | 🚧 1c-1 in review |
| **1d · Where you left off** | Recently touched topics, open branches and PRs, new TODOs, WIP commits | Answers "where was I?" | 📋 |
| **2 · Review** | Per-push triage, nightly review, pattern memory, email/Telegram delivery | End-of-day report | 📋 |
| **3 · Life layer** | Google Calendar, task sources, signal model + importance scoring, morning brief, WhatsApp | Personal agent | 📋 |
| **4 · Ecosystem** | MCP server, OpenClaw skill, weekly progress report | Works inside other agents | 📋 |
| **5 · Watches** | Watch templates: payments, regulations, events; community connector SDK | Tracks "everything you add" | 📋 |
