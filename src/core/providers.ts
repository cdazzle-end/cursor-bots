import type { ProviderConfig, ProviderModel, ToolMode } from "./types.ts";
import { slugify } from "./util.ts";

/**
 * Model providers with an OpenAI-compatible chat API. Each provider becomes a
 * "brain" (runtime) bots can run on. Presets fill in what each service needs;
 * everything stays editable in Settings → Brain & models → Providers.
 */

export interface ProviderPreset {
  key: string;
  label: string;
  baseUrl: string;
  /** Where to get a key (shown in the editor). */
  keyUrl?: string;
  /** Environment variable read once at startup when no key is stored. */
  keyEnv?: string;
  /** Local servers need no key. */
  needsKey: boolean;
  maxConcurrency: number;
  toolMode: ToolMode;
  maxTokensParam?: ProviderConfig["maxTokensParam"];
  defaultContextWindow?: number;
  headers?: Record<string, string>;
  models: ProviderModel[];
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "featherless",
    label: "Featherless AI",
    baseUrl: "https://api.featherless.ai/v1",
    keyUrl: "https://featherless.ai/account/api-keys",
    keyEnv: "FEATHERLESS_API_KEY",
    needsKey: true,
    // The $25 Chat plan has 4 concurrency units (a 32B model costs 2); Developer and pay-as-you-go have 100.
    maxConcurrency: 4,
    toolMode: "auto",
    defaultContextWindow: 32768,
    models: [{ id: "Qwen/Qwen3-32B", label: "Qwen3 32B", contextWindow: 32768, concurrencyCost: 2, toolMode: "native" }],
    note: "Native tool calling is documented for the Qwen 3 family and Kimi-K2; other models fall back to text tool calls. Set the concurrency to your plan's units.",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyEnv: "OPENROUTER_API_KEY",
    needsKey: true,
    maxConcurrency: 8,
    toolMode: "auto",
    headers: {},
    models: [],
  },
  {
    key: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyEnv: "XAI_API_KEY",
    needsKey: true,
    maxConcurrency: 8,
    toolMode: "native",
    maxTokensParam: "max_completion_tokens",
    models: [],
  },
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyEnv: "OPENAI_API_KEY",
    needsKey: true,
    maxConcurrency: 8,
    toolMode: "native",
    maxTokensParam: "max_completion_tokens",
    models: [],
  },
  {
    key: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyEnv: "GROQ_API_KEY",
    needsKey: true,
    maxConcurrency: 4,
    toolMode: "native",
    maxTokensParam: "max_completion_tokens",
    models: [],
  },
  {
    key: "together",
    label: "Together AI",
    baseUrl: "https://api.together.ai/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyEnv: "TOGETHER_API_KEY",
    needsKey: true,
    maxConcurrency: 4,
    toolMode: "auto",
    models: [],
  },
  {
    key: "deepinfra",
    label: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    keyUrl: "https://deepinfra.com/dash/api_keys",
    keyEnv: "DEEPINFRA_API_KEY",
    needsKey: true,
    maxConcurrency: 4,
    toolMode: "auto",
    models: [],
  },
  {
    key: "ollama",
    label: "Ollama (this computer)",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    maxConcurrency: 1,
    toolMode: "auto",
    defaultContextWindow: 8192,
    models: [],
    note: "Ollama's default context is small (4k–32k depending on memory); raise num_ctx for agent work.",
  },
  {
    key: "lmstudio",
    label: "LM Studio (this computer)",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    maxConcurrency: 1,
    toolMode: "auto",
    defaultContextWindow: 8192,
    models: [],
  },
  {
    key: "custom",
    label: "Other OpenAI-compatible API",
    baseUrl: "https://",
    needsKey: true,
    maxConcurrency: 2,
    toolMode: "auto",
    models: [],
  },
];

/** Runtime ids that aren't providers. */
export const RESERVED_RUNTIME_IDS = new Set(["cursor", "mock"]);

const TOOL_MODES = new Set<ToolMode>(["auto", "native", "prompt", "none"]);

/** Name of a provider's key in the provider-key vault. */
export function providerKeyName(id: string): string {
  return `PROVIDER_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`.slice(0, 64);
}

/** A local server (no key needed, http is fine). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"].includes(host) || host.endsWith(".local") || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function num(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${String(v)}`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanHeaders(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) throw new Error(`Bad header name: ${k}`);
    // The key goes in Authorization; don't let a header carry (or override) it.
    if (/^(authorization|x-api-key|api-key)$/i.test(k)) throw new Error(`Put the API key in the key field, not in the ${k} header.`);
    out[k] = String(val).slice(0, 500);
  }
  return Object.keys(out).length ? out : undefined;
}

export function cleanModel(m: any): ProviderModel {
  const id = String(m?.id ?? "").trim();
  if (!id || id.length > 200 || /\s/.test(id)) throw new Error(`Bad model id: ${JSON.stringify(m?.id)}`);
  const toolMode = m?.toolMode && TOOL_MODES.has(m.toolMode) ? (m.toolMode as ToolMode) : undefined;
  let extraBody: Record<string, unknown> | undefined;
  if (m?.extraBody !== undefined && m.extraBody !== null && m.extraBody !== "") {
    const v = typeof m.extraBody === "string" ? JSON.parse(m.extraBody) : m.extraBody;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`Extra request fields for ${id} must be a JSON object.`);
    // The model, messages, tools and streaming are the runtime's business.
    for (const k of ["model", "messages", "tools", "stream", "tool_choice"]) delete (v as Record<string, unknown>)[k];
    extraBody = Object.keys(v).length ? (v as Record<string, unknown>) : undefined;
  }
  return {
    id,
    label: m?.label ? String(m.label).slice(0, 80) : undefined,
    contextWindow: num(m?.contextWindow, 1024, 10_000_000),
    maxOutputTokens: num(m?.maxOutputTokens, 64, 1_000_000),
    vision: m?.vision === undefined ? undefined : Boolean(m.vision),
    toolMode,
    concurrencyCost: num(m?.concurrencyCost, 1, 1000),
    extraBody,
  };
}

/**
 * Validate and normalize a provider from the API. `existing` is the stored
 * version when updating (its id and creation time are kept).
 */
export function cleanProvider(input: any, existing: ProviderConfig | undefined, taken: Set<string>): ProviderConfig {
  const now = Date.now();
  const label = String(input?.label ?? existing?.label ?? "").trim().slice(0, 60);
  if (!label) throw new Error("A provider needs a name.");
  let id = existing?.id;
  if (!id) {
    const base = slugify(String(input?.id || label)).slice(0, 32) || "provider";
    id = base;
    for (let i = 2; taken.has(id) || RESERVED_RUNTIME_IDS.has(id); i++) id = `${base}-${i}`;
  }
  const baseUrl = String(input?.baseUrl ?? existing?.baseUrl ?? "").trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("The base URL must be a full URL, e.g. https://api.featherless.ai/v1");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("The base URL must start with https:// (or http:// for a local server).");
  if (parsed.username || parsed.password) throw new Error("Don't put credentials in the base URL; use the API key field.");
  const models = Array.isArray(input?.models) ? input.models.map(cleanModel) : existing?.models ?? [];
  const ids = new Set<string>();
  for (const m of models) {
    if (ids.has(m.id)) throw new Error(`Model ${m.id} is listed twice.`);
    ids.add(m.id);
  }
  const pick = (v: unknown, fallback: string | undefined) => {
    const s = v === undefined ? fallback : String(v ?? "").trim();
    return s ? s : undefined;
  };
  const toolMode = TOOL_MODES.has(input?.toolMode) ? (input.toolMode as ToolMode) : existing?.toolMode ?? "auto";
  const maxTokensParam =
    input?.maxTokensParam === "max_completion_tokens" || input?.maxTokensParam === "max_tokens"
      ? input.maxTokensParam
      : input?.maxTokensParam === null
        ? undefined
        : existing?.maxTokensParam;
  return {
    id,
    label,
    baseUrl,
    enabled: input?.enabled === undefined ? existing?.enabled ?? true : Boolean(input.enabled),
    maxConcurrency: num(input?.maxConcurrency, 1, 1000) ?? existing?.maxConcurrency ?? 2,
    toolMode,
    maxTokensParam,
    headers: input?.headers === undefined ? existing?.headers : cleanHeaders(input.headers),
    defaultModel: pick(input?.defaultModel, existing?.defaultModel),
    routerModel: pick(input?.routerModel, existing?.routerModel),
    defaultContextWindow: input?.defaultContextWindow === undefined ? existing?.defaultContextWindow : num(input.defaultContextWindow, 1024, 10_000_000),
    keyEnv:
      input?.keyEnv === undefined
        ? existing?.keyEnv
        : input.keyEnv && /^[A-Z_][A-Z0-9_]{0,63}$/.test(String(input.keyEnv)) && !String(input.keyEnv).startsWith("CURSOR_")
          ? String(input.keyEnv)
          : undefined,
    models,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** A new provider from a preset (the caller still validates it with cleanProvider). */
export function fromPreset(key: string): Partial<ProviderConfig> {
  const p = PROVIDER_PRESETS.find((x) => x.key === key);
  if (!p) throw new Error(`Unknown provider preset: ${key}`);
  return {
    id: p.key === "custom" ? undefined : p.key,
    label: p.label,
    baseUrl: p.baseUrl,
    maxConcurrency: p.maxConcurrency,
    toolMode: p.toolMode,
    maxTokensParam: p.maxTokensParam,
    defaultContextWindow: p.defaultContextWindow,
    headers: p.headers && Object.keys(p.headers).length ? p.headers : undefined,
    keyEnv: p.keyEnv,
    models: p.models.map((m) => ({ ...m })),
    defaultModel: p.models[0]?.id,
  };
}
