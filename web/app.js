import { avatarHtml, avatarSvg, COLORS, groupAvatarHtml, initialHtml, SHAPES } from "./avatar.js";
import { esc, renderMarkdown } from "./markdown.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  state: null,
  current: null,
  messages: {},
  more: {},
  live: {},
  details: false,
  pending: [],
  replyTo: null,
  models: null,
  collapsed: { botdm: true, hidden: true },
  highlight: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const byId = (list, id) => list.find((x) => x.id === id);

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM4 5v16"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
  key: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(method, path, body, raw) {
  const opts = { method, headers: {} };
  if (raw) {
    opts.body = raw;
  } else if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(text, kind = "info", ms = 4000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message || String(err), "error");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bots = () => S.state?.bots ?? [];
const convs = () => S.state?.conversations ?? [];
const bot = (id) => byId(bots(), id);
const conv = (id) => byId(convs(), id);
const user = () => S.state?.settings?.user ?? { name: "Boss", label: "", avatar: { shape: "classic", color: "#f2f2f2" } };
const handles = () => new Set(bots().map((b) => b.handle));
const dmOf = (botId) => convs().find((c) => c.kind === "dm" && c.members[0] === botId);
const md = (text) => renderMarkdown(text, { handles: handles() });

function convTitle(c) {
  if (!c) return "";
  if (c.kind === "group") return c.title || "Group";
  if (c.kind === "dm") return bot(c.members[0])?.name ?? "Bot";
  return c.members.map((m) => bot(m)?.name ?? "?").join(" ↔ ");
}

function convAvatar(c, size) {
  if (c.kind === "dm") return avatarHtml(bot(c.members[0])?.avatar, size);
  const members = c.members.map(bot).filter(Boolean);
  if (c.kind === "botdm") {
    const s = Math.round(size * 0.7);
    return `<span class="group-avatar" style="width:${size}px;height:${size}px">${avatarHtml(members[0]?.avatar, s).replace('style="', 'style="left:0;top:0;')}${avatarHtml(members[1]?.avatar, s).replace('style="', `style="left:${size - s}px;top:${size - s}px;`)}</span>`;
  }
  return groupAvatarHtml(members, user(), size);
}

function timeLabel(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function sizeLabel(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
function fileUrl(path, download) {
  return `/api/files/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}
function isWorking(botId, convId) {
  const s = bot(botId)?.status;
  return s?.state === "working" && (!convId || s.convId === convId);
}
function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = { ...list[i], ...item };
  else list.push(item);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function isPinned(c) {
  return c.kind === "dm" ? Boolean(bot(c.members[0])?.pinned) : Boolean(c.pinned);
}

function sortConvs(list) {
  return list.sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
}

function convRow(c) {
  const b = c.kind === "dm" ? bot(c.members[0]) : null;
  const working = c.members.some((m) => isWorking(m, c.id)) || (b && isWorking(b.id));
  const label = b?.label ? `<span class="pill">${esc(b.label)}</span>` : "";
  const preview = c.lastPreview || (b?.about ? b.about : c.kind === "group" ? c.purpose || "Group chat" : "");
  const badge = working ? '<span class="working"></span>' : c.attention ? '<span class="badge attention"></span>' : c.unread ? '<span class="badge"></span>' : "";
  return `<div class="conv ${S.current === c.id ? "active" : ""} ${c.unread ? "unread" : ""}" data-conv="${c.id}" title="${esc(convTitle(c))}">
    ${convAvatar(c, 50)}
    <div class="meta"><div class="title-row"><span class="title">${esc(convTitle(c))}</span>${label}</div>
    <div class="preview">${esc(preview)}</div></div>${badge}</div>`;
}

function renderSidebar() {
  const el = $("#sidebar");
  if (!S.state) return;
  const u = user();
  const visible = convs().filter((c) => {
    if (c.kind === "botdm") return false;
    if (c.kind === "dm") return !bot(c.members[0])?.hidden && !c.hidden;
    return !c.hidden;
  });
  const hidden = convs().filter((c) => c.kind !== "botdm" && (c.hidden || (c.kind === "dm" && bot(c.members[0])?.hidden)));
  const botdms = convs().filter((c) => c.kind === "botdm");
  const sections = new Map();
  for (const c of sortConvs(visible)) {
    const sec = c.kind === "dm" ? bot(c.members[0])?.section || "" : "";
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(c);
  }
  const connected = Object.values(S.state.connectors ?? {}).filter((c) => c.enabled).length;
  let html = `<div class="side-top">
      <button class="round-btn" id="btn-search" title="Search (Ctrl/⌘ K)">${ICON.search}</button>
      <button class="round-btn" id="btn-new" title="New bot or group (Ctrl/⌘ N)">${ICON.plus}</button>
    </div>
    <div class="profile" id="btn-profile" title="Edit your profile">${avatarHtml(u.avatar, 76, { star: true })}<div class="name">${esc(u.name)}</div>${u.label ? `<span class="pill">${esc(u.label)}</span>` : ""}</div>
    <div class="conv-list">`;
  const keys = [...sections.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  for (const k of keys) {
    if (k) html += `<div class="conv-section">${esc(k)}</div>`;
    html += sections.get(k).map(convRow).join("");
  }
  if (!visible.length) html += `<div class="muted" style="padding:20px 12px">No bots yet. Press + to create one.</div>`;
  if (botdms.length) {
    html += `<div class="conv-section" data-toggle="botdm"><span>Between bots (${botdms.length})</span><span>${S.collapsed.botdm ? "▸" : "▾"}</span></div>`;
    if (!S.collapsed.botdm) html += sortConvs(botdms).map(convRow).join("");
  }
  if (hidden.length) {
    html += `<div class="conv-section" data-toggle="hidden"><span>Hidden (${hidden.length})</span><span>${S.collapsed.hidden ? "▸" : "▾"}</span></div>`;
    if (!S.collapsed.hidden) html += sortConvs(hidden).map(convRow).join("");
  }
  html += `</div><div class="side-bottom">
      <button class="me-dot" id="btn-settings" title="Settings">${esc((u.name || "d").charAt(0).toLowerCase())}</button>
      <button class="connect-btn" id="btn-connect" title="${connected} connected">Connect apps <span class="count">${connected || ""}</span></button>
      <button class="icon-btn" id="btn-skills" title="Skills">${ICON.book}</button>
      <button class="icon-btn" id="btn-files" title="Shared computer (workspace files)">${ICON.folder}</button>
    </div>`;
  el.innerHTML = html;
  $$(".conv", el).forEach((row) => {
    row.addEventListener("click", () => openConv(row.dataset.conv));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      convMenu(row.dataset.conv, e.clientX, e.clientY);
    });
  });
  $$("[data-toggle]", el).forEach((t) =>
    t.addEventListener("click", () => {
      S.collapsed[t.dataset.toggle] = !S.collapsed[t.dataset.toggle];
      renderSidebar();
    }),
  );
  $("#btn-new").onclick = () => openNewModal();
  $("#btn-search").onclick = () => openSearch();
  $("#btn-profile").onclick = () => openSettings("general");
  $("#btn-settings").onclick = () => openSettings("general");
  $("#btn-connect").onclick = () => openConnectors();
  $("#btn-skills").onclick = () => openSkills();
  $("#btn-files").onclick = () => openFiles();
}

/** Right-click menu on a sidebar row: Pin, sections, Mark as unread, Rename, Hide, Delete. */
function convMenu(id, x, y) {
  $("#ctx")?.remove();
  const c = conv(id);
  if (!c) return;
  const b = c.kind === "dm" ? bot(c.members[0]) : null;
  const pinned = b ? b.pinned : c.pinned;
  const hidden = b ? b.hidden : c.hidden;
  const items = [
    ["pin", pinned ? "Unpin" : "Pin"],
    ...(b ? [["section", b.section ? "Move to section…" : "Move to new section…"]] : []),
    ["unread", "Mark as unread"],
    ...(c.kind !== "botdm" ? [["rename", b ? "Rename bot" : "Rename chat"]] : []),
    ["copyid", "Copy conversation ID"],
    ...(c.kind !== "botdm" ? [["hide", hidden ? "Show in sidebar" : "Hide from sidebar"]] : []),
    ...(c.kind !== "botdm" ? [["delete", b ? "Delete bot" : "Delete group"]] : []),
  ];
  const menu = document.createElement("div");
  menu.id = "ctx";
  menu.className = "suggest";
  menu.style.cssText = `position:fixed;left:${Math.min(x, innerWidth - 240)}px;top:${Math.min(y, innerHeight - 40 * items.length)}px;bottom:auto;min-width:220px`;
  menu.innerHTML = items.map(([k, label]) => `<div class="item" data-act="${k}" ${k === "delete" ? 'style="color:var(--danger)"' : ""}>${esc(label)}</div>`).join("");
  document.body.appendChild(menu);
  const close = () => menu.remove();
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
  const patchBot = (body) => attempt(() => api("PATCH", `/api/bots/${b.id}`, body));
  const patchConv = (body) => attempt(() => api("PATCH", `/api/conversations/${c.id}`, body));
  $$("[data-act]", menu).forEach(
    (el) =>
      (el.onclick = async () => {
        close();
        const act = el.dataset.act;
        if (act === "pin") b ? patchBot({ pinned: !pinned }) : patchConv({ pinned: !pinned });
        else if (act === "hide") b ? patchBot({ hidden: !hidden }) : patchConv({ hidden: !hidden });
        else if (act === "section") {
          const sec = prompt("Section name (empty to remove):", b.section ?? "");
          if (sec !== null) patchBot({ section: sec });
        } else if (act === "unread") {
          if (S.current === id) {
            S.current = null;
            history.replaceState(null, "", "#/");
            renderMain();
          }
          patchConv({ unread: Math.max(1, c.unread) });
        } else if (act === "rename") {
          const name = prompt("New name:", convTitle(c));
          if (name?.trim()) b ? patchBot({ name: name.trim() }) : patchConv({ title: name.trim() });
        } else if (act === "copyid") {
          navigator.clipboard?.writeText(c.id);
          toast("Conversation ID copied");
        } else if (act === "delete") {
          if (!confirm(b ? `Delete ${b.name}? This removes its profile, chat and routines.` : `Delete the group “${convTitle(c)}”? The bots stay.`)) return;
          await attempt(() => api("DELETE", b ? `/api/bots/${b.id}` : `/api/conversations/${c.id}`));
        }
      }),
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

async function openConv(id, opts = {}) {
  const c = conv(id);
  if (!c) return;
  const changed = S.current !== id;
  S.current = id;
  if (changed) {
    S.pending = [];
    S.replyTo = null;
  }
  if (location.hash !== `#/c/${id}`) history.replaceState(null, "", `#/c/${id}`);
  $("#app").classList.add("chat-open");
  S.highlight = opts.highlight ?? null;
  // Switch the composer right away so nothing typed meanwhile goes to the previous chat.
  if (changed || !$("#c-input")) renderMain();
  renderSidebar();
  if (S.details) renderDetails();
  if (!S.messages[id]) {
    const res = await attempt(() => api("GET", `/api/conversations/${id}/messages?limit=150`));
    const loaded = res?.messages ?? [];
    // Keep anything that arrived over SSE while the history was loading.
    const live = (S.messages[id] ?? []).filter((m) => !loaded.some((x) => x.id === m.id));
    S.messages[id] = [...loaded, ...live];
    S.more[id] = res?.more ?? false;
    if (opts.highlight) {
      await loadUntil(id, opts.highlight);
      // A live message may have rendered (and cleared the highlight) while history loaded.
      S.highlight = opts.highlight;
    }
    if (S.current === id) renderTranscript(true);
  } else if (opts.highlight && (await loadUntil(id, opts.highlight))) {
    S.highlight = opts.highlight;
    if (S.current === id) renderTranscript(true);
  } else if (!changed) {
    renderTranscript(Boolean(S.highlight));
  }
  markRead(id);
}

/** Page back through older history until a message is loaded (a search hit). Returns true if it loaded more. */
async function loadUntil(id, msgId) {
  let loadedMore = false;
  while (S.messages[id] && !S.messages[id].some((m) => m.id === msgId) && S.more[id]) {
    const first = S.messages[id][0];
    const res = await attempt(() => api("GET", `/api/conversations/${id}/messages?limit=150&before=${first?.ts ?? Date.now()}`));
    if (!res) break;
    S.messages[id] = [...res.messages.filter((m) => !S.messages[id].some((x) => x.id === m.id)), ...S.messages[id]];
    S.more[id] = res.more;
    loadedMore = true;
    if (!res.messages.length) break;
  }
  return loadedMore;
}

function markRead(id) {
  const c = conv(id);
  if (c && (c.unread || c.attention) && document.visibilityState === "visible") {
    c.unread = 0;
    api("POST", `/api/conversations/${id}/read`).catch(() => {});
  }
}

function renderEmpty() {
  const hasBots = bots().length > 0;
  const rt = S.state.runtimes.find((r) => r.id === S.state.settings.runtime);
  $("#main").innerHTML = `<div class="empty">
    ${avatarHtml({ shape: "classic", color: "#ff3b3b" }, 84)}
    <h2>${hasBots ? "Pick a bot or a group" : "Build your team"}</h2>
    <p>Bots are persistent AI teammates with a name, a job, memory and their own chat. They share one computer (the workspace), message each other, and run routines while you're away.</p>
    ${rt && !rt.ok ? `<div class="banner">${esc(rt.reason)} Restart with the key set, or switch the brain to the demo (“mock”) in Settings → Brain & models to click around first.</div>` : ""}
    <div class="row">
      <button class="btn primary" id="e-new">Create a bot</button>
      ${hasBots ? "" : '<button class="btn" id="e-starter">Add a starter team</button>'}
      ${bots().length >= 2 ? '<button class="btn" id="e-group">Start a group chat</button>' : ""}
    </div></div>`;
  $("#e-new").onclick = () => openNewModal("bot");
  if ($("#e-starter")) $("#e-starter").onclick = async () => {
    const snap = await attempt(() => api("POST", "/api/onboarding/starter"));
    if (snap) {
      S.state = snap;
      renderAll();
    }
  };
  if ($("#e-group")) $("#e-group").onclick = () => openNewModal("group");
}

function renderMain() {
  const c = conv(S.current);
  if (!c) return renderEmpty();
  const b = c.kind === "dm" ? bot(c.members[0]) : null;
  const rt = S.state.runtimes.find((r) => r.id === (b?.runtime || S.state.settings.runtime));
  const placeholder = composerPlaceholder(c);
  $("#main").innerHTML = `
    <div class="chat-head" id="chat-head"></div>
    <div class="transcript" id="transcript"><div class="transcript-inner" id="tx"></div></div>
    ${rt && !rt.ok ? `<div class="banner">${esc(rt.reason)}</div>` : ""}
    <div class="composer-wrap" ${c.kind === "botdm" ? "hidden" : ""}>
      <div class="composer" id="composer">
        <div id="c-reply"></div>
        <div class="pending-atts" id="c-atts" hidden></div>
        <div class="composer-row">
          <button class="c-btn" id="c-attach" title="Attach files">${ICON.plus}</button>
          <textarea id="c-input" rows="1" placeholder="${esc(placeholder)}"></textarea>
          <button class="c-btn" id="c-mic" title="Dictate">${ICON.mic}</button>
          <button class="c-btn send" id="c-send" title="Send">${ICON.send}</button>
        </div>
        <input type="file" id="c-file" multiple hidden />
      </div>
    </div>`;
  renderHeader();
  setupComposer(c);
  renderTranscript(true);
}

function composerPlaceholder(c) {
  return c.kind === "group" ? `Message ${convTitle(c)} — @ to address one bot` : c.kind === "botdm" ? "Bot-to-bot threads are read-only" : `Message ${convTitle(c)}`;
}

function renderHeader() {
  const el = $("#chat-head");
  const c = conv(S.current);
  if (!el || !c) return;
  const b = c.kind === "dm" ? bot(c.members[0]) : null;
  const working = c.members.filter((m) => isWorking(m, c.id)).map((m) => bot(m)?.name);
  const sub = working.length ? (c.kind === "dm" ? "working…" : `${working.join(", ")} working…`) : c.kind === "group" ? `${c.members.length} bots` : c.kind === "botdm" ? "bot-to-bot thread" : b?.label ?? "";
  el.innerHTML = `<button class="icon-btn mobile-only" id="h-back" style="position:absolute;left:12px;top:10px;pointer-events:auto">${ICON.back}</button>
      <div class="head-pill" id="h-pill">${convAvatar(c, 30)}<span>${esc(convTitle(c))}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>
      <div class="head-actions"><button class="icon-btn" id="h-info" title="Details">${ICON.info}</button></div>`;
  $("#h-pill").onclick = () => toggleDetails(true);
  $("#h-info").onclick = () => toggleDetails();
  $("#h-back").onclick = () => {
    $("#app").classList.remove("chat-open");
    S.current = null;
    history.replaceState(null, "", "#/");
    renderSidebar();
  };
}

function shouldStick() {
  const t = $("#transcript");
  return !t || t.scrollHeight - t.scrollTop - t.clientHeight < 160;
}
function scrollBottom() {
  const t = $("#transcript");
  if (t) t.scrollTop = t.scrollHeight;
}

function renderTranscript(forceBottom = false) {
  const tx = $("#tx");
  const c = conv(S.current);
  if (!tx || !c) return;
  const stick = forceBottom || shouldStick();
  if (!S.messages[c.id]) {
    tx.innerHTML = '<div class="notice">Loading…</div><div id="live"></div>';
    return;
  }
  const list = S.messages[c.id];
  const parts = [];
  if (S.more[c.id]) parts.push('<button class="btn small load-more" id="load-more">Load earlier messages</button>');
  let lastDay = "";
  let lastAuthor = "";
  for (const m of list) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) {
      parts.push(`<div class="day">${esc(day)}</div>`);
      lastDay = day;
      lastAuthor = "";
    }
    const authorKey = m.author.kind === "bot" ? m.author.id : m.author.kind;
    parts.push(renderMessage(m, c, authorKey !== lastAuthor));
    lastAuthor = ["message", "error", "handoff"].includes(m.kind) ? authorKey : "";
  }
  if (!list.length) {
    const b = c.kind === "dm" ? bot(c.members[0]) : null;
    parts.push(`<div class="notice">${c.kind === "dm" ? `This is your chat with ${esc(b?.name)}. Give it a job, its sources, and where it must stop for your approval, then a first task with a clear finish line.` : c.kind === "group" ? "Describe the shared outcome and who owns the next step. Write normally to let the bots decide who answers, or @mention one." : "Handoffs between these bots appear here."}</div>`);
  }
  parts.push('<div id="live"></div>');
  // Re-rendering must not wipe a secret you're pasting or fold up a step list you opened.
  const typed = $$("[data-secret-input]", tx).map((el) => [el.dataset.secretInput, el.value]).filter(([, v]) => v);
  const openDetails = $$(".msg details[open]", tx).map((d) => d.closest(".msg")?.dataset.msg).filter(Boolean);
  const focused = document.activeElement?.dataset?.secretInput;
  const sel = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  tx.innerHTML = parts.join("");
  for (const [rid, v] of typed) {
    const el = tx.querySelector(`[data-secret-input="${CSS.escape(rid)}"]`);
    if (el) el.value = v;
  }
  for (const mid of openDetails) tx.querySelector(`.msg[data-msg="${CSS.escape(mid)}"] details`)?.setAttribute("open", "");
  if (focused) {
    const el = tx.querySelector(`[data-secret-input="${CSS.escape(focused)}"]`);
    if (el) {
      el.focus();
      if (sel) el.setSelectionRange(sel[0], sel[1]);
    }
  }
  renderLive();
  bindTranscript(tx, c);
  if (S.highlight) {
    const el = tx.querySelector(`[data-msg="${S.highlight}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.style.outline = "2px solid var(--accent-2)";
      el.style.borderRadius = "18px";
      setTimeout(() => (el.style.outline = ""), 2500);
    }
    S.highlight = null;
  } else if (stick) scrollBottom();
}

function attachmentsHtml(atts) {
  if (!atts?.length) return "";
  return `<div class="attachments">${atts
    .map((a) =>
      /^image\//.test(a.mime) && !/svg/.test(a.mime)
        ? `<img class="att-img" src="${fileUrl(a.path)}" alt="${esc(a.name)}" data-zoom="${esc(a.path)}" loading="lazy">`
        : /^video\//.test(a.mime)
          ? `<video class="att-img" src="${fileUrl(a.path)}" controls preload="metadata"></video>`
          : /^audio\//.test(a.mime)
            ? `<audio src="${fileUrl(a.path)}" controls preload="none"></audio>`
            : `<a class="att-file" href="${fileUrl(a.path, true)}" title="${esc(a.path)}">${ICON.file}<span><div class="fname">${esc(a.name)}</div><div class="fsize">${sizeLabel(a.size)} · ${esc(a.path)}</div></span></a>`,
    )
    .join("")}</div>`;
}

function activityHtml(m) {
  const act = m.meta?.activity;
  if (!act?.length) return "";
  const secs = m.meta?.durationMs ? Math.max(1, Math.round(m.meta.durationMs / 1000)) : null;
  const extra = [m.meta?.model, m.meta?.usage?.totalTokens ? `${fmtTokens(m.meta.usage.totalTokens)} tokens` : ""].filter(Boolean).join(" · ");
  return `<details class="activity"><summary>${ICON.clock}${secs ? `Worked for ${secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`} · ` : ""}${act.length} step${act.length === 1 ? "" : "s"}${extra ? ` · ${esc(extra)}` : ""}</summary><ul>${act
    .map((a) => `<li><span class="dot ${a.status}"></span><span class="tname">${esc(a.name)}</span><span class="tsum">${esc(a.summary || "")}</span></li>`)
    .join("")}</ul></details>`;
}

function authorHeader(m, c) {
  if (m.author.kind === "user") return "";
  if (c.kind === "dm" && m.kind !== "handoff") return "";
  const b = bot(m.author.id);
  return `<div class="who">${avatarHtml(b?.avatar, 22)}<span>${esc(b?.name ?? "Deleted bot")}</span><span>${timeLabel(m.ts)}</span></div>`;
}

function renderMessage(m, c, showAuthor) {
  const mine = m.author.kind === "user";
  if (m.kind === "notice") return `<div class="notice" data-msg="${m.id}">${md(m.text)}</div>`;
  if (m.kind === "routine") return `<div class="routine-pill" data-msg="${m.id}">${ICON.clock}${esc(m.text)}</div>`;
  if (m.kind === "approval") return approvalCard(m);
  if (m.kind === "secret_request") return secretCard(m);
  if (m.kind === "handoff") {
    const from = bot(m.author.id);
    const to = bot(m.meta?.to);
    const thread = m.meta?.threadId && m.meta.threadId !== c.id ? `<button class="btn small" data-open="${m.meta.threadId}">Open thread</button>` : "";
    return `<div class="msg" data-msg="${m.id}"><div class="card handoff-card"><div class="route">${avatarHtml(from?.avatar, 20)}<b>${esc(from?.name ?? "?")}</b>${ICON.arrow}${avatarHtml(to?.avatar, 20)}<b>${esc(to?.name ?? "?")}</b><span class="muted">handoff · ${timeLabel(m.ts)}</span></div><div class="bubble" style="background:transparent;padding:0">${md(m.text)}</div>${attachmentsHtml(m.attachments)}<div class="row">${thread}</div></div></div>`;
  }
  const replied = m.replyTo ? (S.messages[c.id] ?? []).find((x) => x.id === m.replyTo) : null;
  return `<div class="msg ${mine ? "user" : ""} ${m.kind === "error" ? "error" : ""}" data-msg="${m.id}">
    ${showAuthor ? authorHeader(m, c) : ""}
    ${replied ? `<div class="reply-quote">↪ ${esc(replied.text.slice(0, 140))}</div>` : ""}
    ${m.text ? `<div class="bubble">${md(m.text)}</div>` : ""}
    ${attachmentsHtml(m.attachments)}
    ${activityHtml(m)}
    <div class="msg-actions"><button data-reply="${m.id}">Reply</button><button data-copy="${m.id}">Copy</button>${m.meta?.requestId ? `<button data-reqid="${esc(m.meta.requestId)}">Copy request ID</button>` : ""}<span class="muted" style="font-size:11px;padding:3px">${timeLabel(m.ts)}</span></div>
  </div>`;
}

function approvalCard(m) {
  const a = (S.state.approvals ?? []).find((x) => x.id === m.meta?.approvalId);
  const b = bot(m.author.id);
  if (!a) return `<div class="notice" data-msg="${m.id}">Approval request (no longer available)</div>`;
  const state =
    a.status === "pending"
      ? `<div class="row"><button class="btn primary" data-approve="once" data-id="${a.id}">Allow once</button><button class="btn" data-approve="always" data-id="${a.id}">Always allow</button><button class="btn danger" data-approve="deny" data-id="${a.id}">Deny</button></div>${a.expiresAt ? `<div class="state">Expires ${timeLabel(a.expiresAt)} (started without you)</div>` : ""}`
      : `<div class="state">${a.status === "allowed" ? (a.decision === "always" ? "✓ Always allowed" : "✓ Allowed once") : a.status === "denied" ? "✕ Denied" : "Expired"}</div>`;
  return `<div class="msg" data-msg="${m.id}"><div class="card"><div class="card-title">${ICON.shield}${esc(b?.name ?? "A bot")} wants to: ${esc(a.kind === "shell" ? "run a command" : a.title)}</div>${a.command ? `<pre>${esc(a.command)}</pre>` : ""}${a.details ? `<div class="bubble" style="background:transparent;padding:0;font-size:14.5px">${md(a.details)}</div>` : ""}${state}</div></div>`;
}

function secretCard(m) {
  const r = (S.state.secretRequests ?? []).find((x) => x.id === m.meta?.secretRequestId);
  const b = bot(m.author.id);
  if (!r) return `<div class="notice" data-msg="${m.id}">Secret request</div>`;
  const body =
    r.status === "pending"
      ? `<div class="row"><input class="input" type="password" autocomplete="off" placeholder="Paste the value" data-secret-input="${r.id}" style="flex:1"><button class="btn primary" data-secret-save="${r.id}">Save securely</button><button class="btn" data-secret-dismiss="${r.id}">Dismiss</button></div><div class="state">Stored encrypted on this machine and never shown to your bot.</div>`
      : `<div class="state">${r.status === "saved" ? "✓ Saved securely and kept private." : "Dismissed."}</div>`;
  return `<div class="msg" data-msg="${m.id}"><div class="card"><div class="card-title">${ICON.key}${esc(b?.name ?? "A bot")} needs <code>${esc(r.name)}</code></div>${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}${body}</div></div>`;
}

function bindTranscript(tx, c) {
  const more = $("#load-more", tx);
  if (more)
    more.onclick = async () => {
      const first = S.messages[c.id]?.[0];
      const res = await attempt(() => api("GET", `/api/conversations/${c.id}/messages?limit=150&before=${first?.ts ?? Date.now()}`));
      if (!res) return;
      const t = $("#transcript");
      const prevH = t.scrollHeight;
      S.messages[c.id] = [...res.messages, ...(S.messages[c.id] ?? [])];
      S.more[c.id] = res.more;
      renderTranscript();
      t.scrollTop = t.scrollHeight - prevH;
    };
  $$("[data-zoom]", tx).forEach((img) => (img.onclick = () => lightbox(fileUrl(img.dataset.zoom))));
  $$("[data-open]", tx).forEach((b) => (b.onclick = () => openConv(b.dataset.open)));
  $$("[data-reply]", tx).forEach(
    (b) =>
      (b.onclick = () => {
        S.replyTo = b.dataset.reply;
        renderReplying();
        $("#c-input")?.focus();
      }),
  );
  $$("[data-copy]", tx).forEach(
    (b) =>
      (b.onclick = () => {
        const m = (S.messages[c.id] ?? []).find((x) => x.id === b.dataset.copy);
        navigator.clipboard?.writeText(m?.text ?? "");
        toast("Copied");
      }),
  );
  $$("[data-reqid]", tx).forEach(
    (b) =>
      (b.onclick = () => {
        navigator.clipboard?.writeText(b.dataset.reqid);
        toast("Request ID copied");
      }),
  );
  $$("[data-approve]", tx).forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        const a = await attempt(() => api("POST", `/api/approvals/${b.dataset.id}`, { decision: b.dataset.approve }));
        if (a) upsert(S.state.approvals, a);
        renderTranscript();
      }),
  );
  $$("[data-secret-save]", tx).forEach(
    (b) =>
      (b.onclick = async () => {
        const input = tx.querySelector(`[data-secret-input="${b.dataset.secretSave}"]`);
        if (!input.value) return toast("Enter a value first", "error");
        const r = await attempt(() => api("POST", `/api/secret-requests/${b.dataset.secretSave}`, { value: input.value }));
        input.value = "";
        if (r) upsert(S.state.secretRequests, r);
        renderTranscript();
      }),
  );
  $$("[data-secret-dismiss]", tx).forEach(
    (b) =>
      (b.onclick = async () => {
        const r = await attempt(() => api("POST", `/api/secret-requests/${b.dataset.secretDismiss}`, { dismiss: true }));
        if (r) upsert(S.state.secretRequests, r);
        renderTranscript();
      }),
  );
}

let liveFrame = 0;
function scheduleLive() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const stick = shouldStick();
    renderLive();
    if (stick) scrollBottom();
  });
}

function renderLive() {
  const el = $("#live");
  const c = conv(S.current);
  if (!el || !c) return;
  const runs = Object.entries(S.live).filter(([, l]) => l.convId === c.id);
  el.innerHTML = runs
    .map(([botId, l]) => {
      const b = bot(botId);
      const tools = [...l.tools.values()].slice(-5);
      const head = c.kind === "dm" ? "" : `<div class="who">${avatarHtml(b?.avatar, 22)}<span>${esc(b?.name ?? "")}</span><span>working…</span></div>`;
      const text = l.text.replace(/\n*NO_REPLY\.?\s*$/i, "");
      return `<div class="msg live" style="margin-top:4px">${head}<div class="bubble">${text ? md(text) : '<span class="typing"><span></span><span></span><span></span></span>'}</div>${
        tools.length ? `<div class="live-tools">${tools.map((t) => `<div><span class="dot ${t.status}"></span><span>${esc(t.name)}</span><span>${esc(t.summary || "")}</span></div>`).join("")}</div>` : ""
      }</div>`;
    })
    .join("");
  updateSendButton();
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

let recognition = null;

function setupComposer(c) {
  const input = $("#c-input");
  if (!input) return;
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(220, input.scrollHeight) + "px";
  };
  input.addEventListener("input", () => {
    autosize();
    updateSuggest();
    updateSendButton();
  });
  input.addEventListener("keydown", (e) => {
    const sug = $("#suggest");
    if (sug && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
      const items = $$(".item", sug);
      let i = items.findIndex((x) => x.classList.contains("sel"));
      if (e.key === "Escape") {
        sug.remove();
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        i = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((x, j) => x.classList.toggle("sel", j === i));
        e.preventDefault();
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && items[i]) {
        items[i].click();
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(c);
    }
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });
  const comp = $("#composer");
  comp.addEventListener("dragover", (e) => {
    e.preventDefault();
    comp.classList.add("drag");
  });
  comp.addEventListener("dragleave", () => comp.classList.remove("drag"));
  comp.addEventListener("drop", (e) => {
    e.preventDefault();
    comp.classList.remove("drag");
    uploadFiles([...(e.dataTransfer?.files ?? [])]);
  });
  $("#c-attach").onclick = () => $("#c-file").click();
  $("#c-file").onchange = (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = "";
  };
  $("#c-send").onclick = () => {
    if ($("#c-send").classList.contains("stop")) stopCurrent(c);
    else send(c);
  };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $("#c-mic").hidden = true;
  $("#c-mic").onclick = () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.interimResults = true;
    recognition.continuous = true;
    const base = input.value ? input.value + " " : "";
    recognition.onresult = (ev) => {
      let t = "";
      for (const r of ev.results) t += r[0].transcript;
      input.value = base + t;
      autosize();
      updateSendButton();
    };
    recognition.onend = () => {
      recognition = null;
      $("#c-mic")?.classList.remove("listening");
    };
    recognition.start();
    $("#c-mic").classList.add("listening");
  };
  renderPending();
  renderReplying();
  updateSendButton();
  if (window.matchMedia("(min-width: 761px)").matches) input.focus();
}

function updateSendButton() {
  const btn = $("#c-send");
  const c = conv(S.current);
  if (!btn || !c) return;
  const empty = !$("#c-input")?.value.trim() && !S.pending.length;
  const working = c.members.some((m) => isWorking(m, c.id));
  const stop = empty && working;
  btn.classList.toggle("stop", stop);
  btn.innerHTML = stop ? ICON.stop : ICON.send;
  btn.title = stop ? "Stop now" : "Send";
}

async function stopCurrent(c) {
  await attempt(() => api("POST", `/api/conversations/${c.id}/stop`));
}

async function uploadFiles(files) {
  for (const f of files.slice(0, 6 - S.pending.length)) {
    const att = await attempt(() => api("POST", `/api/uploads?name=${encodeURIComponent(f.name || "pasted.png")}`, undefined, f));
    if (att) S.pending.push(att);
    renderPending();
    updateSendButton();
  }
}

function renderPending() {
  const el = $("#c-atts");
  if (!el) return;
  el.hidden = !S.pending.length;
  el.innerHTML = S.pending
    .map((a, i) => `<span class="patt">${/^image\//.test(a.mime) ? `<img src="${fileUrl(a.path)}" alt="">` : ICON.file}<span>${esc(a.name)}</span><button data-rm="${i}" title="Remove">×</button></span>`)
    .join("");
  $$("[data-rm]", el).forEach(
    (b) =>
      (b.onclick = () => {
        S.pending.splice(Number(b.dataset.rm), 1);
        renderPending();
        updateSendButton();
      }),
  );
}

function renderReplying() {
  const el = $("#c-reply");
  if (!el) return;
  const m = S.replyTo ? (S.messages[S.current] ?? []).find((x) => x.id === S.replyTo) : null;
  if (!m) {
    el.innerHTML = "";
    return;
  }
  const who = m.author.kind === "bot" ? bot(m.author.id)?.name : m.author.kind === "user" ? "yourself" : "system";
  el.innerHTML = `<div class="replying"><span>Replying to ${esc(who)}: ${esc(m.text.slice(0, 80))}</span><button class="icon-btn" id="c-unreply" style="width:26px;height:26px">${ICON.close}</button></div>`;
  $("#c-unreply").onclick = () => {
    S.replyTo = null;
    renderReplying();
  };
}

async function send(c) {
  const input = $("#c-input");
  const text = input.value.trim();
  if (!text && !S.pending.length) return;
  const body = { text, attachments: S.pending.map((a) => a.path), replyTo: S.replyTo };
  input.value = "";
  input.style.height = "auto";
  const pending = S.pending;
  S.pending = [];
  S.replyTo = null;
  renderPending();
  renderReplying();
  $("#suggest")?.remove();
  const msg = await attempt(() => api("POST", `/api/conversations/${c.id}/messages`, body));
  if (!msg) {
    input.value = text;
    S.pending = pending;
    renderPending();
    return;
  }
  addMessage(msg);
  updateSendButton();
}

function updateSuggest() {
  const input = $("#c-input");
  const c = conv(S.current);
  $("#suggest")?.remove();
  if (!input || !c) return;
  const before = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)([@/])([\w-]*)$/.exec(before);
  if (!m) return;
  const [, , sigil, q] = m;
  const ql = q.toLowerCase();
  let items = [];
  if (sigil === "@") {
    const pool = c.kind === "group" ? c.members.map(bot).filter(Boolean) : bots();
    items = pool
      .filter((b) => b.handle.includes(ql) || b.name.toLowerCase().includes(ql))
      .map((b) => ({ insert: `@${b.handle} `, html: `${avatarHtml(b.avatar, 24)}<span>${esc(b.name)}</span><span class="desc">@${esc(b.handle)}${b.label ? " · " + esc(b.label) : ""}</span>` }));
    if (c.kind === "group" && "everyone".startsWith(ql)) items.push({ insert: "@everyone ", html: "<b>@everyone</b><span class=\"desc\">every bot in this group</span>" });
  } else {
    items = (S.state.skills ?? [])
      .filter((s) => s.name.includes(ql))
      .map((s) => ({ insert: `/${s.name} `, html: `<b>/${esc(s.name)}</b><span class="desc">${esc(s.description)}</span>` }));
    if (!items.length && !ql) items = [{ insert: "", html: '<span class="desc">No skills yet. Ask a bot to save a workflow as a skill.</span>' }];
  }
  if (!items.length) return;
  const box = document.createElement("div");
  box.className = "suggest";
  box.id = "suggest";
  box.innerHTML = items.slice(0, 12).map((it, i) => `<div class="item ${i === 0 ? "sel" : ""}" data-i="${i}">${it.html}</div>`).join("");
  $("#composer").appendChild(box);
  $$(".item", box).forEach(
    (el) =>
      (el.onclick = () => {
        const it = items[Number(el.dataset.i)];
        if (!it.insert) return box.remove();
        const start = before.length - q.length - 1;
        input.value = input.value.slice(0, start) + it.insert + input.value.slice(input.selectionStart);
        const pos = start + it.insert.length;
        input.setSelectionRange(pos, pos);
        input.focus();
        box.remove();
        updateSendButton();
      }),
  );
}

function addMessage(m) {
  if (!S.messages[m.convId]) {
    // Not loaded yet: remember it only if this chat is loading right now.
    if (m.convId !== S.current) return;
    S.messages[m.convId] = [];
  }
  const list = S.messages[m.convId];
  if (list.some((x) => x.id === m.id)) return;
  list.push(m);
  if (m.convId === S.current) {
    renderTranscript(m.author.kind === "user");
    if (m.author.kind !== "user") markRead(m.convId);
  }
}

// ---------------------------------------------------------------------------
// Details drawer
// ---------------------------------------------------------------------------

function toggleDetails(force) {
  S.details = force ?? !S.details;
  renderDetails();
}

function switchHtml(id, checked) {
  return `<label class="switch"><input type="checkbox" id="${id}" ${checked ? "checked" : ""}><span></span></label>`;
}

async function loadModels() {
  if (S.models) return S.models;
  const res = await api("GET", "/api/models").catch(() => ({ models: [] }));
  S.models = res.models ?? [];
  return S.models;
}

function modelSelectHtml(id, current, allowDefault = true) {
  const models = S.models ?? [];
  const ids = new Set(models.map((m) => m.id));
  const opts = [];
  if (allowDefault) opts.push(`<option value="">Default (${esc(S.state.settings.defaultModel?.id ?? "")})</option>`);
  for (const m of models) opts.push(`<option value="${esc(m.id)}" ${current === m.id ? "selected" : ""}>${esc(m.displayName || m.id)}</option>`);
  if (current && !ids.has(current)) opts.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
  opts.push('<option value="__custom">Other model id…</option>');
  return `<select id="${id}">${opts.join("")}</select>`;
}

function renderDetails() {
  const el = $("#details");
  const c = conv(S.current);
  if (!S.details || !c) {
    el.hidden = true;
    return;
  }
  if (el.contains(document.activeElement) && !el.hidden && el.dataset.conv === c.id) return;
  el.hidden = false;
  el.dataset.conv = c.id;
  if (c.kind === "dm") return renderBotDetails(el, bot(c.members[0]));
  if (c.kind === "group") return renderGroupDetails(el, c);
  el.innerHTML = `<div class="details-head"><b>Bot-to-bot thread</b><button class="icon-btn" id="d-close">${ICON.close}</button></div>
    <p class="muted">Handoffs between ${c.members.map((m) => esc(bot(m)?.name)).join(" and ")} show up here. It's read-only: message a bot in its own chat to step in.</p>
    <div class="row">${c.members.map((m) => `<button class="btn small" data-open="${dmOf(m)?.id}">Open ${esc(bot(m)?.name)}</button>`).join(" ")}</div>`;
  $("#d-close").onclick = () => toggleDetails(false);
  $$("[data-open]", el).forEach((b) => (b.onclick = () => openConv(b.dataset.open)));
}

async function renderBotDetails(el, b) {
  if (!b) return;
  const routines = (S.state.routines ?? []).filter((r) => r.botId === b.id);
  const skills = S.state.skills ?? [];
  const connectors = Object.keys(S.state.connectors ?? {});
  const runtimes = S.state.runtimes ?? [];
  const pendingApprovals = (S.state.approvals ?? []).filter((a) => a.botId === b.id && a.status === "pending");
  const status = b.status?.state === "working" ? `working${b.status.queued ? `, ${b.status.queued} queued` : ""}` : b.status?.state === "error" ? `last run failed` : b.status?.queued ? `${b.status.queued} queued` : "idle";
  el.innerHTML = `<div class="details-head"><span class="muted">Bot details</span><button class="icon-btn" id="d-close">${ICON.close}</button></div>
    <div class="d-hero">
      <button id="d-avatar" style="border:none;background:none;padding:0" title="Change picture">${avatarHtml(b.avatar, 96)}</button>
      <input class="big-name" id="d-name" value="${esc(b.name)}" maxlength="48">
      <input class="label-input" id="d-label" value="${esc(b.label ?? "")}" placeholder="Add a label">
      <div class="handle">@${esc(b.handle)} · ${esc(status)}${b.createdBy !== "user" ? ` · helper of ${esc(bot(b.createdBy)?.name ?? "a bot")}` : ""}</div>
      ${b.usage?.turns ? `<div class="handle" title="Since ${esc(new Date(b.usage.since).toLocaleDateString())}">${b.usage.turns} turn${b.usage.turns === 1 ? "" : "s"} · ${fmtTokens(b.usage.totalTokens)} tokens</div>` : ""}
      ${b.status?.state === "error" && b.status.detail ? `<div class="banner" style="width:100%">${esc(b.status.detail)}</div>` : ""}
    </div>
    <div class="d-section"><h4>Job</h4>
      <div class="field"><textarea id="d-about" rows="4" placeholder="What this bot owns, in operational terms. E.g. “Own the weekly account-health review… Never contact a customer without approval.”">${esc(b.about ?? "")}</textarea></div>
      <div class="row"><button class="btn small" id="d-about-save">Save job</button><span class="muted">Lasting rules live in memory; tell the bot “remember…”.</span></div>
    </div>
    <div class="d-section"><h4>Settings</h4>
      <div class="toggle-row"><span>Notifications</span>${switchHtml("d-notif", b.notifications)}</div>
      <div class="toggle-row"><span>Pin to top</span>${switchHtml("d-pin", b.pinned)}</div>
      <div class="toggle-row"><span>Hide from sidebar</span>${switchHtml("d-hide", b.hidden)}</div>
      <div class="field">Section<input id="d-section" value="${esc(b.section ?? "")}" placeholder="e.g. Client A"></div>
      <div class="field">Model ${modelSelectHtml("d-model", b.model?.id)}</div>
      <div class="field">Brain (runtime)<select id="d-runtime"><option value="">Default (${esc(S.state.settings.runtime)})</option>${runtimes.map((r) => `<option value="${r.id}" ${b.runtime === r.id ? "selected" : ""}>${esc(r.label)}${r.ok ? "" : " — unavailable"}</option>`).join("")}</select></div>
    </div>
    ${pendingApprovals.length ? `<div class="d-section"><h4>Waiting for you</h4>${pendingApprovals.map((a) => `<div class="list-row"><div class="grow"><div class="t">${esc(a.command ?? a.title)}</div></div><button class="btn small primary" data-ap="once" data-id="${a.id}">Allow</button><button class="btn small" data-ap="deny" data-id="${a.id}">Deny</button></div>`).join("")}</div>` : ""}
    <div class="d-section"><h4>Routines <button class="btn small" id="d-add-routine">Add routine</button></h4>
      ${routines.length ? routines.map(routineHtml).join("") : '<div class="muted">Ask in chat to set a routine, e.g. “Every weekday at 9:00 AM, summarize new support tickets here.”</div>'}
    </div>
    <div class="d-section"><h4>Memory <span><button class="btn small" id="d-mem-save">Save</button></span></h4>
      <div class="field"><textarea id="d-mem" class="mono" rows="10" placeholder="Loading…"></textarea></div>
      <span class="muted">What the bot remembers across sessions: lasting rules, preferences, facts and a work log. It's added to every turn.</span>
    </div>
    <div class="d-section"><h4>Connectors</h4>
      ${connectors.length ? `<div class="check-list"><label><input type="checkbox" id="d-conn-all" ${b.connectors === "all" ? "checked" : ""}> All connected apps</label>${connectors.map((n) => `<label><input type="checkbox" data-conn="${esc(n)}" ${b.connectors === "all" || b.connectors.includes(n) ? "checked" : ""} ${b.connectors === "all" ? "disabled" : ""}> ${esc(n)}</label>`).join("")}</div>` : '<div class="muted">No apps connected. Use “Connect apps” in the sidebar.</div>'}
    </div>
    <div class="d-section"><h4>Skills</h4>
      ${skills.length ? `<div class="check-list">${skills.map((s) => `<label title="${esc(s.description)}"><input type="checkbox" data-skill="${esc(s.name)}" ${b.disabledSkills.includes(s.name) ? "" : "checked"}> /${esc(s.name)}</label>`).join("")}</div>` : '<div class="muted">No skills yet. After a bot finishes a workflow, ask it to “save this as a skill”.</div>'}
    </div>
    <div class="d-section"><h4>More</h4>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small" id="d-dup">Duplicate</button>
        <button class="btn small" id="d-export">Export template</button>
        <button class="btn small" id="d-stop">Stop work</button>
        <button class="btn small danger" id="d-delete">Delete bot</button>
      </div>
      <span class="muted">Deleting removes the profile, chat and routines. Files and sign-ins on the shared computer stay.</span>
    </div>`;
  const patch = (body) => attempt(() => api("PATCH", `/api/bots/${b.id}`, body));
  $("#d-close").onclick = () => toggleDetails(false);
  $("#d-avatar").onclick = () => openAvatarPicker(b.avatar, (avatar) => patch({ avatar }));
  $("#d-name").onchange = (e) => patch({ name: e.target.value });
  $("#d-label").onchange = (e) => patch({ label: e.target.value });
  $("#d-about-save").onclick = async () => {
    if (await patch({ about: $("#d-about").value })) toast("Job saved");
  };
  $("#d-notif").onchange = (e) => {
    patch({ notifications: e.target.checked });
    if (e.target.checked) askNotificationPermission();
  };
  $("#d-pin").onchange = (e) => patch({ pinned: e.target.checked });
  $("#d-hide").onchange = (e) => patch({ hidden: e.target.checked });
  $("#d-section").onchange = (e) => patch({ section: e.target.value });
  $("#d-model").onchange = (e) => {
    let v = e.target.value;
    if (v === "__custom") v = prompt("Model id (see `cursor-bots models`):", b.model?.id ?? "") ?? "";
    patch({ model: v ? { id: v } : null });
  };
  $("#d-runtime").onchange = (e) => patch({ runtime: e.target.value });
  $("#d-add-routine").onclick = () => {
    const input = $("#c-input");
    if (input) {
      input.value = "Set up a routine to ";
      input.focus();
    }
  };
  $$("[data-ap]", el).forEach(
    (btn) =>
      (btn.onclick = async () => {
        const a = await attempt(() => api("POST", `/api/approvals/${btn.dataset.id}`, { decision: btn.dataset.ap }));
        if (a) upsert(S.state.approvals, a);
        renderDetails();
        renderTranscript();
      }),
  );
  bindRoutines(el);
  const mem = await api("GET", `/api/bots/${b.id}/memory`).catch(() => ({ content: "" }));
  if ($("#d-mem")) {
    $("#d-mem").value = mem.content;
    $("#d-mem").placeholder = "Empty";
  }
  $("#d-mem-save").onclick = async () => {
    if (await attempt(() => api("PUT", `/api/bots/${b.id}/memory`, { content: $("#d-mem").value }))) toast("Memory saved");
  };
  const allBox = $("#d-conn-all");
  if (allBox)
    allBox.onchange = () => {
      const picked = $$("[data-conn]", el).filter((x) => x.checked).map((x) => x.dataset.conn);
      patch({ connectors: allBox.checked ? "all" : picked });
    };
  $$("[data-conn]", el).forEach((x) => (x.onchange = () => patch({ connectors: $$("[data-conn]", el).filter((y) => y.checked).map((y) => y.dataset.conn) })));
  $$("[data-skill]", el).forEach((x) => (x.onchange = () => patch({ disabledSkills: $$("[data-skill]", el).filter((y) => !y.checked).map((y) => y.dataset.skill) })));
  $("#d-dup").onclick = async () => {
    const copy = await attempt(() => api("POST", `/api/bots/${b.id}/duplicate`));
    if (copy) toast(`Created ${copy.name}`);
  };
  $("#d-export").onclick = async () => {
    const t = await attempt(() => api("GET", `/api/bots/${b.id}/export`));
    if (!t) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(t, null, 2)], { type: "application/json" }));
    a.download = `${b.handle}.bot.json`;
    a.click();
  };
  $("#d-stop").onclick = () => attempt(() => api("POST", `/api/bots/${b.id}/stop`));
  $("#d-delete").onclick = async () => {
    if (!confirm(`Delete ${b.name}? This removes its profile, chat and routines. It can't be undone.`)) return;
    await attempt(() => api("DELETE", `/api/bots/${b.id}`));
  };
  if (!S.models) loadModels().then(() => S.details && conv(S.current)?.kind === "dm" && !el.contains(document.activeElement) && renderDetails());
}

function routineHtml(r) {
  const hist = (r.history ?? []).map((h) => `<span class="dot ${h.status === "succeeded" ? "completed" : h.status === "failed" ? "error" : "running"}" title="${esc(`${h.trigger} · ${h.status} · ${new Date(h.startedAt).toLocaleString()}${h.error ? " · " + h.error : ""}`)}"></span>`).join("");
  const hook = r.webhookKey ? `${location.origin}/api/webhooks/routines/${r.id}` : "";
  return `<div class="routine" data-routine="${r.id}">
    <div class="r-head"><span class="r-name">${esc(r.name)}</span>${switchHtml(`rt-${r.id}`, r.enabled)}</div>
    <div class="r-when">${r.enabled ? esc(r.when) : `Paused${r.pausedReason ? ` — ${esc(r.pausedReason)}` : ""}`} · ${esc(r.timezoneResolved)}${r.enabled && r.nextRunAt ? ` · next ${new Date(r.nextRunAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}</div>
    <div class="r-inst">${esc(r.instruction)}</div>
    ${hook ? `<div class="copy-field"><span>POST to</span><code>${esc(hook)}</code><button class="btn small" data-copytext="${esc(hook)}">Copy</button></div><div class="copy-field"><span>key</span><code>${esc(r.webhookKey)}</code><button class="btn small" data-copytext="Authorization: Bearer ${esc(r.webhookKey)}">Copy header</button></div>` : ""}
    ${hist ? `<div class="r-hist" title="Run history (latest 20)">${hist}</div>` : '<div class="muted">No runs yet</div>'}
    <div class="row" style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" data-rtest="${r.id}">Test</button><button class="btn small" data-redit="${r.id}">Edit</button><button class="btn small" data-rhook="${r.id}">${r.webhookKey ? "Remove webhook" : "Add webhook"}</button><button class="btn small danger" data-rdel="${r.id}">Delete</button></div>
  </div>`;
}

function bindRoutines(el) {
  $$(".routine", el).forEach((box) => {
    const id = box.dataset.routine;
    const r = (S.state.routines ?? []).find((x) => x.id === id);
    $(`#rt-${id}`, box).onchange = (e) => attempt(() => api("PATCH", `/api/routines/${id}`, { enabled: e.target.checked }));
  });
  $$("[data-rtest]", el).forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        b.textContent = "Running…";
        const ok = await attempt(() => api("POST", `/api/routines/${b.dataset.rtest}/test`));
        if (!ok) toast("Couldn't start a test run", "error");
      }),
  );
  $$("[data-rdel]", el).forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("Delete this routine? Future runs stop and it can't be undone.")) return;
        await attempt(() => api("DELETE", `/api/routines/${b.dataset.rdel}`));
      }),
  );
  $$("[data-rhook]", el).forEach((b) => {
    const r = (S.state.routines ?? []).find((x) => x.id === b.dataset.rhook);
    b.onclick = () => attempt(() => api("PATCH", `/api/routines/${r.id}`, { webhook: !r.webhookKey }));
  });
  $$("[data-redit]", el).forEach((b) => (b.onclick = () => openRoutineEditor((S.state.routines ?? []).find((x) => x.id === b.dataset.redit))));
  $$("[data-copytext]", el).forEach(
    (b) =>
      (b.onclick = () => {
        navigator.clipboard?.writeText(b.dataset.copytext);
        toast("Copied");
      }),
  );
}

function renderGroupDetails(el, c) {
  el.innerHTML = `<div class="details-head"><span class="muted">Group details</span><button class="icon-btn" id="d-close">${ICON.close}</button></div>
    <div class="d-hero">${convAvatar(c, 84)}<input class="big-name" id="g-title" value="${esc(c.title ?? "")}"><div class="handle">${c.members.length} bots</div></div>
    <div class="d-section"><h4>Shared outcome</h4><div class="field"><textarea id="g-purpose" rows="3" placeholder="What this group is for and who owns each stage">${esc(c.purpose ?? "")}</textarea></div><div class="row"><button class="btn small" id="g-purpose-save">Save</button></div></div>
    <div class="d-section"><h4>Members (2–${S.state.settings.limits.maxGroupSize})</h4><div class="bot-pick">${bots().map((b) => `<label class="${c.members.includes(b.id) ? "on" : ""}"><input type="checkbox" value="${b.id}" ${c.members.includes(b.id) ? "checked" : ""}>${avatarHtml(b.avatar, 24)}${esc(b.name)}</label>`).join("")}</div></div>
    <div class="d-section"><h4>Lead</h4><div class="field"><select id="g-lead"><option value="">No lead — bots decide who answers</option>${c.members.map((m) => `<option value="${m}" ${c.lead === m ? "selected" : ""}>${esc(bot(m)?.name)}</option>`).join("")}</select></div>
      <span class="muted">Un-addressed messages go to ${S.state.settings.groupRouting === "llm" ? "whoever a quick routing model picks" : S.state.settings.groupRouting === "lead" ? "the lead" : "the bot named in the message, else the lead"}. @mention a bot to address it, or @everyone.</span></div>
    <div class="d-section"><h4>More</h4><div class="row" style="display:flex;gap:8px"><button class="btn small" id="g-stop">Stop all work here</button><button class="btn small danger" id="g-delete">Delete group</button></div></div>`;
  const patch = (body) => attempt(() => api("PATCH", `/api/conversations/${c.id}`, body));
  $("#d-close").onclick = () => toggleDetails(false);
  $("#g-title").onchange = (e) => patch({ title: e.target.value });
  $("#g-purpose-save").onclick = () => patch({ purpose: $("#g-purpose").value });
  $("#g-lead").onchange = (e) => patch({ lead: e.target.value });
  $$(".bot-pick input", el).forEach(
    (x) =>
      (x.onchange = async () => {
        const members = $$(".bot-pick input", el).filter((y) => y.checked).map((y) => y.value);
        const ok = await patch({ members });
        if (!ok) x.checked = !x.checked;
        x.parentElement.classList.toggle("on", x.checked);
      }),
  );
  $("#g-stop").onclick = () => stopCurrent(c);
  $("#g-delete").onclick = async () => {
    if (!confirm(`Delete the group “${c.title}”? The bots stay.`)) return;
    await attempt(() => api("DELETE", `/api/conversations/${c.id}`));
  };
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function modal({ title, body, foot = "", wide = false, tabs = null }) {
  const root = $("#modal-root");
  const wrap = document.createElement("div");
  wrap.className = "overlay";
  wrap.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-label="${esc(title)}"><div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close>${ICON.close}</button></div>${tabs ?? ""}<div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ""}</div>`;
  root.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("mousedown", (e) => {
    if (e.target === wrap) close();
  });
  $("[data-close]", wrap).onclick = close;
  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Only the innermost modal closes; the document handler would close its parent too.
    e.stopPropagation();
    close();
  });
  setTimeout(() => $("input,textarea,select", $(".modal-body", wrap))?.focus(), 20);
  return { el: wrap, close };
}

function lightbox(src) {
  const el = document.createElement("div");
  el.className = "lightbox";
  el.innerHTML = `<img src="${src}" alt="">`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

function openNewModal(tab = "bot") {
  const draft = { avatar: { shape: SHAPES[Math.floor(Math.random() * SHAPES.length)], color: COLORS[Math.floor(Math.random() * 8)] } };
  const tabsHtml = `<div class="tabs"><button data-tab="bot">New bot</button><button data-tab="group">New group chat</button><button data-tab="import">Import template</button></div>`;
  const m = modal({ title: "New", body: "", tabs: tabsHtml });
  const body = $(".modal-body", m.el);
  const show = (t) => {
    $$(".tabs button", m.el).forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    if (t === "bot") {
      body.innerHTML = `<div style="display:flex;gap:14px;align-items:center"><button id="n-av" style="border:none;background:none;padding:0" title="Change picture">${avatarHtml(draft.avatar, 72)}</button>
          <div style="flex:1;display:flex;flex-direction:column;gap:8px"><div class="field">Name<input id="n-name" placeholder="e.g. Talent Scout" maxlength="48"></div><div class="field">Label (optional)<input id="n-label" placeholder="e.g. Recruiting"></div></div></div>
        <div class="field">Job<textarea id="n-about" rows="4" placeholder="Own the weekly account-health review. Pull usage and support signals, flag churn risk, and produce a linked watch list. Never contact a customer without approval."></textarea></div>
        <div class="muted">Give each bot a focused job (its own goal, tools, approval boundary or schedule). “General Helper” bots are harder to reuse.</div>
        <div class="row" style="display:flex;justify-content:flex-end;gap:8px"><button class="btn primary" id="n-create">Create bot</button></div>`;
      $("#n-av").onclick = () =>
        openAvatarPicker(draft.avatar, (a) => {
          draft.avatar = a;
          $("#n-av").innerHTML = avatarHtml(a, 72);
        });
      $("#n-create").onclick = async () => {
        const b = await attempt(() => api("POST", "/api/bots", { name: $("#n-name").value, label: $("#n-label").value, about: $("#n-about").value, avatar: draft.avatar }));
        if (!b) return;
        m.close();
        upsert(S.state.bots, b);
        const res = await api("GET", "/api/state");
        S.state = res;
        renderAll();
        const dm = dmOf(b.id);
        if (dm) openConv(dm.id);
      };
      $("#n-name").addEventListener("keydown", (e) => e.key === "Enter" && $("#n-create").click());
    } else if (t === "group") {
      if (bots().length < 2) {
        body.innerHTML = '<div class="muted">Create at least two bots first.</div>';
        return;
      }
      body.innerHTML = `<div class="field">Name<input id="g-name" placeholder="e.g. Website Launch"></div>
        <div class="field">Pick 2–${S.state.settings.limits.maxGroupSize} bots</div><div class="bot-pick">${bots().map((b) => `<label><input type="checkbox" value="${b.id}">${avatarHtml(b.avatar, 24)}${esc(b.name)}</label>`).join("")}</div>
        <div class="field">Shared outcome<textarea id="g-purpose-n" rows="3" placeholder="Researcher gathers sources, Writer drafts, Reviewer lists blocking issues. Nothing gets published."></textarea></div>
        <div class="field">Lead (optional)<select id="g-lead-n"><option value="">No lead — bots decide who answers</option></select></div>
        <div class="row" style="display:flex;justify-content:flex-end"><button class="btn primary" id="g-create">Create group</button></div>`;
      const sync = () => {
        const picked = $$(".bot-pick input", body).filter((x) => x.checked);
        $$(".bot-pick label", body).forEach((l) => l.classList.toggle("on", $("input", l).checked));
        const sel = $("#g-lead-n");
        const cur = sel.value;
        sel.innerHTML = '<option value="">No lead — bots decide who answers</option>' + picked.map((x) => `<option value="${x.value}" ${cur === x.value ? "selected" : ""}>${esc(bot(x.value)?.name)}</option>`).join("");
      };
      $$(".bot-pick input", body).forEach((x) => (x.onchange = sync));
      $("#g-create").onclick = async () => {
        const members = $$(".bot-pick input", body).filter((x) => x.checked).map((x) => x.value);
        const c = await attempt(() => api("POST", "/api/conversations", { title: $("#g-name").value, members, purpose: $("#g-purpose-n").value, lead: $("#g-lead-n").value || undefined }));
        if (!c) return;
        m.close();
        upsert(S.state.conversations, c);
        openConv(c.id);
      };
    } else {
      body.innerHTML = `<div class="muted">Paste a bot template (exported from another Cursor Bots install) or pick the .bot.json file. You get your own copy: profile, job, routines and lasting rules. No history or logins.</div>
        <div class="field"><textarea id="i-json" class="mono" rows="10" placeholder='{"format":"cursor-bots/bot@1", ...}'></textarea></div>
        <div class="row" style="display:flex;justify-content:space-between"><input type="file" id="i-file" accept=".json,application/json"><button class="btn primary" id="i-go">Import</button></div>`;
      $("#i-file").onchange = async (e) => {
        const f = e.target.files[0];
        if (f) $("#i-json").value = await f.text();
      };
      $("#i-go").onclick = async () => {
        let t;
        try {
          t = JSON.parse($("#i-json").value);
        } catch {
          return toast("That isn't valid JSON", "error");
        }
        const b = await attempt(() => api("POST", "/api/bots/import", t));
        if (!b) return;
        m.close();
        S.state = await api("GET", "/api/state");
        renderAll();
        const dm = dmOf(b.id);
        if (dm) openConv(dm.id);
      };
    }
    setTimeout(() => $("input,textarea", body)?.focus(), 10);
  };
  $$(".tabs button", m.el).forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  show(tab);
}

function openAvatarPicker(current, onPick) {
  let pick = { ...current };
  const m = modal({
    title: "Picture",
    body: `<div class="pick-grid" id="p-shapes"></div><div class="swatches" id="p-colors"></div>
      <div class="row" style="display:flex;gap:8px;align-items:center"><span class="muted">Custom color</span><input type="color" id="p-custom" value="${esc(pick.color || "#ff3b3b")}"><span style="flex:1"></span><label class="btn small">Upload image<input type="file" id="p-upload" accept="image/*" hidden></label>${pick.image ? '<button class="btn small" id="p-noimg">Use blob</button>' : ""}</div>`,
    foot: '<button class="btn primary" id="p-set">Set avatar</button>',
  });
  const draw = () => {
    $("#p-shapes", m.el).innerHTML = SHAPES.map((s) => `<button data-shape="${s}" class="${pick.shape === s && !pick.image ? "on" : ""}" title="${s}">${avatarSvg({ shape: s, color: pick.color })}</button>`).join("");
    $("#p-colors", m.el).innerHTML = COLORS.map((c) => `<button data-color="${c}" class="${pick.color === c ? "on" : ""}" style="background:${c}"></button>`).join("");
    $$("[data-shape]", m.el).forEach((b) => (b.onclick = () => ((pick = { ...pick, shape: b.dataset.shape, image: undefined }), draw())));
    $$("[data-color]", m.el).forEach((b) => (b.onclick = () => ((pick = { ...pick, color: b.dataset.color }), draw())));
  };
  draw();
  $("#p-custom", m.el).oninput = (e) => {
    pick.color = e.target.value;
    draw();
  };
  $("#p-upload", m.el).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const att = await attempt(() => api("POST", `/api/uploads?name=${encodeURIComponent(f.name)}`, undefined, f));
    if (att) {
      pick.image = att.path;
      toast("Image uploaded. Press Set avatar.");
    }
  };
  if ($("#p-noimg", m.el)) $("#p-noimg", m.el).onclick = () => ((pick.image = ""), draw());
  $("#p-set", m.el).onclick = () => {
    onPick({ ...pick, image: pick.image || "" });
    m.close();
  };
}

function openRoutineEditor(r) {
  const m = modal({
    title: `Edit routine`,
    body: `<div class="field">Name<input id="re-name" value="${esc(r.name)}"></div>
      <div class="field">Instruction<textarea id="re-inst" rows="6">${esc(r.instruction)}</textarea></div>
      <div class="grid2"><div class="field">Schedule (cron: min hour day month weekday)<input id="re-cron" value="${esc(r.cron ?? "")}" placeholder="0 8 * * 1-5"></div>
      <div class="field">Time zone<input id="re-tz" value="${esc(r.timezone ?? "")}" placeholder="${esc(S.state.timezone)} (your setting)"></div></div>
      <div class="field">Skill (optional)<input id="re-skill" value="${esc(r.skill ?? "")}" placeholder="skill-name"></div>
      <div class="muted">Or tell the bot in chat: “Edit your routine ${esc(r.name)}: …”. Runs must be at least ${S.state.settings.limits.minRoutineIntervalMinutes} minutes apart.</div>`,
    foot: '<button class="btn primary" id="re-save">Save</button>',
  });
  $("#re-save", m.el).onclick = async () => {
    const ok = await attempt(() =>
      api("PATCH", `/api/routines/${r.id}`, { name: $("#re-name").value, instruction: $("#re-inst").value, cron: $("#re-cron").value, timezone: $("#re-tz").value, skill: $("#re-skill").value }),
    );
    if (ok) m.close();
  };
}

function openSettings(tab = "general") {
  const tabsHtml = `<div class="tabs">${[
    ["general", "General"],
    ["brain", "Brain & models"],
    ["approvals", "Approvals"],
    ["secrets", "Secrets"],
    ["agents", "Connect your agents"],
    ["limits", "Limits"],
    ["about", "About"],
  ]
    .map(([k, l]) => `<button data-tab="${k}">${l}</button>`)
    .join("")}</div>`;
  const m = modal({ title: "Settings", body: "", tabs: tabsHtml, wide: true });
  const body = $(".modal-body", m.el);
  const save = (patch) => attempt(async () => {
    const s = await api("PATCH", "/api/settings", patch);
    S.state.settings = s;
    toast("Saved");
    renderSidebar();
    return s;
  });
  const show = async (t) => {
    $$(".tabs button", m.el).forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    const s = S.state.settings;
    if (t === "general") {
      const zones = (Intl.supportedValuesOf?.("timeZone") ?? []).map((z) => `<option ${s.timezone === z ? "selected" : ""}>${z}</option>`).join("");
      body.innerHTML = `<div style="display:flex;gap:16px;align-items:center"><button id="s-av" style="border:none;background:none;padding:0">${avatarHtml(s.user.avatar, 72, { star: true })}</button>
        <div class="grid2" style="flex:1"><div class="field">Your name (bots call you this)<input id="s-name" value="${esc(s.user.name)}"></div><div class="field">Your label<input id="s-label" value="${esc(s.user.label)}"></div></div></div>
        <div class="field">Time zone for routines<select id="s-tz"><option value="auto" ${s.timezone === "auto" ? "selected" : ""}>Auto-detect (${esc(S.state.timezone)})</option>${zones}</select></div>
        <div class="field">Appearance<select id="s-theme"><option value="dark">Dark</option><option value="light">Light</option><option value="system">Follow system</option></select></div>
        <div class="toggle-row"><span>Desktop notifications (for bots with notifications on)</span><button class="btn small" id="s-notif">${window.Notification?.permission === "granted" ? "Enabled" : "Enable"}</button></div>
        <div class="row" style="display:flex;justify-content:flex-end"><button class="btn primary" id="s-save">Save</button></div>`;
      $("#s-theme").value = savedTheme();
      $("#s-theme").onchange = (e) => setTheme(e.target.value);
      $("#s-notif").onclick = () => askNotificationPermission();
      let avatar = s.user.avatar;
      $("#s-av").onclick = () =>
        openAvatarPicker(avatar, (a) => {
          avatar = a;
          $("#s-av").innerHTML = avatarHtml(a, 72, { star: true });
        });
      $("#s-save").onclick = () => save({ user: { name: $("#s-name").value, label: $("#s-label").value, avatar }, timezone: $("#s-tz").value });
    } else if (t === "brain") {
      await loadModels();
      body.innerHTML = `<div class="field">Default brain for bots<select id="s-rt">${S.state.runtimes.map((r) => `<option value="${r.id}" ${s.runtime === r.id ? "selected" : ""}>${esc(r.label)}${r.ok ? "" : ` — ${esc(r.reason)}`}</option>`).join("")}</select></div>
        <div class="grid2"><div class="field">Default model ${modelSelectHtml("s-model", s.defaultModel?.id, false)}</div><div class="field">Routing model (picks who answers in groups) ${modelSelectHtml("s-router", s.routerModel?.id, false)}</div></div>
        ${S.models?.length ? "" : '<div class="muted">Model list appears once a Cursor API key is configured. You can still type a model id (e.g. composer-2.5).</div>'}
        <div class="field">Un-addressed group messages<select id="s-routing"><option value="llm" ${s.groupRouting === "llm" ? "selected" : ""}>Bots decide (a quick routing model picks one)</option><option value="lead" ${s.groupRouting === "lead" ? "selected" : ""}>Go to the group's lead</option><option value="heuristic" ${s.groupRouting === "heuristic" ? "selected" : ""}>Name match, then lead (no model call)</option></select></div>
        <div class="toggle-row"><span>Cursor Auto-review classifier for shell/MCP calls (in addition to your rules)</span>${switchHtml("s-ar", s.cursorAutoReview)}</div>
        <div class="toggle-row"><span>Cursor sandbox for shell commands (needs bubblewrap on Linux)</span>${switchHtml("s-sb", s.cursorSandbox)}</div>
        <div class="muted">Heads-up: with Auto-review or the sandbox on, the Cursor SDK can't ask you about connector (MCP) tool calls in a local run, so it refuses them. Leave both off if your bots use connected apps such as the browser; your approval rules still apply to shell commands.</div>
        <div class="row" style="display:flex;justify-content:flex-end"><button class="btn primary" id="s-save">Save</button></div>`;
      const val = (id) => {
        const v = $(id).value;
        return v === "__custom" ? prompt("Model id:") || "" : v;
      };
      $("#s-save").onclick = () => {
        const dm = val("#s-model");
        const rm = val("#s-router");
        // Same model as before: send it whole so its params (the router's fast mode) survive.
        const pick = (id, cur) => (id ? (cur?.id === id ? cur : { id }) : null);
        save({ runtime: $("#s-rt").value, defaultModel: pick(dm, s.defaultModel) ?? undefined, routerModel: pick(rm, s.routerModel), groupRouting: $("#s-routing").value, cursorAutoReview: $("#s-ar").checked, cursorSandbox: $("#s-sb").checked }).then(() => {
          S.models = null;
          refreshState();
        });
      };
    } else if (t === "approvals") {
      const rules = s.approvals.rules;
      body.innerHTML = `<div class="muted">Bots ask before consequential actions. Shell commands are checked by a Cursor hook installed in the workspace; other actions go through the bot's request_approval tool. “Ask first” wins when rules conflict.</div>
        <div class="grid2"><div class="field">Mode<select id="a-mode"><option value="auto" ${s.approvals.mode === "auto" ? "selected" : ""}>Auto: only “ask first” rules stop shell commands</option><option value="ask" ${s.approvals.mode === "ask" ? "selected" : ""}>Ask: every shell command stops unless allowed</option><option value="off" ${s.approvals.mode === "off" ? "selected" : ""}>Off: never stop (not recommended)</option></select></div>
        <div class="field">Background approvals expire after (minutes)<input id="a-exp" type="number" min="1" value="${s.approvals.backgroundExpiryMinutes}"></div></div>
        <div class="field">Seconds a bot waits inline for your answer before ending its turn<input id="a-wait" type="number" min="0" max="120" value="${s.approvals.inlineWaitSeconds}"></div>
        <div class="d-section"><h4>Custom rules <button class="btn small" id="a-add">Add rule</button></h4><div id="a-rules" style="display:flex;flex-direction:column;gap:6px"></div></div>
        <div class="row" style="display:flex;justify-content:flex-end"><button class="btn primary" id="a-save">Save</button></div>`;
      const list = rules.map((r) => ({ ...r }));
      const draw = () => {
        $("#a-rules").innerHTML = list
          .map(
            (r, i) => `<div class="list-row"><select data-i="${i}" data-k="effect"><option value="ask" ${r.effect === "ask" ? "selected" : ""}>Ask first</option><option value="allow" ${r.effect === "allow" ? "selected" : ""}>Allow automatically</option></select>
            <select data-i="${i}" data-k="target"><option value="shell" ${r.target === "shell" ? "selected" : ""}>shell</option><option value="action" ${r.target === "action" ? "selected" : ""}>action</option></select>
            <input class="input grow" data-i="${i}" data-k="pattern" value="${esc(r.pattern)}" title="Regular expression" style="font-family:var(--mono);font-size:12.5px">
            <input class="input" data-i="${i}" data-k="note" value="${esc(r.note ?? "")}" placeholder="note" style="width:160px"><button class="btn small danger" data-del="${i}">✕</button></div>`,
          )
          .join("");
        $$("[data-k]", body).forEach((x) => (x.onchange = () => (list[Number(x.dataset.i)][x.dataset.k] = x.value)));
        $$("[data-del]", body).forEach((x) => (x.onclick = () => (list.splice(Number(x.dataset.del), 1), draw())));
      };
      draw();
      $("#a-add").onclick = () => {
        list.push({ effect: "ask", target: "shell", pattern: "", note: "" });
        draw();
      };
      $("#a-save").onclick = () => save({ approvals: { mode: $("#a-mode").value, inlineWaitSeconds: Number($("#a-wait").value), backgroundExpiryMinutes: Number($("#a-exp").value), rules: list.filter((r) => r.pattern.trim()) } });
    } else if (t === "secrets") {
      const draw = () => {
        const list = S.state.secrets ?? [];
        body.innerHTML = `<div class="muted">Secrets are write-only: stored encrypted in your Cursor Bots home, never shown to bots or written into chats. Bots use them through run_with_secrets, and connectors can reference them as <code>\${secret:NAME}</code>.</div>
          ${list.map((x) => `<div class="list-row"><div class="grow"><div class="t">${esc(x.name)}</div><div class="s">${esc(x.description ?? "")} · updated ${new Date(x.updatedAt).toLocaleString()}</div></div><button class="btn small" data-replace="${esc(x.name)}">Replace</button><button class="btn small danger" data-rm="${esc(x.name)}">Remove</button></div>`).join("") || '<div class="muted">No secrets yet.</div>'}
          <div class="d-section"><h4>Add secret</h4><div class="grid2"><div class="field">Name<input id="x-name" placeholder="NOTION_API_KEY"></div><div class="field">Description (visible to bots)<input id="x-desc" placeholder="Notion integration token"></div></div><div class="field">Value<input id="x-val" type="password" autocomplete="off"></div><div class="row" style="display:flex;justify-content:flex-end"><button class="btn primary" id="x-add">Save secret</button></div></div>`;
        $("#x-add").onclick = async () => {
          const ok = await attempt(() => api("POST", "/api/secrets", { name: $("#x-name").value, description: $("#x-desc").value, value: $("#x-val").value }));
          if (ok) {
            await refreshState();
            draw();
          }
        };
        $$("[data-rm]", body).forEach(
          (b) =>
            (b.onclick = async () => {
              if (!confirm(`Remove ${b.dataset.rm}?`)) return;
              await attempt(() => api("DELETE", `/api/secrets/${b.dataset.rm}`));
              await refreshState();
              draw();
            }),
        );
        $$("[data-replace]", body).forEach(
          (b) =>
            (b.onclick = async () => {
              const v = prompt(`New value for ${b.dataset.replace}`);
              if (!v) return;
              await attempt(() => api("POST", "/api/secrets", { name: b.dataset.replace, value: v }));
              toast("Replaced");
            }),
        );
      };
      draw();
    } else if (t === "agents") {
      const url = `${location.origin}/mcp`;
      const tok = S.state.mcpToken;
      const claude = `claude mcp add --transport http cursor-bots ${url} --header "Authorization: Bearer ${tok}"`;
      const cursorJson = JSON.stringify({ mcpServers: { "cursor-bots": { url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2);
      body.innerHTML = `<p>Let agents outside this app (Claude Code, the Cursor IDE, Hermes, OpenClaw, any MCP client) work with your team. They get four tools: <code>list_bots</code>, <code>message_bot</code> (message a bot or #group as you and wait for the reply), <code>read_chat</code>, <code>create_bot</code>.</p>
        <div class="copy-field"><span>URL</span><code>${esc(url)}</code><button class="btn small" data-copytext="${esc(url)}">Copy</button></div>
        <div class="copy-field"><span>Header</span><code>Authorization: Bearer ${esc(tok)}</code><button class="btn small" data-copytext="Authorization: Bearer ${esc(tok)}">Copy</button></div>
        <div class="d-section"><h4>Claude Code</h4><div class="copy-field"><code>${esc(claude)}</code><button class="btn small" data-copytext="${esc(claude)}">Copy</button></div></div>
        <div class="d-section"><h4>Cursor IDE (.cursor/mcp.json in another project, not the bots' workspace)</h4><pre class="input mono" style="white-space:pre-wrap;margin:0">${esc(cursorJson)}</pre><div class="row"><button class="btn small" data-copytext="${esc(cursorJson)}">Copy</button></div></div>
        <div class="muted">Hermes, OpenClaw and other harnesses: add an HTTP (streamable) MCP server with the URL and header above. Keep the token private; it can message your bots as you.</div>`;
      $$("[data-copytext]", body).forEach(
        (b) =>
          (b.onclick = () => {
            navigator.clipboard?.writeText(b.dataset.copytext);
            toast("Copied");
          }),
      );
    } else if (t === "limits") {
      const L = s.limits;
      const f = (k, label) => `<div class="field">${label}<input type="number" min="1" data-limit="${k}" value="${L[k]}"></div>`;
      body.innerHTML = `<div class="grid2">${f("maxBotsAndGroups", "Max bots + groups")}${f("maxGroupSize", "Max bots per group")}${f("maxRoutinesPerBot", "Max routines per bot")}${f("routineHistory", "Run records kept per routine")}${f("minRoutineIntervalMinutes", "Minimum minutes between routine runs")}${f("maxChainDepth", "Max bot-to-bot hops per chain")}${f("maxChainRuns", "Max bot turns per chain")}${f("memoryCharsPerTurn", "Memory characters injected per turn")}</div>
        <div class="field">Pause routines after this many days without a message from you (0 = never)<input type="number" min="0" id="l-away" value="${s.absencePauseDays}"></div>
        <div class="row" style="display:flex;justify-content:flex-end"><button class="btn primary" id="l-save">Save</button></div>`;
      $("#l-save").onclick = () => save({ limits: Object.fromEntries($$("[data-limit]", body).map((x) => [x.dataset.limit, Number(x.value)])), absencePauseDays: Number($("#l-away").value) });
    } else {
      body.innerHTML = `<p>Cursor Bots is a self-hosted, Grok-Bot-style team of persistent agents running on the Cursor SDK.</p>
        <div class="list-row"><div class="grow"><div class="t">Home</div><div class="s">${esc(S.state.home)}</div></div></div>
        <div class="list-row"><div class="grow"><div class="t">Shared computer (workspace)</div><div class="s">${esc(S.state.workspace)}</div></div><button class="btn small" id="ab-files">Browse</button></div>
        <div class="muted">House rules for every bot live in <code>AGENTS.md</code> in the workspace. Shortcuts: <span class="kbd">⌘/Ctrl K</span> search, <span class="kbd">⌘/Ctrl N</span> new, <span class="kbd">Esc</span> close.</div>`;
      $("#ab-files").onclick = () => {
        m.close();
        openFiles("AGENTS.md");
      };
    }
  };
  $$(".tabs button", m.el).forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  show(tab);
}

const CONNECTOR_PRESETS = {
  browser: {
    description: "A real browser (Playwright). Each bot gets its own persistent browser profile (its own screen), so bots can browse at the same time and stay signed in. On a desktop the window is visible so you can take over for logins. First time: run `npx @playwright/mcp install-browser chrome-for-testing`.",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "${headless}", "--user-data-dir", "${workspace}/.browser/${bot.handle}"],
  },
  github: { description: "GitHub issues, PRs and repos.", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:GITHUB_TOKEN}" } },
  notion: { description: "Notion pages and databases.", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "${secret:NOTION_TOKEN}" } },
  fetch: { description: "Fetch web pages as Markdown.", command: "uvx", args: ["mcp-server-fetch"] },
  linear: { description: "Linear issues (remote MCP; sign in to it once in the Cursor app).", type: "http", url: "https://mcp.linear.app/mcp" },
};

function openConnectors() {
  const m = modal({ title: "Connect apps", body: "", wide: true });
  const body = $(".modal-body", m.el);
  const draw = () => {
    const list = S.state.connectors ?? {};
    body.innerHTML = `<div class="muted">Connectors are MCP servers your bots can use. They're account-wide; limit a bot to specific ones in its details. Put credentials in Settings → Secrets and reference them as <code>\${secret:NAME}</code>. Per-bot placeholders: <code>\${bot.handle}</code>, <code>\${workspace}</code>, <code>\${headless}</code>.</div>
      ${Object.entries(list).map(([n, c]) => `<div class="list-row"><div class="grow"><div class="t">${esc(n)}</div><div class="s">${esc(c.description || c.url || [c.command, ...(c.args ?? [])].join(" "))}</div></div>${switchHtml(`cn-${n}`, c.enabled)}<button class="btn small" data-edit="${esc(n)}">Edit</button><button class="btn small danger" data-del="${esc(n)}">Remove</button></div>`).join("") || '<div class="muted">Nothing connected yet.</div>'}
      <div class="d-section"><h4>Add an app</h4><div class="row" style="display:flex;gap:6px;flex-wrap:wrap">${Object.keys(CONNECTOR_PRESETS).map((k) => `<button class="btn small" data-preset="${k}">${k}</button>`).join("")}<button class="btn small" data-preset="">Custom…</button></div></div>`;
    Object.keys(list).forEach((n) => {
      // Read the live map: an earlier toggle in this modal already changed it.
      $(`#cn-${CSS.escape(n)}`, body).onchange = (e) => {
        const cur = S.state.connectors ?? {};
        saveConnectors({ ...cur, [n]: { ...cur[n], enabled: e.target.checked } });
      };
    });
    $$("[data-del]", body).forEach(
      (b) =>
        (b.onclick = () => {
          const next = { ...(S.state.connectors ?? {}) };
          delete next[b.dataset.del];
          saveConnectors(next).then(draw);
        }),
    );
    $$("[data-edit]", body).forEach((b) => (b.onclick = () => editConnector(b.dataset.edit, (S.state.connectors ?? {})[b.dataset.edit], draw)));
    $$("[data-preset]", body).forEach((b) => (b.onclick = () => editConnector(b.dataset.preset || "", b.dataset.preset ? { ...CONNECTOR_PRESETS[b.dataset.preset], enabled: true } : { enabled: true }, draw)));
  };
  draw();
}

async function saveConnectors(next) {
  const res = await attempt(() => api("PUT", "/api/connectors", next));
  if (res) S.state.connectors = res;
  renderSidebar();
  return res;
}

function editConnector(name, c, done) {
  const kv = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
  const m = modal({
    title: name ? `Connector: ${name}` : "Custom connector",
    body: `<div class="grid2"><div class="field">Name<input id="ce-name" value="${esc(name)}" ${name && S.state.connectors?.[name] ? "readonly" : ""}></div><div class="field">Type<select id="ce-type"><option value="stdio">stdio (command)</option><option value="http">http (URL)</option><option value="sse">sse (URL)</option></select></div></div>
      <div class="field">Description<input id="ce-desc" value="${esc(c.description ?? "")}"></div>
      <div class="field" id="ce-cmd-f">Command<input id="ce-cmd" value="${esc([c.command, ...(c.args ?? [])].filter(Boolean).join(" "))}" placeholder="npx -y some-mcp-server --flag"></div>
      <div class="field" id="ce-url-f">URL<input id="ce-url" value="${esc(c.url ?? "")}" placeholder="https://example.com/mcp"></div>
      <div class="field" id="ce-env-f">Environment (KEY=value per line; use \${secret:NAME})<textarea id="ce-env" class="mono" rows="3">${esc(kv(c.env))}</textarea></div>
      <div class="field" id="ce-hdr-f">Headers (Name=value per line)<textarea id="ce-hdr" class="mono" rows="3">${esc(kv(c.headers))}</textarea></div>`,
    foot: '<button class="btn primary" id="ce-save">Save</button>',
  });
  const type = $("#ce-type", m.el);
  type.value = c.type ?? (c.url ? "http" : "stdio");
  const sync = () => {
    const isUrl = type.value !== "stdio";
    $("#ce-cmd-f", m.el).hidden = isUrl;
    $("#ce-env-f", m.el).hidden = isUrl;
    $("#ce-url-f", m.el).hidden = !isUrl;
    $("#ce-hdr-f", m.el).hidden = !isUrl;
  };
  type.onchange = sync;
  sync();
  const parseKv = (t) => Object.fromEntries(t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]).filter(([k]) => k));
  $("#ce-save", m.el).onclick = async () => {
    const n = $("#ce-name", m.el).value.trim();
    if (!n) return toast("Give it a name", "error");
    const isUrl = type.value !== "stdio";
    const parts = $("#ce-cmd", m.el).value.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const cfg = {
      type: type.value,
      description: $("#ce-desc", m.el).value,
      enabled: c.enabled !== false,
      ...(isUrl ? { url: $("#ce-url", m.el).value.trim(), headers: parseKv($("#ce-hdr", m.el).value) } : { command: parts[0]?.replace(/^["']|["']$/g, ""), args: parts.slice(1).map((p) => p.replace(/^["']|["']$/g, "")), env: parseKv($("#ce-env", m.el).value) }),
    };
    const ok = await saveConnectors({ ...(S.state.connectors ?? {}), [n]: cfg });
    if (ok) {
      m.close();
      done?.();
    }
  };
}

function openSkills() {
  const m = modal({ title: "Skills", body: "", wide: true });
  const body = $(".modal-body", m.el);
  const draw = () => {
    const list = S.state.skills ?? [];
    body.innerHTML = `<div class="muted">Skills are reusable how-tos (Agent Skills: a folder with SKILL.md) in the workspace's <code>.cursor/skills/</code>. Every bot can use them; type <code>/</code> in the composer to reference one.</div>
      ${list.map((s) => `<div class="list-row"><div class="grow"><div class="t">/${esc(s.name)}${s.manualOnly ? ' <span class="pill">manual</span>' : ""}</div><div class="s">${esc(s.description)}${s.createdBy ? ` · by ${esc(s.createdBy)}` : ""}</div></div><button class="btn small" data-open="${esc(s.name)}">Open</button><button class="btn small danger" data-del="${esc(s.name)}">Delete</button></div>`).join("") || '<div class="muted">No skills yet. Finish a task with a bot, then ask it to “save the process as a skill called …”.</div>'}
      <div class="row" style="display:flex;justify-content:flex-end"><button class="btn" id="sk-new">New skill</button></div>`;
    $$("[data-open]", body).forEach((b) => (b.onclick = () => editSkill(b.dataset.open, draw)));
    $$("[data-del]", body).forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm(`Delete /${b.dataset.del}?`)) return;
          await attempt(() => api("DELETE", `/api/skills/${b.dataset.del}`));
          await refreshState();
          draw();
        }),
    );
    $("#sk-new").onclick = () => editSkill(null, draw);
  };
  draw();
}

async function editSkill(name, done) {
  let desc = "";
  let bodyText = "";
  let manual = false;
  if (name) {
    const s = await attempt(() => api("GET", `/api/skills/${name}`));
    if (!s) return;
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(s.content);
    desc = s.info.description;
    manual = s.info.manualOnly;
    bodyText = fm ? s.content.slice(fm[0].length).trim() : s.content;
  }
  const m = modal({
    title: name ? `/${name}` : "New skill",
    wide: true,
    body: `<div class="grid2"><div class="field">Name<input id="sk-name" value="${esc(name ?? "")}" ${name ? "readonly" : ""} placeholder="weekly-account-health"></div><div class="field">When to use it<input id="sk-desc" value="${esc(desc)}"></div></div>
      <label class="toggle-row" style="justify-content:flex-start;gap:8px"><input type="checkbox" id="sk-manual" ${manual ? "checked" : ""}> Only when invoked with /name</label>
      <div class="field">Instructions (Markdown): when to use, inputs and access, steps, validation, what to return, what needs approval<textarea id="sk-body" class="mono" rows="18">${esc(bodyText)}</textarea></div>`,
    foot: '<button class="btn primary" id="sk-save">Save</button>',
  });
  $("#sk-save", m.el).onclick = async () => {
    const n = $("#sk-name", m.el).value.trim();
    const ok = await attempt(() => api("PUT", `/api/skills/${encodeURIComponent(n)}`, { description: $("#sk-desc", m.el).value, body: $("#sk-body", m.el).value, manualOnly: $("#sk-manual", m.el).checked }));
    if (ok) {
      m.close();
      await refreshState();
      done?.();
    }
  };
}

function openFiles(initial) {
  const m = modal({ title: "Shared computer", wide: true, body: '<div class="muted" id="fx-path"></div><div class="files"><div class="file-list" id="fx-list"></div><div class="file-view" id="fx-view"><div class="muted">Pick a file. Everything here is shared by all your bots.</div></div></div>' });
  let cwd = "";
  const view = $("#fx-view", m.el);
  const open = async (rel) => {
    const res = await attempt(() => api("GET", `/api/files?path=${encodeURIComponent(rel)}`));
    if (!res) return;
    cwd = res.path;
    $("#fx-path", m.el).textContent = `workspace/${cwd}`;
    const up = cwd ? `<div data-up="1">⬆ ..</div>` : "";
    $("#fx-list", m.el).innerHTML = up + res.entries.map((e) => `<div data-name="${esc(e.name)}" data-dir="${e.dir ? 1 : ""}"><span>${e.dir ? "📁" : "📄"} ${esc(e.name)}</span><span class="muted">${e.dir ? "" : sizeLabel(e.size)}</span></div>`).join("");
    const upEl = $("[data-up]", m.el);
    if (upEl) upEl.onclick = () => open(cwd.split("/").slice(0, -1).join("/"));
    $$("[data-name]", m.el).forEach((d) => {
      d.onclick = () => {
        const p = cwd ? `${cwd}/${d.dataset.name}` : d.dataset.name;
        if (d.dataset.dir) return open(p);
        $$("[data-name]", m.el).forEach((x) => x.classList.toggle("sel", x === d));
        showFile(p);
      };
    });
  };
  const showFile = async (p) => {
    const url = fileUrl(p);
    const head = `<div class="row" style="display:flex;justify-content:space-between;gap:8px"><code>${esc(p)}</code><a class="btn small" href="${fileUrl(p, true)}">Download</a></div>`;
    if (/\.(png|jpe?g|gif|webp)$/i.test(p)) {
      view.innerHTML = head + `<img src="${url}" alt="">`;
      return;
    }
    if (/\.(mp4|webm|mov)$/i.test(p)) {
      view.innerHTML = head + `<video src="${url}" controls style="max-width:100%"></video>`;
      return;
    }
    const res = await fetch(url);
    const text = await res.text();
    const binary = /[\u0000-\u0008]/.test(text.slice(0, 2000));
    if (binary || text.length > 400_000) {
      view.innerHTML = head + '<div class="muted">Preview not available.</div>';
      return;
    }
    view.innerHTML = head + `<textarea class="input mono" id="fx-text">${esc(text)}</textarea><div class="row" style="display:flex;justify-content:flex-end"><button class="btn primary" id="fx-save">Save</button></div>`;
    $("#fx-save", m.el).onclick = async () => {
      const ok = await attempt(() => api("PUT", `/api/files/raw?path=${encodeURIComponent(p)}`, undefined, $("#fx-text", m.el).value));
      if (ok) toast("Saved");
    };
  };
  if (initial) {
    open(initial.split("/").slice(0, -1).join("/")).then(() => showFile(initial));
  } else open("");
}

function openSearch() {
  const m = modal({ title: "Search", body: '<input class="input search-input" id="q" placeholder="Search bots, groups and messages"><div id="q-res"></div>' });
  const input = $("#q", m.el);
  const res = $("#q-res", m.el);
  let items = [];
  let sel = 0;
  let timer;
  const draw = () => {
    res.innerHTML = items.map((it, i) => `<div class="search-result ${i === sel ? "sel" : ""}" data-i="${i}"><div class="where">${esc(it.where)}</div><div class="what">${esc(it.what)}</div></div>`).join("") || '<div class="muted" style="padding:10px">No results</div>';
    $$(".search-result", res).forEach((el) => (el.onclick = () => go(items[Number(el.dataset.i)])));
  };
  const go = (it) => {
    if (!it) return;
    m.close();
    openConv(it.convId, { highlight: it.msgId });
  };
  const run = async () => {
    const q = input.value.trim().toLowerCase();
    const local = convs()
      .filter((c) => convTitle(c).toLowerCase().includes(q) || (c.kind === "dm" && (bot(c.members[0])?.label ?? "").toLowerCase().includes(q)))
      .slice(0, 8)
      .map((c) => ({ where: c.kind === "group" ? "Group" : c.kind === "dm" ? "Bot" : "Thread", what: convTitle(c), convId: c.id }));
    items = local;
    sel = 0;
    draw();
    if (q.length < 2) return;
    const found = await api("GET", `/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
    items = [...local, ...found.map((r) => ({ where: `${r.conversation.title} · ${new Date(r.message.ts).toLocaleString()}`, what: r.message.text, convId: r.conversation.id, msgId: r.message.id }))];
    draw();
  };
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") sel = Math.min(items.length - 1, sel + 1);
    else if (e.key === "ArrowUp") sel = Math.max(0, sel - 1);
    else if (e.key === "Enter") return go(items[sel]);
    else return;
    e.preventDefault();
    draw();
  };
  run();
}

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

function askNotificationPermission() {
  if (!("Notification" in window)) return toast("This browser doesn't support notifications", "error");
  Notification.requestPermission().then((p) => toast(p === "granted" ? "Notifications on" : "Notifications blocked by the browser"));
}

function notify(m) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  if (m.author.kind !== "bot") return;
  const b = bot(m.author.id);
  if (!b?.notifications || b.hidden) return;
  const n = new Notification(b.name, { body: m.kind === "approval" ? `Needs your approval: ${m.text}` : m.text.slice(0, 180), tag: m.convId });
  n.onclick = () => {
    window.focus();
    openConv(m.convId);
  };
}

let sidebarFrame = 0;
function scheduleSidebar() {
  if (sidebarFrame) return;
  sidebarFrame = requestAnimationFrame(() => {
    sidebarFrame = 0;
    renderSidebar();
  });
}

function handleEvent(ev) {
  const st = S.state;
  if (!st) return;
  switch (ev.type) {
    case "bot.updated":
      upsert(st.bots, ev.bot);
      scheduleSidebar();
      if (conv(S.current)?.members.includes(ev.bot.id)) {
        renderDetails();
        renderHeader();
        // A DM is titled after its bot, so a rename changes the composer's hint too.
        const input = $("#c-input");
        if (input) input.placeholder = composerPlaceholder(conv(S.current));
      }
      break;
    case "bot.deleted":
      st.bots = st.bots.filter((b) => b.id !== ev.id);
      delete S.live[ev.id];
      scheduleSidebar();
      break;
    case "bot.status": {
      const b = bot(ev.botId);
      if (b) b.status = ev.status;
      scheduleSidebar();
      updateSendButton();
      if (conv(S.current)?.members.includes(ev.botId)) renderHeader();
      break;
    }
    case "conversation.updated": {
      const c = { ...ev.conversation };
      const prev = conv(c.id);
      if (c.id === S.current && document.visibilityState === "visible") {
        // You're looking at it: tell the server too, or the count comes back on reload and in other tabs.
        // Only when something new needs clearing: a card that's still waiting keeps attention on, and
        // asking again on every update would loop.
        if (c.unread || (c.attention && !prev?.attention)) api("POST", `/api/conversations/${c.id}/read`).catch(() => {});
        c.unread = 0;
        c.attention = false;
      }
      upsert(st.conversations, c);
      // A rename or member change shows in the open chat's header, composer and details (not every new message).
      const shape = (x) => JSON.stringify([x?.title, x?.members, x?.lead, x?.purpose]);
      if (c.id === S.current && shape(prev) !== shape(c)) {
        renderHeader();
        const input = $("#c-input");
        if (input) input.placeholder = composerPlaceholder(c);
        if (S.details) renderDetails();
      }
      scheduleSidebar();
      break;
    }
    case "conversation.deleted":
      st.conversations = st.conversations.filter((c) => c.id !== ev.id);
      if (S.current === ev.id) {
        S.current = null;
        S.details = false;
        renderMain();
        renderDetails();
      }
      scheduleSidebar();
      break;
    case "message.created":
      addMessage(ev.message);
      notify(ev.message);
      break;
    case "message.updated": {
      const list = S.messages[ev.message.convId];
      if (list) {
        const i = list.findIndex((m) => m.id === ev.message.id);
        if (i >= 0) list[i] = ev.message;
        if (ev.message.convId === S.current) renderTranscript();
      }
      break;
    }
    case "run.started":
      S.live[ev.botId] = { runId: ev.runId, convId: ev.convId, text: "", tools: new Map() };
      if (ev.convId === S.current) scheduleLive();
      break;
    case "run.delta": {
      const l = S.live[ev.botId];
      if (l && l.runId === ev.runId) {
        l.text += ev.text;
        if (ev.convId === S.current) scheduleLive();
      }
      break;
    }
    case "run.tool": {
      const l = S.live[ev.botId];
      if (l && l.runId === ev.runId) {
        l.tools.set(ev.item.callId, ev.item);
        if (ev.convId === S.current) scheduleLive();
      }
      break;
    }
    case "run.finished":
      if (S.live[ev.botId]?.runId === ev.runId) delete S.live[ev.botId];
      if (ev.convId === S.current) scheduleLive();
      break;
    case "approval.updated":
      upsert(st.approvals, ev.approval);
      if (ev.approval.convId === S.current) renderTranscript();
      if (S.details) renderDetails();
      break;
    case "secretRequest.updated":
      upsert(st.secretRequests, ev.request);
      if (ev.request.convId === S.current) renderTranscript();
      break;
    case "routine.updated":
      upsert(st.routines, ev.routine);
      if (S.details) renderDetails();
      break;
    case "routine.deleted":
      st.routines = st.routines.filter((r) => r.id !== ev.id);
      if (S.details) renderDetails();
      break;
    case "settings.updated":
      st.settings = ev.settings;
      scheduleSidebar();
      break;
    case "skills.updated":
    case "connectors.updated":
      refreshState();
      break;
    case "notice":
      toast(ev.text, ev.level === "error" ? "error" : "info");
      break;
  }
}

async function refreshState() {
  const snap = await api("GET", "/api/state").catch(() => null);
  if (snap) {
    S.state = snap;
    scheduleSidebar();
  }
  return snap;
}

function connectEvents() {
  const es = new EventSource("/api/events");
  let wasDown = false;
  es.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => {
    wasDown = true;
  };
  es.onopen = async () => {
    if (!wasDown) return;
    wasDown = false;
    // Catch up on anything missed while disconnected.
    await refreshState();
    for (const id of Object.keys(S.messages)) delete S.messages[id];
    S.live = {};
    if (S.current) openConv(S.current);
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function setTheme(t) {
  const theme = t || "dark";
  try {
    localStorage.setItem("theme", theme);
  } catch {}
  document.documentElement.dataset.theme = theme;
}

function savedTheme() {
  try {
    return localStorage.getItem("theme") || "dark";
  } catch {
    return "dark";
  }
}

function renderAll() {
  renderSidebar();
  renderMain();
  renderDetails();
}

async function boot() {
  setTheme(savedTheme());
  try {
    S.state = await api("GET", "/api/state");
  } catch (err) {
    if (/Unauthorized/.test(err.message)) {
      document.body.innerHTML = `<div class="empty"><h2>Open Cursor Bots from your terminal</h2><p>For safety the app needs its access token. Open the link that <code>cursor-bots start</code> printed (it ends in <code>?token=…</code>), or paste the token from <code>~/.cursor-bots/state/ui.token</code>.</p><div class="row"><input class="input" id="tok" placeholder="token" style="width:280px"><button class="btn primary" id="tok-go">Open</button></div></div>`;
      $("#tok-go").onclick = () => (location.href = `/?token=${encodeURIComponent($("#tok").value.trim())}`);
      return;
    }
    document.body.innerHTML = `<div class="empty"><h2>Can't reach Cursor Bots</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (location.search.includes("token=")) history.replaceState(null, "", location.pathname + location.hash);
  renderSidebar();
  const fromHash = /^#\/c\/(.+)$/.exec(location.hash)?.[1];
  if (fromHash && conv(fromHash)) await openConv(fromHash);
  else renderMain();
  connectEvents();
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openSearch();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.shiftKey) {
      e.preventDefault();
      openNewModal();
    } else if (e.key === "Escape") {
      $(".overlay:last-child")?.remove();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.current) markRead(S.current);
  });
}

boot();
