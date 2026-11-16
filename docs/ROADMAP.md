# Roadmap

Each phase ships as one or more reviewed pull requests. The next phase starts only after the
maintainer has reviewed the previous one.

| Phase | Scope | Outcome | Status |
|---|---|---|---|
| **0 · Foundation** | Monorepo, CI, Postgres + Redis, GitHub webhook → queue → worker → DB | Every push is captured reliably and idempotently | ✅ merged |
| **1a · Indexer** | Tarball download via the GitHub App, JS/TS · Python · Go import graph, modules, dependencies, frameworks, TODO markers, snapshots; debounced re-index on push, initial index on install | The structural map data exists for every repository | ✅ merged |
| **1b · Topics** | Louvain clustering into topics with stable ids; Claude Haiku 5.5 (or Ollama) names and summarises them under a monthly budget; descriptions reused until a topic changes | Map nodes people recognise ("Session Auth", "Stripe Webhooks") | ✅ merged |
| **1c-1 · Local dashboard** | Next.js + React Flow map on 127.0.0.1: project list, regions and directory groups, search, topic panel, `pnpm demo` | See every project as a map | ✅ merged |
| **1c-2 · 3D overview and polish** | 3D "observatory" overview on the welcome screen; graph layout in a Web Worker so large maps never block the page | First public demo | 🚧 in review |
| **1c-3 · Hosting and GitHub sign-in** | "Sign in with GitHub" through the existing GitHub App; each user sees only the repositories they installed it on, indexed automatically on install and push; one-command Docker Compose setup, tested through a tunnel, then a small VPS with a domain and HTTPS | Waymark runs 24/7 on your own repositories | 📋 |
| **1d · Ask Waymark (Telegram)** | A Telegram bot backed by an agent: Claude (Haiku by default, within the monthly budget) with read-only tools over topics, commits, and TODOs. Only structure is sent, never code | "Where is auth in this repo?", "What did I do yesterday?" | 📋 |
| **1e · Where you left off** | Recently touched topics, open branches and PRs, new TODOs, WIP commits; on the dashboard and on request in Telegram | Answers "where was I?" | 📋 |
| **2 · Review** | Per-push triage, nightly review, pattern memory, delivery on Telegram or email | End-of-day report | 📋 |
| **3 · Life layer** | Google Calendar, task sources, signal model + importance scoring, morning brief; WhatsApp as a second channel for the same agent (WhatsApp Business API: verified number, approved templates for messages you didn't start) | Personal agent | 📋 |
| **4 · Ecosystem** | MCP server, OpenClaw skill, weekly progress report | Works inside other agents | 📋 |
| **5 · Watches** | Watch templates: payments, regulations, events; community connector SDK | Tracks "everything you add" | 📋 |

## Why this order

- **Hosting before features that talk to you.** GitHub can only notify Waymark about pushes at a
  public address, and briefs need something running while your computer is off. The dashboard
  has no sign-in today, so GitHub sign-in ships together with hosting, never after it.
- **Telegram before WhatsApp.** A Telegram bot is free and takes minutes to set up, so the agent
  can be used early. WhatsApp needs a Meta business account, a verified number, approved templates,
  and per-conversation fees; it becomes a second channel for the same agent in Phase 3.
- **Chat before "where you left off".** The map data already exists; a conversation over it is
  the quickest way to use it daily, and "where was I?" then becomes one more question it answers.
