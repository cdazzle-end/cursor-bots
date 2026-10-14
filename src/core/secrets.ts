import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { SecretMeta } from "./types.ts";
import { readJson, writeFileAtomic, writeJson } from "./util.ts";

/**
 * Write-only secret storage, modelled on Grok Bot's "secure secret card":
 * values are encrypted at rest (AES-256-GCM, key in state/secret.key, mode
 * 0600), are never put in a prompt, and are only injected as environment
 * variables into commands a bot runs through `run_with_secrets` or into MCP
 * connector configs (`${secret:NAME}`). Output is scrubbed of the values.
 */
export class SecretVault {
  private keyFile: string;
  private vaultFile: string;
  private metaFile: string;
  private meta: Record<string, SecretMeta>;

  constructor(paths: { secretKey: string; secretsVault: string; secretsMeta: string }) {
    this.keyFile = paths.secretKey;
    this.vaultFile = paths.secretsVault;
    this.metaFile = paths.secretsMeta;
    this.meta = readJson<Record<string, SecretMeta>>(this.metaFile, {});
  }

  static validName(name: string): boolean {
    return /^[A-Z_][A-Z0-9_]{0,63}$/.test(name) && !name.startsWith("CURSOR_");
  }

  private key(): Buffer {
    if (!fs.existsSync(this.keyFile)) {
      writeFileAtomic(this.keyFile, randomBytes(32).toString("base64"));
      fs.chmodSync(this.keyFile, 0o600);
    }
    return Buffer.from(fs.readFileSync(this.keyFile, "utf8").trim(), "base64");
  }

  private readAll(): Record<string, string> {
    if (!fs.existsSync(this.vaultFile)) return {};
    const blob = Buffer.from(fs.readFileSync(this.vaultFile, "utf8"), "base64");
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const data = blob.subarray(28);
    const d = createDecipheriv("aes-256-gcm", this.key(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
  }

  private writeAll(values: Record<string, string>): void {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(values), "utf8"), c.final()]);
    writeFileAtomic(this.vaultFile, Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"));
    fs.chmodSync(this.vaultFile, 0o600);
  }

  list(): SecretMeta[] {
    return Object.values(this.meta).sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return Boolean(this.meta[name]);
  }

  set(name: string, value: string, description?: string): SecretMeta {
    if (!SecretVault.validName(name)) throw new Error("Secret names are UPPER_SNAKE_CASE and can't start with CURSOR_.");
    const values = this.readAll();
    values[name] = value;
    this.writeAll(values);
    const now = Date.now();
    const prev = this.meta[name];
    this.meta[name] = { name, description: description ?? prev?.description, createdAt: prev?.createdAt ?? now, updatedAt: now };
    writeJson(this.metaFile, this.meta);
    return this.meta[name]!;
  }

  remove(name: string): boolean {
    if (!this.meta[name]) return false;
    const values = this.readAll();
    delete values[name];
    this.writeAll(values);
    delete this.meta[name];
    writeJson(this.metaFile, this.meta);
    return true;
  }

  /** Only for injecting into child processes. Never return these to a model. */
  resolve(names: string[]): Record<string, string> {
    const values = this.readAll();
    const out: Record<string, string> = {};
    for (const n of names) if (values[n] !== undefined) out[n] = values[n]!;
    return out;
  }

  /** Replace ${secret:NAME} placeholders (used in connector configs). */
  expand(text: string): string {
    if (!text.includes("${secret:")) return text;
    const values = this.readAll();
    return text.replace(/\$\{secret:([A-Z0-9_]+)\}/g, (_, n: string) => values[n] ?? "");
  }

  scrub(text: string, names?: string[]): string {
    const values = this.readAll();
    let out = text;
    for (const [n, v] of Object.entries(values)) {
      if (names && !names.includes(n)) continue;
      if (v && v.length >= 4) out = out.split(v).join(`[secret:${n}]`);
    }
    return out;
  }
}
