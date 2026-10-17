# How Cursor Bots works

This is a guided tour of the harness, written to teach how agent harnesses work, not just this one. Read it alongside the code; every section names the file to open.

```
 Browser UI (web/)  ──REST + SSE──►  Gateway (src/server/http.ts)
                                         │
                                         ▼
                                 Harness (src/core/harness.ts)
       ┌──────────────┬────────────┬─────┴──────┬──────────────┬─────────────┐
       ▼              ▼            ▼            ▼              ▼             ▼
   Store          BotRunner     Scheduler   Approvals      SecretVault   SkillLibrary
 (files on disk)  (one per bot) (routines)  (rules, cards) (encrypted)   (.cursor/skills)
                      │
                      ▼
             AgentRuntime  ── CursorRuntime (@cursor/sdk local agent), OpenAICompatRuntime
                      │       (one per provider: Featherless, OpenRouter, Ollama…) or MockRuntime
                      │
                      ▼
              Shared workspace = every bot's cwd (files, skills, rules, hooks, browser profile)
```

## 1. Everything is files

Start the app and look in `~/.cursor-bots` (or the `--home` you passed):

```
~/.cursor-bots/
  settings.json            your profile, time zone, runtime, models, providers, approval rules, limits
  connectors.json          "Connect apps": MCP servers (values may say ${secret:NAME})
  state/
    bots.json              the roster: name, handle, label, job, avatar, model, agentId…
    conversations.json     DMs (you ↔ bot), groups, bot-to-bot threads
    messages/<conv>.jsonl  append-only message history, one JSON object per line
    memory/<bot>.md        each bot's memory (Markdown, editable)
    routines.json          schedules, webhook keys, last 20 runs each
    approvals.json         pending and decided approval requests
    secrets.vault          AES-256-GCM encrypted secret values (+ secret.key, mode 0600)
    provider-keys.vault    model provider API keys, same encryption, out of the bots' reach (section 9)
    agents/<agentId>.jsonl provider brains' transcripts, one OpenAI-format message per line
    seen.json              what each bot has already seen in each conversation
    queue.json             queued work, so a restart doesn't lose it
  cursor-store/            the Cursor SDK's SQLite agent store (index.db + checkpoint blobs): each bot's conversation context
  workspace/               THE SHARED COMPUTER (every bot's working directory)
    AGENTS.md              house rules for all bots (Cursor loads it automatically)
    .cursor/rules/cursor-bots.mdc   the harness manual, always applied (managed)
    .cursor/skills/<name>/SKILL.md  the shared skill library
    .cursor/hooks.json     + hooks/cursor-bots-gate.mjs: the approval gate (managed, rewritten if changed)
    (no .cursor/mcp.json:  the gateway moves one into state/quarantine/; use Connect apps)
    .rgignore              managed block naming the gateway's key and token files (see section 7)
    bots/<handle>/         each bot's scratch folder
    uploads/<date>/        files you attach in chat
```

Two kinds of memory live here, and the difference matters:

- **Runtime context**: what the model saw earlier in its session. Cursor stores it in `cursor-store/` and compacts it when it gets long. It's big, lossy and opaque. (Provider brains keep theirs in `state/agents/` and compact it themselves.)
- **Harness memory**: `state/memory/<bot>.md`. It's small and deliberate, and the bot edits it with a tool. The harness injects it every turn, so it survives compaction, restarts, and even a wiped `cursor-store/`.

## 2. A bot is a durable agent session plus an identity

`src/core/runner.ts` (`ensureSession`) opens one Cursor SDK agent per bot:

```ts
Agent.create({ name, model, local: { cwd: workspace, store: sqliteStore, settingSources: ["project"] } })
// later, even from a new process:
Agent.resume(bot.agentId, { model, local: { ... } })
```

`bot.agentId` (like `agent-3f…`) is saved in `bots.json`, so a restart resumes the same conversation. `settingSources: ["project"]` makes Cursor load the workspace's rules, skills, `AGENTS.md`, hooks and MCP config, which is how every bot gets the shared manual, skills and approval gate without any per-bot setup.

The store is the SDK's `SqliteLocalAgentStore` (`@cursor/sdk/sqlite`), opened once and shared by every bot. The SDK also ships a JSONL store, but it rewrites its whole file for every streamed event and checkpoint, so turns get slower as history grows. (Node 22 labels `node:sqlite` experimental; the CLI hides that one warning.) If the store loses a bot's agent, the bot starts a fresh context and keeps its memory.

Connectors go to the SDK as per-turn `mcpServers`. They live in the gateway's own config (`connectors.json`, out of the bots' reach). A `workspace/.cursor/mcp.json` is not allowed: Cursor would start every server in it for every bot without asking you, and bots can edit files in the workspace. So before each turn (and at startup) the gateway moves that file to `state/quarantine/` and posts a notice; add those servers in Connect apps instead.

Identity can't go in the system prompt: the SDK's `systemPrompt` replaces Cursor's whole prompt and is account-gated, and rules files are shared by everyone in the workspace. So the harness puts identity in **each turn's message**.

## 3. What a bot sees each turn (the envelope)

`src/core/prompt.ts` builds every message a bot receives. Here is a real one: Critic, addressed in a group (taken from a test run):

```
<harness>
<you name="Critic" handle="@critic">
Label: Reviews & QA
Job: Review images against the brief. List blocking issues first.
</you>
<memory>
# Critic's memory
## Lasting rules
- Never approve an image without checking it against the reference sheet.
## Preferences
- Boss likes verdicts in one line, then bullets.
## Facts
- Reference sheet: projects/yamato/reference.png
## Work log
- 2026-10-13: Reviewed V11 back view; rope loops missing.
</memory>
<team user="Boss (Team lead)">
- @e-boy "e-boy" — Image maker — Generate character art on the shared computer… [idle]
- Group #image-review "Image Review": @e-boy, @critic; lead @critic; purpose: e-boy makes images, Critic reviews them.
</team>
<now>Wed, Oct 14, 2026, 7:33 AM EDT</now>
</harness>

<context conversation="the group #image-review ("Image Review")">
Messages here since you last looked (oldest first):
[7:33 AM] Boss: @e-boy post the newest back view for Critic
[7:33 AM] @e-boy: Here's V12…
</context>

<incoming from="Boss" kind="group_message" via="the group #image-review ("Image Review")" addressed="you">
@critic is V12 good enough?
</incoming>

<reply-instructions>
Your final message is posted in the group #image-review ("Image Review").
</reply-instructions>
```

- `<harness>` is who you are. The full block is sent when something changed (memory, roster, profile), after the runtime compacts its context, or every 12 turns. Otherwise a one-liner keeps the prompt cheap.
- `<context>` holds messages in *this* conversation the bot hasn't seen: other bots' posts, or what happened while it was busy elsewhere. One bot session serves its DM, its groups and its handoff threads, so this is how it stays in sync.
- `<incoming>` is what woke it, and `kind` tells it how to behave: `message`, `group_message`, `handoff`, `handoff_reply`, `routine`, `approval`, `system`.
- `<reply-instructions>` says where its final answer goes. In groups it may answer `NO_REPLY` and nothing is posted.

The rest of the bot's behavior comes from the manual (`src/core/manual.ts`), written to `.cursor/rules/cursor-bots.mdc` with `alwaysApply: true`.

## 4. One turn, start to finish

You type "remember I like short answers" to Researcher:

1. `POST /api/conversations/:id/messages` → `Harness.postUserMessage` stores the message (`messages/<dm>.jsonl`) and creates a **wake event**: `{ botId, priority: 0, source: "user", convId, text, chain }`.
2. `BotRunner.enqueue`: if Researcher is already working *in this chat*, the text is **steered** into the running turn (`run.steer`). Otherwise it's queued. Queues are ordered: your messages (0), then other bots and approvals (1), then routines (2). Several quick messages from you merge into one turn.
3. `BotRunner.execute`: opens or resumes the session, builds the envelope, and calls `session.send({ text, images, tools, mcpServers, model })`.
4. The Cursor agent loop runs. It may call built-in tools (shell, read, edit, grep, web search…) and the **harness tools** (`src/core/tools.ts`). Here it calls `memory_update {action: "add", section: "Preferences", text: "…"}`.
5. Streaming: text deltas and tool events go out over SSE (`run.delta`, `run.tool`), so the UI shows the typing bubble and live tool chips.
6. `Harness.finishRun` posts the final text as a message with the activity list attached ("Worked for 12s · 4 steps"). It then wakes anyone the reply @mentioned (in groups) and delivers handoff replies.

## 5. Bots talking to bots

### Handoffs (`send_message` to `@bot`)

```
Boss ──► e-boy (DM)        "make V12 and get Critic's opinion"
          │ send_message(to:"@critic", text:"review V12", attachments:[…])
          ▼
   bot-to-bot thread (e-boy ↔ Critic)  ◄── handoff message (also mirrored in e-boy's DM)
          │ wakes Critic: kind="handoff", replyTo={ e-boy, convId: e-boy's DM }
          ▼
   Critic works, final reply posted in the thread
          │ deliverHandoffReply → wakes e-boy: kind="handoff_reply", convId = e-boy's DM
          ▼
   e-boy's final answer lands in your DM: "Critic says V12 is a near-pass…"
```

A handoff is fire-and-forget, like Grok Bot's async handoffs, Hermes' `message_agent` and OpenClaw's `sessions_send` with `timeoutSeconds: 0`. The sender ends its turn and gets the answer as a new turn. Replies flow back up delegation chains via `replyTo.upstream`.

### Groups

Your message in a group wakes:

- the bots you `@mention`, or every member for `@everyone`;
- the author of the message you **Reply** to;
- otherwise one bot chosen by `settings.groupRouting`: `llm` (a quick one-shot routing prompt, which is how "the Bots decide who responds"), `lead`, or `heuristic` (name match, lead, then the most recent speaker).

Model routing has a 25-second deadline. If it fails or times out, the harness uses heuristic routing. The deadline aborts the completion: Cursor cancels its SDK run and closes and deletes its scratch agent. If SDK setup or sending is still pending, the caller stops waiting immediately; a late agent is cleaned up and a late run is cancelled without starting more routing work.

A bot's group post that @mentions a teammate wakes that teammate. That's how visible handoffs happen inside a group.

### Loop protection

Every wake carries a **chain** `{ id, depth, runs, originConvId }`. You or a schedule start a fresh chain. Each bot-to-bot hop adds 1 to `depth`. Every bot turn in the chain is charged to **one shared budget** kept by the harness, however the chain branches (a bot handing work to five teammates spends five turns, not one each). Past `maxChainDepth` (8) the harness stops waking bots and posts a notice. Once `maxChainRuns` (24) turns are spent, it refuses more turns, refuses new handoffs and stops delivering replies, with one notice in the conversation where the chain started. The manual also tells bots not to answer thank-yous and to keep one owner per stage.

**Stop** works the same way. "stop" (or the stop button) in a conversation cancels the turn replying there, drops anything queued or still being routed for it, and stops every chain that started there, including work already handed to other bots. Wakes record the conversation's stop generation when they're created, so a wake that was in flight during the stop is dropped when it arrives; a handoff records it too, so a teammate's answer coming back to a conversation you stopped since is dropped, and the teammate's turn doing that work is cancelled. Stop generations and stopped chains are saved with the queue, so a stop still holds after a restart. Your later decision on an approval or secret card is a new action: it resumes the bot on a fresh chain (same origin), so an earlier stop or a spent budget doesn't swallow it. Stopping a bot while it waits inline on a card ends that turn at once; the card stays, and deciding it wakes the bot. Idle chains are forgotten after six hours.

## 6. Routines

`src/core/scheduler.ts` uses [croner](https://github.com/hexagon/croner) for five-field cron in your time zone. Limits follow Grok Bot: 50 per bot, runs at least 5 minutes apart, last 20 runs kept. A routine can also have a **webhook**: `POST /api/webhooks/routines/<id>` with `Authorization: Bearer <key>`. The JSON body is passed to the bot as data. A 200 means the run started, not that it finished.

Restarts keep the queue: the saved wakes are loaded first and then started in priority order, and shutdown freezes every bot before waiting on any cancel, so nothing that ran during shutdown runs again. A run posts a "Routine … started" pill in its conversation, then wakes the owner with `kind="routine"` at low priority. Your messages still come first. A scheduled tick is skipped while the previous run is still going. Routines pause themselves after `absencePauseDays` (14) without activity from you; anything you change through the app counts, so a routine you switch back on stays on. Changing your time zone re-arms the routines that follow it. Cron expressions are checked against the 5-minute minimum on the day's time slots: every gap between them, and from a day's last slot to the next active day's first (worked out from the real calendar, so a weekly routine passes a two-day minimum). It's instant and catches dense days however far ahead they are. A daylight-saving jump can bring two runs closer once a year; a run never overlaps the previous one anyway.

## 7. Approvals: the boundary

There are two paths into `src/core/approvals.ts`:

1. **Shell commands.** The harness installs a Cursor hook in the workspace:
   ```json
   { "hooks": {
       "beforeSubmitPrompt":   [{ "command": "node .cursor/hooks/cursor-bots-gate.mjs prompt" }],
       "beforeShellExecution": [{ "command": "node .cursor/hooks/cursor-bots-gate.mjs shell" }] } }
   ```
   Before every command, Cursor runs the gate script, which asks the gateway (`POST /api/gate/shell`). The prompt hook tells the gateway which bot owns that Cursor conversation by reading the `<you handle="…">` tag at the top of the envelope. (The installed `hooks.json` also has a `preToolUse` entry; see the end of this section.)
2. **Everything else consequential** (email, posting, purchases, deletes) goes through the bot's `request_approval` tool, which the manual tells it to use.

Decisions follow the rules in Settings → Approvals (regex per command or action; `ask` beats `allow`). On "ask", a card appears (**Allow once / Always allow / Deny**), and the bot waits up to `inlineWaitSeconds`. If you haven't answered, it's told to end its turn, and your later decision **wakes it** with the outcome. The approval stores the turn's context (conversation, handoff route, chain), so a bot that was answering a handoff resumes in that thread and its result still flows back to the bot that asked. Secret requests work the same way. "Allow once" is consumed by the retry; "Always allow" adds a rule. Approvals from background work expire (10 min), as in Grok Bot.

The boundary only means something if bots can't route around it. The API needs a token even on localhost (and `CURSOR_BOTS_TOKEN` is removed from the environment bots inherit). The shell gate refuses commands that reach the gateway's port (with any host in front of it) or name its `state/` folder or the hook files, including `~/` and `$HOME` spellings, and commands whose working directory is inside protected state (symlinks followed). A third hook (`preToolUse`, mode `tool`, for Read, Write, Delete, Grep and List) blocks file tools from the gateway's own files: tokens, the secret vault, settings, checkpoints, the hook script, `hooks.json`, the manual rule, and Cursor's own permission, sandbox and MCP config in `.cursor/`. It follows symlinks, and search and list tools can't target a folder that contains the gateway's state. Cursor's Grep follows symlinks *inside* the folder it searches, so the hook also refuses a search whose folder holds a link that leads into the gateway's state (it skips `node_modules/` and `.browser/`, which `.cursorignore` hides from ripgrep anyway). As a second layer the workspace gets a managed `.rgignore` naming the gateway's key and token files, and the gateway's own folders get a `.ignore` with `*`, so ripgrep skips them wherever a link leads. `.rgignore` and `.cursorignore` are protected like the hooks. The gate's URL and token are embedded in the script (no side config file to delete), the URL is the address the server actually bound (the CLI checks the hook can reach it before restoring any queued work, or refuses to start), and before every turn the gateway rewrites any hook file that changed, so tampering doesn't outlive a turn. If the gateway isn't running at all (you opened the workspace in the Cursor IDE yourself), the hook allows everything; no bot can run then.

The prompt hook learns which bot owns each Cursor conversation from the `<you handle="…">` tag. If a command comes from a conversation it hasn't learned while several bots are working, the gate doesn't guess: allowed commands run, anything that needs approval is refused with a "try again" message, so a card never lands on a bot that didn't ask.

These checks match command text, so they're a high fence, not a wall: a bot with a shell runs as your OS user and could, with effort, get around them (a script that builds the path at runtime, for example). Real isolation needs a separate OS user, a container or VM.

Defense in depth: Cursor's **Auto-review** classifier and **sandbox** (bubblewrap/seatbelt) can be turned on in Settings → Brain. Know the trade-off: with either one on, a local SDK run can't ask you about MCP tool calls, so the SDK refuses connector tools (the browser, GitHub, …). Leave both off if your bots use connectors; your approval rules still gate shell commands.

## 8. Secrets

`request_secret` shows a masked card. The value goes straight to `SecretVault` (AES-256-GCM, key file 0600), never into a message or prompt. Bots use secrets two ways: `run_with_secrets` (runs a command with the values as environment variables, and scrubs them from the output), or connector configs that reference `${secret:NAME}`.

## 9. Runtimes: swapping the brain

`src/runtimes/types.ts` is the whole contract:

```ts
interface AgentRuntime {
  provides?: { workspaceTools?, projectContext?, mcp? };                        // what the brain brings itself
  open(spec: { botId, agentId?, name, cwd, model? }): Promise<RuntimeSession>;  // create or resume
  complete?(prompt, { model?, signal? }): Promise<string>;                      // optional one-shot (group routing)
  listModels?(), fetchModels?({ search }), lookupModel?(id);                    // the model picker and catalogue
}
interface RuntimeSession { agentId; send({ text, images, system, tools, mcpServers, model, onEvent }): Promise<RuntimeRun> }
interface RuntimeRun { steer?(text); cancel(); wait(): Promise<{ status, text, error?, usage? }> }
```

- `CursorRuntime` (`src/runtimes/cursor.ts`): the Cursor SDK local agent. Harness tools become SDK `customTools`, connectors become `mcpServers`, and stream events map to `onEvent`. Cursor brings its own file and shell tools, loads `AGENTS.md`, rules and skills from the workspace, and runs MCP servers, so it declares all three `provides` flags.
- `OpenAICompatRuntime` (`src/runtimes/openai.ts`): any OpenAI-compatible chat completions API. One instance per **provider**, described below.
- `MockRuntime` (`src/runtimes/mock.ts`): a scripted brain for tests and demos. It understands directives like `[[tool send_message {"to":"@critic","text":"hi"}]]`, so every feature can be tested without an API key.

### Providers

A provider is a saved `ProviderConfig` in `settings.json` (`src/core/providers.ts` has the presets and validation): base URL, models, concurrency, tool mode and optional headers. Each provider becomes a brain whose runtime id is the provider id (`featherless`, `openrouter`, …). Adding, editing or removing one in Settings rebuilds the registry (`Harness.syncProviders`). Bots keep `runtime` and `model` plus `modelRuntime`, the brain that model belongs to, so switching a bot's brain never sends a Cursor model id to Featherless or the reverse (`Harness.modelFor`). Removing a provider moves its bots to the default brain and posts a notice in their chats.

**Keys.** Provider keys live in a second `SecretVault` on their own files (`state/provider-keys.vault` and `.json`, same key file). They are not ordinary secrets, so `list_secrets`, `run_with_secrets` and `${secret:…}` can't reach them, and a bot can't ask for one and `curl` it somewhere. The API accepts a key (`PUT /api/providers/:id/key`) but never returns it, `describeProviders` only says whether one is set, and every tool output is scrubbed of both vaults' values before it goes to any model. A key in the environment (`FEATHERLESS_API_KEY`, named by `keyEnv`) is read once and deleted from `process.env`, kept in memory by variable name, and scrubbed like the vaults' values (even after its provider is removed). A preset's variable is only sent to that preset's service. The kernel keeps the environment a process started with, so the shell gate and the file-tool hook also refuse `/proc/<pid>/environ` and `ps e`; that's a fence, not a wall, which is why saving the key in the app is the safer way. The shell gate treats `provider-keys.*` as gateway state. The base URL and headers live in `settings.json`, which bots can't write, so a bot can't point the key at another host. When you move a provider to another host, its saved key is dropped and you're asked for one again. Plain `http://` is only accepted for this computer and your own network (private, link-local and 100.64/10 addresses, single-label names, `.local`, `.lan`, `.internal`), and those don't need a key.

### What the harness adds for a plain model API

A chat API has no tools, no project context and no MCP client, so the runner fills in what the runtime's `provides` leaves out:

| Cursor brings | For a provider brain, the harness supplies |
| --- | --- |
| Its agent's instructions plus `AGENTS.md`, `.cursor/rules` and skills from the workspace | `SendInput.system` from `Harness.systemPromptFor`: the manual, the workspace-tools section of the manual, `workspace/AGENTS.md`, other always-on rules and the skills index |
| File, search and shell tools | `buildWorkspaceTools` (`src/core/workspace-tools.ts`): `shell`, `read_file`, `write_file`, `edit_file`, `delete_file`, `list_dir`, `find_files`, `grep` and `web_fetch`, as ordinary harness tools |
| An MCP client for connectors | `McpHub` (`src/core/mcp-client.ts`): one per bot, connectors as `<server>__<tool>` tools |
| Its own transcript and compaction | The runtime keeps an OpenAI-format JSONL transcript per session in `state/agents/` and summarizes it when it outgrows the model's window |

**Workspace tools keep the approval boundary.** Cursor's shell goes through the hook in §7. The harness's own shell checks the same things in-process. A command that touches the gateway is refused before approvals, even after "Always allow" or with approvals off. Everything else goes to `approvals.gate` with the exact command text, so "Allow once" is consumed by the retry. Commands run in their own process group with a timeout, and the stop button kills the whole tree (a running connector call is cancelled too: the runtime passes an abort signal to tools). Their environment drops `CURSOR_API_KEY`, `CURSOR_BOTS_TOKEN` and provider key variables, and their output is scrubbed of secrets.

File tools are stricter than Cursor's. A path must resolve inside the workspace after following symlinks, and outside the gateway's protected paths. Walking tools don't follow symlinked folders. `grep` runs in a worker thread with a time limit, so a runaway regex can't freeze the gateway. `web_fetch` is GET only. It refuses the gateway itself and private or loopback addresses after DNS resolution. It connects to the address it checked, re-checks every redirect and caps what it returns. Because it pins the address, it doesn't use `HTTPS_PROXY`; on a machine that only reaches the web through a proxy, bots fall back to `curl` in the shell.

**Connectors.** `McpHub` speaks stdio (its own process group, killed on close), Streamable HTTP (session id, JSON or SSE answers, `DELETE` on close) and the older HTTP+SSE transport, and falls back to the older one when a server turns the POST away. Connections are reused across turns, restarted when they die or their config changes, and closed when a bot's session resets. A connector that dies mid-turn is restarted on the next call. An HTTP server that forgot the session gets a new one and the request is resent, since the server never ran it. HTTP tool lists are re-read once they're a minute old. Redirects are only followed to the same origin, so a connector's credential headers never go to another host. A failing server is reported once in the bot's chat, with its credentials removed before anything is shortened. Connector calls aren't gated, as with Cursor.

**The agent loop** (`openai.ts`) runs one turn as model call → tool calls → results → model call until the model answers.
- **Streaming.** Answers stream over SSE. Reasoning (`reasoning_content`, `reasoning`, or `<think>` tags) is shown as thinking and never ends up in the reply. Data a provider attaches to tool calls for its own use (Gemini's `extra_content.thought_signature`, OpenRouter's `reasoning_details`) is stored and sent back unchanged during that turn's tool loop, and dropped if the server rejects it.
- **Tool modes.** Per model: `native` (API function calling), `prompt` (tools described in the system message, calls parsed from `<tool_call>` blocks) or `none`. `auto` tries native and drops to prompt mode if the server or model can't do it.
- **Retries.** Concurrency limits (429), cold models still loading (Featherless answers 400 for those) and 503s are retried with backoff and a status line in the chat. Missing keys, gated models and unknown models fail at once with a message naming the provider.
- **Concurrency.** A semaphore holds bots to the provider's concurrency units, so they queue instead of failing.
- **Context.** Old tool output is shortened first, then older turns are summarized. The turn that just finished is always kept verbatim, and a summary carries the latest identity block. It also emits the `summary` event, which makes the runner resend identity and memory next turn, the same as after a Cursor compaction. The end-of-turn summary runs after the answer is posted: the next message stops it rather than waiting, and if it fails, history is left as it was. In a small window, where the instructions and tool schemas leave less than 15% for the conversation (an 8k Ollama default, say), the bot takes shorter replies instead of compacting every turn, compacts only when a request wouldn't fit at all, and says once that the window is too small. Replies are capped at half the window, with extra margin until the provider's token counts have calibrated the estimate.

To add another kind of brain (the Claude Agent SDK, a Cursor Cloud Agent), implement these interfaces, declare what it `provides`, and register it in `src/cli.ts`. Bots pick a brain in their details.

## 10. Team MCP: letting other harnesses in

`src/server/mcp.ts` serves a Model Context Protocol endpoint at `POST /mcp` (Streamable HTTP with JSON responses, Bearer token in `state/mcp.token`). Any MCP client can call four tools, acting as you:

| Tool | What it does |
| --- | --- |
| `list_bots` | The roster and groups, with who's busy |
| `message_bot` | Post as you to `@bot` or `#group`, then wait (up to `wait_seconds`) until the bots in that chat go quiet, and return their replies |
| `read_chat` | Recent messages in a bot's chat or a group |
| `create_bot` | Add a bot with a job |

This is how a Claude Code session, the Cursor IDE, Hermes or OpenClaw can delegate to your persistent team. It's the cross-harness version of the bot-to-bot handoff: the outside agent is just another teammate who messages through you.

## 11. Extending

- **A new tool**: add a `ToolSpec` to `TOOLS` in `src/core/tools.ts`. It receives `{ h, state }`, where `state.wake` says why the bot is running and `state.bot` says who it is.
- **A new connector**: Connect apps → Custom, or edit `connectors.json` (any MCP server, stdio or HTTP). Values can use `${bot.handle}`, `${bot.name}`, `${workspace}`, `${headless}` and `${secret:NAME}`, which are resolved per bot. The browser preset uses `--user-data-dir ${workspace}/.browser/${bot.handle}` to give each bot its own screen. (A single shared browser over CDP was tried: Playwright MCP clients then drive the same tab.)
- **House rules for everyone**: edit `workspace/AGENTS.md`.
- **A skill**: drop a folder with `SKILL.md` into `workspace/.cursor/skills/`, or ask a bot to `skill_save` one.

## 12. Testing

`npm test` runs the suite on the mock runtime: DMs, restart persistence, handoffs, groups and the loop guard, approvals, the real hook script (including tamper healing), routines and webhooks, skills, secrets, steering and stop, helper bots, deletion, the token gate. `test/regressions.test.ts` pins down fixed defects: shared chain budgets, stop reaching delegated work, queue survival across restarts, approvals inside handoffs, torn JSONL lines, skill frontmatter round-trips, paused routines on copy and import, time zone re-arming, absence pauses, and the chat Markdown renderer. `npm run typecheck` checks everything against the real `@cursor/sdk` types.

Provider brains are tested without any network: `test/openai-runtime.test.ts` drives the agent loop against a scripted OpenAI-compatible server (split SSE chunks, tool calls, reasoning, cold models, 429s, compaction, transcript resume), `test/mcp-client.test.ts` runs the MCP hub against a stdio fixture and local HTTP and SSE servers (and the gateway's own Team MCP endpoint), `test/workspace-tools.test.ts` checks the shell and file tools against the approval boundary, and `test/providers.test.ts` covers the registry, write-only keys and the providers API.
