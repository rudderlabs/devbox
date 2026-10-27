import { logger } from "../logger";
import type { ApiTokenRepository } from "../repositories/apiToken.repository";
import type { Principal } from "./apiTask.service";

// Token format: dbx_<api_tokens.id>_<secret>, the secret being 32
// random bytes as base64url (43 chars, no padding). Base64url secrets contain
// '_' and '-', so the token is parsed with a strict regex, never split("_").
// A malformed token is rejected before any DB access.
const TOKEN_RE =
  /^dbx_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const BEARER_RE = /^Bearer\s+(\S+)$/i;
const TOUCH_INTERVAL_MS = 60_000;

export function generateApiTokenSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function formatApiToken(id: string, secret: string): string {
  return `dbx_${id}_${secret}`;
}

export function parseApiToken(token: string): { id: string; secret: string } | null {
  const m = TOKEN_RE.exec(token);
  return m?.[1] && m[2] ? { id: m[1], secret: m[2] } : null;
}

export function hashApiTokenSecret(secret: string): Promise<string> {
  return Bun.password.hash(secret, "argon2id");
}

// Verifies the bearer token on every request (no cache). Any failure is null,
// and the middleware turns every null into the same 401.
export class ApiAuthService {
  // tokenId → when this pod last wrote last_used_at.
  private lastTouched = new Map<string, number>();

  constructor(
    private repo: Pick<ApiTokenRepository, "findActiveById" | "touchLastUsed">,
    private now: () => number = Date.now,
  ) {}

  async authenticate(authorization: string | undefined): Promise<Principal | null> {
    const bearer = BEARER_RE.exec(authorization ?? "")?.[1];
    const parsed = bearer ? parseApiToken(bearer) : null;
    if (!parsed) return null;
    const row = await this.repo.findActiveById(parsed.id);
    if (!row) return null;
    const ok = await Bun.password.verify(parsed.secret, row.secretHash).catch(() => false);
    if (!ok) return null;
    this.touch(row.id);
    return { tokenId: row.id, name: row.name };
  }

  // Fire-and-forget, at most once a minute per token per pod.
  private touch(tokenId: string): void {
    const t = this.now();
    const last = this.lastTouched.get(tokenId);
    if (last !== undefined && t - last < TOUCH_INTERVAL_MS) return;
    this.lastTouched.set(tokenId, t);
    void this.repo.touchLastUsed(tokenId).catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn("api token last_used_at update failed", {
        // Not "tokenId": the logger redacts keys matching /token/i.
        apiKeyId: tokenId,
        message: e.message,
        stack: e.stack,
      });
    });
  }
}
