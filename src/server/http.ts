import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness, BotTemplate } from "../core/harness.ts";
import { createStarterTeam } from "../core/starter.ts";
import type { ConnectorConfig } from "../core/types.ts";
import { mimeFor, resolveInside } from "../core/util.ts";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const MAX_JSON = 2 * 1024 * 1024;
const MAX_UPLOAD = 200 * 1024 * 1024;

export interface ServerOptions {
  port: number;
  host: string;
  /** Required on every API call when set (always set when listening beyond localhost). */
  token?: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<any>;
  raw: (limit: number) => Promise<Buffer>;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createServer(h: Harness, opts: ServerOptions): http.Server {
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler; public?: boolean }> = [];
  const route = (method: string, p: string, handler: Handler, isPublic = false) => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + p.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, pattern, keys, handler, public: isPublic });
  };

  // ----------------------------------------------------------------- state & events

  route("GET", "/api/state", () => h.snapshot());

  route("GET", "/api/events", ({ req, res }) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const off = h.bus.on((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(beat);
    });
    return KEEP_OPEN;
  });

  route("GET", "/api/models", async () => {
    const rt = h.runtimes.get(h.store.settings.runtime);
    if (!rt?.listModels || !rt.available().ok) return { models: [], runtime: rt?.id };
    try {
      return { models: await rt.listModels(), runtime: rt.id };
    } catch (err: any) {
      return { models: [], runtime: rt.id, error: String(err?.message ?? err) };
    }
  });

  route("GET", "/api/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return h.search(q, { limit: 60 }).map((r) => ({
      conversation: { id: r.conversation.id, kind: r.conversation.kind, title: h.conversationTitle(r.conversation) },
      message: r.message,
    }));
  });

  // ----------------------------------------------------------------- bots

  route("POST", "/api/bots", async ({ body }) => h.describeBot(h.createBot(await body())));
  route("PATCH", "/api/bots/:id", async ({ params, body }) => h.describeBot(h.updateBot(params.id!, await body())));
  route("DELETE", "/api/bots/:id", async ({ params }) => {
    await h.deleteBot(params.id!);
    return { ok: true };
  });
  route("POST", "/api/bots/:id/duplicate", ({ params }) => h.describeBot(h.duplicateBot(params.id!)));
  route("GET", "/api/bots/:id/export", ({ params }) => h.exportBot(params.id!));
  route("POST", "/api/bots/import", async ({ body }) => h.describeBot(h.importBot((await body()) as BotTemplate)));
  route("GET", "/api/bots/:id/memory", ({ params }) => {
    if (!h.store.bots.has(params.id!)) throw new HttpError(404, "No such bot");
    return { content: h.store.readMemory(params.id!) };
  });
  route("PUT", "/api/bots/:id/memory", async ({ params, body }) => {
    const bot = h.store.bots.get(params.id!);
    if (!bot) throw new HttpError(404, "No such bot");
    h.store.writeMemory(bot.id, String((await body()).content ?? ""));
    h.bus.emit({ type: "bot.updated", bot: h.describeBot(bot) });
    return { ok: true };
  });
  route("POST", "/api/bots/:id/stop", async ({ params }) => ({ stopped: await h.stopBot(params.id!) }));
  route("POST", "/api/onboarding/starter", () => {
    createStarterTeam(h);
    return h.snapshot();
  });

  // ----------------------------------------------------------------- conversations

  route("POST", "/api/conversations", async ({ body }) => h.createGroup(await body()));
  route("PATCH", "/api/conversations/:id", async ({ params, body }) => h.updateConversation(params.id!, await body()));
  route("DELETE", "/api/conversations/:id", ({ params }) => {
    h.deleteConversation(params.id!);
    return { ok: true };
  });
  route("GET", "/api/conversations/:id/messages", ({ params, url }) => {
    if (!h.store.conversations.has(params.id!)) throw new HttpError(404, "No such conversation");
    const before = Number(url.searchParams.get("before")) || Infinity;
    const limit = Math.min(500, Number(url.searchParams.get("limit")) || 150);
    const all = h.store.messages(params.id!).filter((m) => m.ts < before);
    return { messages: all.slice(-limit), more: all.length > limit };
  });
  route("POST", "/api/conversations/:id/messages", async ({ params, body }) => {
    const b = await body();
    const attachments = (Array.isArray(b.attachments) ? b.attachments : []).map((p: unknown) => h.attachmentFor(String(typeof p === "object" && p ? (p as any).path : p)));
    return h.postUserMessage(params.id!, { text: String(b.text ?? ""), attachments, replyTo: b.replyTo ? String(b.replyTo) : undefined });
  });
  route("POST", "/api/conversations/:id/read", ({ params }) => {
    h.markRead(params.id!);
    return { ok: true };
  });
  route("POST", "/api/conversations/:id/stop", async ({ params }) => ({ stopped: await h.stopConversation(params.id!) }));

  // ----------------------------------------------------------------- files

  route("POST", "/api/uploads", async ({ url, raw }) => {
    const name = url.searchParams.get("name") || "upload";
    const data = await raw(MAX_UPLOAD);
    const isVideo = /^video\//.test(mimeFor(name));
    if (!isVideo && data.length > 25 * 1024 * 1024) throw new HttpError(413, "Documents, images and audio can be at most 25 MB.");
    return h.saveUpload(name, data);
  });
  route("GET", "/api/files", ({ url }) => {
    const rel = url.searchParams.get("path") ?? "";
    const abs = resolveInside(h.store.paths.workspace, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
      const st = fs.statSync(path.join(abs, e.name));
      return { name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtimeMs };
    });
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path: path.relative(h.store.paths.workspace, abs), entries };
  });
  route("GET", "/api/files/raw", ({ url, res }) => {
    const abs = resolveInside(h.store.paths.workspace, url.searchParams.get("path") ?? "");
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new HttpError(400, "Not a file");
    const mime = mimeFor(abs);
    // Serve HTML and SVG as plain text so a file a bot wrote can't script this app.
    const safe = /^(text\/html|image\/svg)/.test(mime) ? "text/plain; charset=utf-8" : mime;
    res.writeHead(200, {
      "content-type": safe,
      "content-length": st.size,
      "content-disposition": `${url.searchParams.get("download") ? "attachment" : "inline"}; filename="${path.basename(abs).replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    fs.createReadStream(abs).pipe(res);
    return KEEP_OPEN;
  });
  route("PUT", "/api/files/raw", async ({ url, raw }) => {
    const abs = resolveInside(h.store.paths.workspace, url.searchParams.get("path") ?? "");
    const data = await raw(MAX_JSON * 5);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    return { ok: true };
  });

  // ----------------------------------------------------------------- routines

  route("PATCH", "/api/routines/:id", async ({ params, body }) => h.scheduler.describe(h.scheduler.update(params.id!, await body())));
  route("DELETE", "/api/routines/:id", ({ params }) => ({ ok: h.scheduler.delete(params.id!) }));
  route("POST", "/api/routines/:id/test", async ({ params }) => {
    const run = await h.scheduler.fire(params.id!, "test");
    if (!run) throw new HttpError(404, "No such routine");
    return run;
  });
  // Webhook trigger: authenticated by the routine's own key, not the app token.
  route(
    "POST",
    "/api/webhooks/routines/:id",
    async ({ params, req, raw }) => {
      const r = h.store.routines.get(params.id!);
      const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!r || !r.webhookKey || key !== r.webhookKey) throw new HttpError(401, "Invalid routine or key");
      if (!r.enabled) throw new HttpError(409, "Routine is paused");
      const data = await raw(MAX_JSON);
      let payload: unknown = undefined;
      if (data.length) {
        try {
          payload = JSON.parse(data.toString("utf8"));
        } catch {
          payload = data.toString("utf8").slice(0, 8000);
        }
      }
      const run = await h.scheduler.fire(r.id, "webhook", payload);
      return { accepted: true, runId: run?.id };
    },
    true,
  );

  // ----------------------------------------------------------------- approvals & secrets

  route("POST", "/api/approvals/:id", async ({ params, body }) => {
    const d = String((await body()).decision);
    if (!["once", "always", "deny"].includes(d)) throw new HttpError(400, "decision must be once, always or deny");
    return h.decideApproval(params.id!, d as "once" | "always" | "deny");
  });
  route("POST", "/api/secret-requests/:id", async ({ params, body }) => {
    const b = await body();
    if (b.dismiss) return h.dismissSecret(params.id!);
    if (typeof b.value !== "string" || !b.value) throw new HttpError(400, "value required");
    return h.fulfillSecret(params.id!, b.value);
  });
  route("POST", "/api/secrets", async ({ body }) => {
    const b = await body();
    return h.vault.set(String(b.name ?? "").trim().toUpperCase(), String(b.value ?? ""), b.description ? String(b.description) : undefined);
  });
  route("DELETE", "/api/secrets/:name", ({ params }) => ({ ok: h.vault.remove(params.name!) }));

  // ----------------------------------------------------------------- skills, settings, connectors

  route("GET", "/api/skills/:name", ({ params }) => {
    const s = h.skills.read(params.name!);
    if (!s) throw new HttpError(404, "No such skill");
    return s;
  });
  route("PUT", "/api/skills/:name", async ({ params, body }) => {
    const b = await body();
    const info = h.skills.save({ name: params.name!, description: String(b.description ?? ""), body: String(b.body ?? ""), manualOnly: b.manualOnly === true, createdBy: "user" });
    h.bus.emit({ type: "skills.updated" });
    return info;
  });
  route("DELETE", "/api/skills/:name", ({ params }) => {
    const ok = h.skills.delete(params.name!);
    h.bus.emit({ type: "skills.updated" });
    return { ok };
  });
  route("PATCH", "/api/settings", async ({ body }) => h.updateSettings(await body()));
  route("PUT", "/api/connectors", async ({ body }) => {
    const incoming = (await body()) as Record<string, ConnectorConfig>;
    const prev = h.store.connectors;
    const next: Record<string, ConnectorConfig> = {};
    for (const [name, c] of Object.entries(incoming ?? {})) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new HttpError(400, `Bad connector name: ${name}`);
      if (!c.url && !c.command) throw new HttpError(400, `Connector ${name} needs a url or a command`);
      // Masked values ("•••") from the UI keep what was stored.
      const keep = (cur: Record<string, string> | undefined, old: Record<string, string> | undefined) =>
        cur ? Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, v === "•••" ? (old?.[k] ?? "") : v])) : undefined;
      next[name] = {
        type: c.type,
        command: c.command || undefined,
        args: Array.isArray(c.args) ? c.args.map(String) : undefined,
        env: keep(c.env, prev[name]?.env),
        url: c.url || undefined,
        headers: keep(c.headers, prev[name]?.headers),
        description: c.description,
        enabled: c.enabled !== false,
      };
    }
    h.store.connectors = next;
    h.store.saveConnectors();
    h.bus.emit({ type: "connectors.updated" });
    return h.snapshot().connectors;
  });

  // ----------------------------------------------------------------- Cursor hook gate

  route(
    "POST",
    "/api/gate/shell",
    async ({ req, body }) => {
      if (req.headers["x-gate-token"] !== h.gateToken) throw new HttpError(401, "bad gate token");
      return h.gateShell(await body());
    },
    true,
  );

  route(
    "POST",
    "/api/gate/prompt",
    async ({ req, body }) => {
      if (req.headers["x-gate-token"] !== h.gateToken) throw new HttpError(401, "bad gate token");
      const b = await body();
      return h.learnHookSession(b.conversation_id, b.prompt);
    },
    true,
  );

  // ----------------------------------------------------------------- server

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (!opts.token) return true;
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (bearer === opts.token) return true;
    if (url.searchParams.get("token") === opts.token) return true;
    const cookie = /(?:^|;\s*)cb_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return cookie === opts.token;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const method = req.method ?? "GET";
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          if (!r.public && !authorized(req, url)) throw new HttpError(401, "Unauthorized");
          // Cross-site requests can't drive the API even on localhost.
          if (method !== "GET" && !r.public) {
            const origin = req.headers.origin;
            if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-origin request refused");
          }
          const params: Record<string, string> = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
          const ctx: Ctx = {
            req,
            res,
            url,
            params,
            raw: (limit) => readBody(req, limit),
            body: async () => {
              const buf = await readBody(req, MAX_JSON);
              if (!buf.length) return {};
              try {
                return JSON.parse(buf.toString("utf8"));
              } catch {
                throw new HttpError(400, "Invalid JSON");
              }
            },
          };
          const out = await r.handler(ctx);
          if (out === KEEP_OPEN) return;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(out ?? {}));
          return;
        }
        throw new HttpError(404, "Not found");
      }
      serveStatic(req, res, url, opts.token && url.searchParams.get("token") === opts.token ? opts.token : undefined);
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : err?.code === "ENOENT" ? 404 : 400;
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
}

const KEEP_OPEN = Symbol("keep-open");

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL, setToken?: string): void {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const abs = path.resolve(WEB_ROOT, "." + rel);
  if (!abs.startsWith(WEB_ROOT + path.sep) || !fs.existsSync(abs)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  const headers: Record<string, string> = {
    "content-type": mimeFor(abs) + (/(text|javascript|json)/.test(mimeFor(abs)) ? "; charset=utf-8" : ""),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  };
  if (setToken) headers["set-cookie"] = `cb_token=${setToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
  res.writeHead(200, headers);
  if (req.method === "HEAD") return void res.end();
  fs.createReadStream(abs).pipe(res);
}
