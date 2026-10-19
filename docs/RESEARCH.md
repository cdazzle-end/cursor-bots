# Research: rebuilding Grok Bot on agents you control

This is the research behind Cursor Bots. It answers three questions:

1. What exactly is Grok Bot made of?
2. How do the open harnesses (Hermes Agent, OpenClaw) implement the same ideas?
3. How do you get the same capabilities with Cursor, and why this repo builds its own harness on the Cursor SDK?

Sources are linked inline. Everything was read in October 2026; these products change fast.

---

## 1. Grok Bot, feature by feature

Grok Bot is xAI's product, run by Cursor ([cursor.com/docs/grok-bot](https://cursor.com/docs/grok-bot), [docs.x.ai/grok-bot/overview](https://docs.x.ai/grok-bot/overview)). Under the marketing, it is an **agent harness**: a set of long-lived agents ("Bots") plus the plumbing that makes them feel like teammates. Here is the plumbing:

| Capability | What Grok Bot does | Source |
| --- | --- | --- |
| **Bots** | A Bot is "a durable AI teammate with a name, a job, its own conversation, and working context that develops over time." You create one per distinct goal, toolset, approval boundary or schedule. It has a name, label and picture. Pin, hide, group into sections, duplicate (profile and routines, but not history or memory), share as a template, delete (profile, chat and routines go; files stay on the computer). | [Work with Grok Bot](https://cursor.com/docs/grok-bot/work), [Bots](https://docs.x.ai/grok-bot/bots) |
| **Memory** | "Stable preferences, important facts, and summaries from its work." Lasting rules ("from now on, never…") go into memory. Memory is *not* a source of truth: ask the Bot to re-check live data. | [Work](https://cursor.com/docs/grok-bot/work), [Edit a Bot](https://cursor.com/help/grok-bot/edit-bot) |
| **One shared computer** | Every Bot uses the same persistent cloud computer: browser, terminal, files, sign-ins. Durable files live in `/workspace`. Each Bot gets its own *screen* (one computer-use task at a time), but screens are not security boundaries. | [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) |
| **Messaging** | Paste text, links, images, files (6 per message; 25 MB, or 200 MB for video). `/` references a skill and `@` mentions a Bot. Your message takes priority over background work and can redirect the current turn. "Stop now" stops it. | [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration) |
| **Group chats** | 2–6 Bots. "Write normally to let the Bots decide who responds", `@` one Bot, `@everyone` for all, or Reply to a message. One owner per stage. | [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration), [Group chats](https://cursor.com/help/grok-bot/group-chats) |
| **Handoffs** | "A handoff is an asynchronous message to another Bot. The receiver wakes, handles the request, and can reply later." Handoffs show in the Bots' own chats. Every reply between Bots costs usage. | same |
| **Skills** | "A reusable set of instructions for how to do a task": when to use it, inputs and access, steps, validation, output, what needs approval. One private library shared by all Bots. Can be taught by demonstration. | [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) |
| **Routines** | "A rule that tells one Bot when to run a workflow": a schedule, or an event (Slack, GitHub, webhook with URL and Bearer key). Limits: 50 per Bot, 20 run records, at least 5 minutes apart. A new routine waits for its next time; **Test** runs it now. Routines are paused after a long absence. | [Routines](https://cursor.com/help/grok-bot/routines) |
| **Approvals** | Consequential actions stop with **Allow once / Always allow / Deny**. "Always allow" saves a rule, and "Ask first" wins conflicts. An Auto Review model checks risky actions. Approvals from background work expire after about 10 minutes. | [Security](https://docs.x.ai/grok-bot/security), [How-tos](https://cursor.com/help/grok-bot/how-to) |
| **Secrets** | A masked "secure secret card". Values are write-only, never shown to the model, and never written to the chat. | [Secrets](https://cursor.com/help/grok-bot/secrets) |
| **Plugins** | Account-wide connectors (Gmail, Notion, Slack…). OAuth tokens stay off the computer. | [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) |
| **Attention** | The sidebar shows working, unread and needs-attention (question, approval, handoff) states. Per-Bot notifications. | [Settings](https://cursor.com/docs/grok-bot/settings.md) |
| **Model** | No picker. Grok Bot routes each task to whatever model it thinks is best. | [Models](https://cursor.com/help/grok-bot/models) |

### The design in one paragraph

Each Bot is one long-lived agent session with a stable identity. A **gateway** sits around these sessions. It stores identity and memory, delivers messages between you and the Bots and between Bots, wakes Bots on schedules and events, and enforces approval boundaries. Bots act on one shared machine through tools. Everything else (the sidebar, cards, avatars) is UI on top of that gateway.

---

## 2. What an agent harness is (the part worth learning)

```
 you ──► surfaces (app, phone, Slack, webhooks)
          │
          ▼
       HARNESS / GATEWAY  ← identity, memory, roster, message routing,
          │                  schedules, approvals, secrets, connectors
          ▼
       AGENT LOOP          ← model ⇄ tool calls ⇄ results, until done
          │                  (context window, compaction, subagents)
          ▼
       TOOLS & COMPUTER    ← shell, files, browser, MCP servers
```

- The **model** is stateless. It only sees the prompt for this turn.
- The **agent loop** turns a model into an agent. It calls tools, feeds results back, and repeats. It also keeps a session (conversation history) and compacts it when it gets long.
- The **harness** turns an agent into a *teammate*. It gives the agent a name and job that persist, a memory file the agent can edit, a way to talk to other agents, a clock (routines), and guardrails (approvals, secrets).

Cursor's SDK provides the agent loop and tools. Cursor Bots provides the harness.

---

## 3. How Hermes Agent and OpenClaw do it

Both are open-source harnesses. Hermes even ships a **Bot Mode** that copies Grok Bot's design almost exactly, which confirms the architecture above.

### Hermes Agent (Nous Research)

[github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) · [docs](https://hermes-agent.nousresearch.com/docs/)

- **A Bot is a Hermes profile**: `~/.hermes/profiles/<name>/` holds its config, memory, skills, credentials and chat history. Bot Mode is a desktop UI over profiles ([Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)).
- **One canonical "Bot Chat" per Bot.** Teammates' names and roles are injected into each Bot Chat's system prompt.
- **Memory**: `MEMORY.md` (agent notes, 2,200 chars) and `USER.md` (user profile, 1,375 chars). Both are loaded as a frozen snapshot at session start, edited via a `memory` tool (`add`/`patch`/`remove`), plus FTS5 `session_search` over past sessions ([Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).
- **Skills**: agentskills.io `SKILL.md` folders, created autonomously after complex tasks, with a Skills Hub.
- **Routines** are ordinary Hermes cron jobs named `[bot:<name>] <routine>`, and their output lands in the Bot's chat.
- **Bot-to-bot**: a `message_agent(target, message)` tool. It is fire-and-forget, and the reply comes back as a completion notification. Replies are capped at 16,000 chars. Silence tokens (`NO_REPLY`) let a Bot stay quiet.
- **Group rooms**: 2–6 Bots. Each user message triggers up to 3 serial rounds (max 10 messages); members reply briefly or pass. Each member keeps a per-room session. `@name`, `@everyone`, and `@user` (escalate to you).
- **Approvals**: `once`, `session`, `always`, `deny`.
- **Gateway** to 20+ platforms (Telegram, Discord, Slack, WhatsApp, Signal, email…).
- **Models**: Nous Portal, OpenRouter, OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint.

### OpenClaw

[docs.openclaw.ai](https://docs.openclaw.ai) · [multi-agent](https://docs.openclaw.ai/concepts/multi-agent) · [session tools](https://docs.openclaw.ai/concepts/session-tool)

- **One Gateway process runs several isolated agents**, configured in `~/.openclaw/openclaw.json` under `agents.entries`. Each agent has its own workspace, `agentDir` (auth and models) and session store.
- **Persona and rules are files in the agent's workspace**: `AGENTS.md` (operating rules), `SOUL.md` (personality), `USER.md` (about you), and `MEMORY.md` (long-term memory), injected on a session's first turn. Optional `HEARTBEAT.md` drives periodic check-ins.
- **Bindings** route `(channel, account, peer)` to an agent: "this WhatsApp number talks to *alex*".
- **Agent-to-agent**: `sessions_send` runs another session and can wait for the reply or fire and forget (`timeoutSeconds: 0`), with modes `steer`/`followup`/`resume`/`notify`. `sessions_spawn` starts child sessions, `sessions_history` reads another session's transcript, and `tools.agentToAgent.allow` restricts which agents may talk.
- **Skills** load from each workspace and shared roots (`~/.openclaw/skills`), filtered per agent.
- **ACP runtime**: child sessions can be delegated to an external harness over the Agent Client Protocol (`runtime: "acp"`).

### Side by side

| Grok Bot | Hermes (Bot Mode) | OpenClaw | Cursor primitive | **Cursor Bots (this repo)** |
| --- | --- | --- | --- | --- |
| Bot (name, job, chat) | Profile + "Bot Chat" | `agents.entries.<id>` + workspace | SDK local agent (`agent-<uuid>`, durable, `Agent.resume`) | `Bot` in `state/bots.json` + one SDK agent per bot ([runner.ts](../src/core/runner.ts)) |
| Persona / job | Title, description, `SOUL.md` | `SOUL.md`, `AGENTS.md` | `systemPrompt` (gated), rules, `AGENTS.md` | `<harness><you>` block each turn + shared manual as an always-on rule ([prompt.ts](../src/core/prompt.ts), [manual.ts](../src/core/manual.ts)) |
| Memory | `MEMORY.md` + `USER.md` (frozen snapshot), `session_search` | `MEMORY.md`, daily notes, `sessions_history` | none built in | `state/memory/<bot>.md` (rules, preferences, facts, work log) injected every turn; `memory_update`, `search_messages`, `read_conversation` tools ([memory.ts](../src/core/memory.ts)) |
| Shared computer `/workspace` | local / Docker / SSH / Modal backends | per-agent workspace | `local.cwd` (+ sandbox) | one shared `workspace/` is every bot's cwd ([workspace.ts](../src/core/workspace.ts)) |
| Handoffs | `message_agent` (async, notification) | `sessions_send` | subagents (in-turn only) | `send_message` → bot-to-bot thread, receiver wakes, reply routes back ([harness.ts](../src/core/harness.ts) `handoff`) |
| Group chats | rooms 2–6, rounds, pass | channels + bindings | — | groups 2–6, `@`, `@everyone`, Reply, lead, or a routing model picks ("Bots decide") |
| Skills | `SKILL.md`, Skills Hub | `SKILL.md` per workspace | **native**: `.cursor/skills/*/SKILL.md` | the shared workspace's `.cursor/skills/`, `skill_save` tool, `/skill` in the composer ([skills.ts](../src/core/skills.ts)) |
| Routines | cron jobs per profile | cron + heartbeat | Automations (cloud agents) | cron + webhook routines with Grok's limits ([scheduler.ts](../src/core/scheduler.ts)) |
| Approvals | once/session/always/deny | elevated-command gates | **hooks** (`beforeShellExecution`), Auto-review, sandbox | hook → gateway → approval card; `request_approval` tool ([approvals.ts](../src/core/approvals.ts)) |
| Secrets | `.env` per profile | auth profiles | cloud `envVars` | encrypted vault, secure card, `run_with_secrets`, `${secret:NAME}` in connectors ([secrets.ts](../src/core/secrets.ts)) |
| Plugins | MCP + toolsets | tools + MCP | **MCP servers** (inline or `.cursor/mcp.json`) | "Connect apps" → MCP servers per bot |
| Model | any provider | any provider | Cursor catalog (`Cursor.models.list()`, Router) | per-bot model from your Cursor account |

---

## 4. Getting the same thing "with Cursor"

What Cursor gives you ([SDK docs](https://cursor.com/docs/sdk/typescript.md)):

- **`@cursor/sdk`**: "The same agent that runs in the Cursor IDE, CLI, and web app", scriptable from TypeScript. The *local* runtime runs the agent loop in your Node process against files on disk, with Cursor-hosted models.
- **Durable agents**: `Agent.create()` returns an `agent-<uuid>`. Conversation checkpoints persist in a SQLite or JSONL store, so `Agent.resume(id)` from a new process "picks up where the previous one left off."
- **Custom tools** (`local.customTools`): in-process functions exposed to the model as an MCP server, which "skip interactive approval". This is how the harness gives bots `send_message`, `memory_update` and the rest.
- **Workspace config** (`local.settingSources: ["project"]`): loads `.cursor/rules`, `.cursor/skills`, `AGENTS.md`, `.cursor/hooks.json` and `.cursor/mcp.json` from the workspace. (Cursor Bots uses the first four and keeps `.cursor/mcp.json` out: its servers would start without approval. Connectors are passed per turn instead.)
- **Hooks**: `beforeShellExecution` returns `allow`/`deny` per command, and `beforeSubmitPrompt` sees each prompt. This is the approval boundary.
- **Steer and cancel**: `run.steer(text)` injects your message into a running local turn; `run.cancel()` stops it.
- **Images**, **MCP servers**, **subagents**, **sandbox** (bubblewrap/seatbelt), and the **Auto-review** classifier.
- **Cloud agents** (VMs) and the **CLI** (`agent -p`, `agent acp`) for other deployment shapes.

What Cursor does *not* give you: a roster, identity that survives across conversations, agent-to-agent messaging, schedules for local agents, approval and secret UIs, or group routing. That gap is the harness.

### Options considered

1. **Hermes or OpenClaw with Cursor as the brain.** Not possible directly. Both expect an OpenAI-style chat-completions endpoint, and Cursor says plainly that its SDK "is an agent SDK, not a standalone model-inference or chat-completions API." You *can* run Hermes or OpenClaw with your own Anthropic, OpenAI or xAI keys, and Hermes Bot Mode is the closest off-the-shelf Grok Bot clone. OpenClaw could also delegate child sessions to the Cursor CLI over ACP (`agent acp`), but the main agents still need a chat model.
2. **Cursor Cloud Agents + Automations.** These are persistent VMs with schedules, but they are coding-task oriented (repo, branch, PR). Custom in-process tools don't work there, and there's no roster or bot-to-bot messaging.
3. **Build a harness on the Cursor SDK local runtime (chosen).** You get Cursor's agent loop, tools and models, and you own the harness. It's the closest match to Grok Bot's design (one shared computer, durable named agents), and everything is plain files you can read.

These options aren't exclusive. Cursor Bots exposes a **Team MCP** endpoint, so a Hermes or OpenClaw agent (or Claude Code, or the Cursor IDE) can message your Cursor-powered bots and wait for their answers. Skills are plain Agent Skills folders, so the same `SKILL.md` works in all of them.

---

## 5. Where Cursor Bots differs from Grok Bot

| Grok Bot | Cursor Bots | Why / workaround |
| --- | --- | --- |
| Cursor-hosted cloud computer, works with your laptop closed | Runs wherever you start it | Run it on an always-on machine or VPS, and use `--host 0.0.0.0` (token-protected) to reach it from your phone. |
| Virtual desktop, computer use, "watch the computer", take over | Shell + files natively; browser via the Playwright MCP connector | Sign-ins persist in the workspace browser profile. No full virtual desktop. |
| Teach a task by demonstration | Not implemented | Do the task with the bot, then ask it to save a skill. |
| Voice chat | Dictation in the composer (Web Speech API) | — |
| iOS/Android apps | Responsive web app | Works on a phone browser. |
| Slack/GitHub/email triggers, Team Bots, admin | Webhook routines cover generic events; no team features | Point GitHub/Slack webhooks (or Zapier) at a routine's URL. |
| No model picker | Per-bot model from your Cursor catalog | That's the point of bringing your own agents. |
| Auto Review model | Your rules + optional Cursor Auto-review classifier + optional sandbox | Rules are explicit and editable in Settings → Approvals. |
| Per-bot conversation | One durable agent session per bot sees its DM, groups and handoffs, each labelled in the prompt | One brain per bot is simpler and keeps context coherent. Hermes instead keeps a separate session per room. |

---

## 6. What a real Grok Bot setup shows (October 2026)

The owner exported their own Grok Bot setup, leaving out secrets, chats and images. The export holds the bots' profiles and settings, the group chats, the owner's skills, and the built-in skills Grok Bot gives every bot. This section records design facts from it, in our own words. The export itself stays out of this public repo.

**Data model.**
- A bot is a small profile: a name, a description that holds all of its standing instructions, a title (the label under the name), an avatar shape and a named color, and a notification switch.
- Memory, routines and chats live on the server, not in these files.
- A group chat is a profile with a name and a list of member ids. Groups get their title from the first message unless you name them.

**How people write bots.** The owner's best bots follow one pattern:
- **One job.** What the bot owns, in operational terms.
- **Anti-jobs.** What it never does: hand-offs to other bots, and anything that needs approval.
- **How it works.** Steps and proof of done.
- **When it wakes.** On demand, a routine, or both.
- **Voice.** Short, results first.
- **Files.** Which workspace folder is its own, with no loose files at the top.

A lead bot coordinates the rest. It creates bots, rewrites another bot's instructions when it underperforms, and hands work out. So Grok Bot gives bots tools to create a bot, update another bot, and message a bot.

**Built-in skills are the manual.** Grok Bot ships about 50 built-in skills that load when a situation calls for them, rather than one long always-on rule. Some cover how the harness works: group-chat turns, routines, outside channels, secure forms, signing in, sending as the user, writing skills and exporting a bot as a template. The rest are site playbooks (shopping, travel, shipping), each with deep links and stop rules.

**Conventions worth copying:**
- **Group turns.** A bot's text in a group turn is private working space. Only an explicit post reaches the room, so silence is the default rather than a special answer. A turn posts at most a few short messages that react to what was just said. A bot can send its own user a private note during a group turn. It never reads a teammate's private chat or memory.
- **Routine prompts.**
  - A routine's saved prompt ends with one plain line saying who gets the result and where, and what to do when nothing is new. A run messages no one else.
  - Schedules avoid :00 and :30: the minute comes from the moment the routine was created.
  - Unless asked otherwise, a schedule stays inside weekday waking hours (about 8 am to 7 pm). "Daily" isn't taken to mean weekends or 3 am.
  - A finite watch ("tell me when this merges") deletes itself when it's done or its deadline passes.
  - A routine that keeps failing for the same sign-in reason is paused, and the user is told what to reconnect.
- **Sending as the user.** A message that goes out under the user's name is shown as an editable draft. The user's Send press is the send, even when they asked the bot to "send it".
- **Secure forms.** When a website needs the user to type something (a password, card or code), the app shows an in-chat form. It fills the page directly, and the bot never sees the values.
- **Templates.** Exporting a bot packs chosen memories, skills, routines and plugins with names and private links taken out. It adds a "getting started" skill: the questions the bot asks its new owner.

**From the owner's earlier attempt** (a Hermes-based rebuild, with live Featherless logs):
- Featherless can accept a request, then send "*model* is temporarily at capacity" inside the stream. We now retry that like a 503.
- Featherless reuses cached prompt prefixes heavily (94–100% of prompt tokens in those logs). Keeping the start of each request stable, as the runtime does, pays off.
- Featherless reported 131,072 tokens of context for a model whose base supports 262,144. Whether a request longer than the listed window is accepted is untested here.
