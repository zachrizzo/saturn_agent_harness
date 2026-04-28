import { createHmac, timingSafeEqual } from "node:crypto";
import os from "node:os";

const SECRET_ENV = "MCP_SECRET";
const MIN_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getSecret(): string {
  const fromEnv = process.env[SECRET_ENV];
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${SECRET_ENV} must be set in production`);
  }
  return `local-dev-${os.hostname()}`;
}

export function mintToken(sessionId: string, wallclockSeconds?: number): string {
  const desired = wallclockSeconds ? wallclockSeconds * 1000 : MIN_TTL_MS;
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, desired));
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
