import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db";
import type { ApiToken } from "../db/schema";

export class ApiTokenRepository {
  async create(p: {
    name: string;
    secretHash: string;
    githubLogin: string | null;
  }): Promise<{ id: string }> {
    const [row] = await db
      .insert(schema.apiTokens)
      .values({ name: p.name, secretHash: p.secretHash, githubLogin: p.githubLogin })
      .returning({ id: schema.apiTokens.id });
    if (!row) throw new Error("api_tokens insert returned no row");
    return row;
  }

  async findByName(name: string): Promise<ApiToken | null> {
    const [row] = await db
      .select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.name, name))
      .limit(1);
    return row ?? null;
  }

  // Revoked tokens are invisible to auth.
  async findActiveById(
    id: string,
  ): Promise<{ id: string; name: string; secretHash: string } | null> {
    const [row] = await db
      .select({
        id: schema.apiTokens.id,
        name: schema.apiTokens.name,
        secretHash: schema.apiTokens.secretHash,
      })
      .from(schema.apiTokens)
      .where(and(eq(schema.apiTokens.id, id), isNull(schema.apiTokens.revokedAt)))
      .limit(1);
    return row ?? null;
  }

  async list(): Promise<ApiToken[]> {
    return db.select().from(schema.apiTokens).orderBy(schema.apiTokens.createdAt);
  }

  async revokeByName(name: string): Promise<boolean> {
    const rows = await db
      .update(schema.apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(schema.apiTokens.name, name), isNull(schema.apiTokens.revokedAt)))
      .returning({ id: schema.apiTokens.id });
    return rows.length > 0;
  }

  async touchLastUsed(id: string): Promise<void> {
    await db
      .update(schema.apiTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(schema.apiTokens.id, id));
  }
}

export const apiTokenRepository = new ApiTokenRepository();
