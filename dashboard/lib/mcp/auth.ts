import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SECRET_ENV = "MCP_SECRET";
const SECRET_FILE = ".mcp-secret";
const MIN_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getSecret(): string {
  const fromEnv = process.env[SECRET_ENV];
  if (fromEnv) return fromEnv;
  const root = process.env.AUTOMATIONS_ROOT;
  if (root) {
    const secretPath = path.join(root, SECRET_FILE);
    try {
      const existing = fs.readFileSync(secretPath, "utf8").trim();
      if (existing) return existing;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const generated = randomBytes(32).toString("base64url");
    fs.writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
    return generated;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${SECRET_ENV} must be set in production`);
  }
  return `local-dev-${os.hostname()}`;
}

export function mintToken(sessionId: string): string {
  const ttl = MAX_TTL_MS;
  const expiry = Date.now() + ttl;
  const payload = `${sessionId}.${expiry}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifyToken(token: string, sessionId: string): boolean {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length < 3) return false;
    const sig = parts.pop()!;
    const expiry = Number(parts[parts.length - 1]);
    if (parts[0] !== sessionId) return false;
    if (Date.now() > expiry) return false;
    const expected = createHmac("sha256", getSecret()).update(parts.join(".")).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
