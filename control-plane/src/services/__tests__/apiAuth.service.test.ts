import { beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "../../logger";
import {
  ApiAuthService,
  formatApiToken,
  generateApiTokenSecret,
  hashApiTokenSecret,
  parseApiToken,
} from "../apiAuth.service";

const ID = "0192f000-0000-7000-8000-000000000001";
// 43 base64url characters, including both '_' and '-'.
const SECRET = "ab_cd-EF_gh-ij_kl-mn_op-qr_st-uv_wx-yz_0123";

describe("token format", () => {
  it("generates 43-character base64url secrets", () => {
    expect(generateApiTokenSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("parses a secret that contains _ and -", () => {
    expect(parseApiToken(formatApiToken(ID, SECRET))).toEqual({ id: ID, secret: SECRET });
  });

  it.each([
    "",
    `dbx_${ID}`,
    `dbx_${ID}_short`,
    `dbx_not-a-uuid_${SECRET}`,
    `xyz_${ID}_${SECRET}`,
    `dbx_${ID}_${SECRET}x`,
  ])("rejects %p", (token) => {
    expect(parseApiToken(token)).toBeNull();
  });
});

describe("ApiAuthService", () => {
  let hash: string;
  beforeAll(async () => {
    hash = await hashApiTokenSecret(SECRET);
  });

  const service = (row: { id: string; name: string; secretHash: string } | null, now = () => 0) => {
    const repo = {
      findActiveById: mock(() => Promise.resolve(row)),
      touchLastUsed: mock((_id: string) => Promise.resolve()),
    };
    return { repo, auth: new ApiAuthService(repo, now) };
  };

  it("argon2id round trip: a valid bearer token yields the principal", async () => {
    expect(hash.startsWith("$argon2id$")).toBe(true);
    const { auth } = service({ id: ID, name: "frodo", secretHash: hash });
    expect(await auth.authenticate(`Bearer ${formatApiToken(ID, SECRET)}`)).toEqual({
      tokenId: ID,
      name: "frodo",
    });
  });

  it("returns null for a missing header, a malformed token, an unknown or revoked id, or a wrong secret", async () => {
    const ok = { id: ID, name: "frodo", secretHash: hash };
    const wrongSecret = formatApiToken(ID, "X".repeat(43));
    expect(await service(ok).auth.authenticate(undefined)).toBeNull();
    expect(await service(ok).auth.authenticate("Bearer nope")).toBeNull();
    expect(await service(ok).auth.authenticate(`Basic ${formatApiToken(ID, SECRET)}`)).toBeNull();
    expect(
      await service(null).auth.authenticate(`Bearer ${formatApiToken(ID, SECRET)}`),
    ).toBeNull();
    expect(await service(ok).auth.authenticate(`Bearer ${wrongSecret}`)).toBeNull();
    expect(
      await service({ ...ok, secretHash: "garbage" }).auth.authenticate(
        `Bearer ${formatApiToken(ID, SECRET)}`,
      ),
    ).toBeNull();
  });

  it("never queries the DB for a malformed token", async () => {
    const { repo, auth } = service({ id: ID, name: "frodo", secretHash: hash });
    await auth.authenticate("Bearer dbx_xyz");
    expect(repo.findActiveById).not.toHaveBeenCalled();
  });

  it("updates last_used_at at most once a minute per token", async () => {
    let t = 0;
    const { repo, auth } = service({ id: ID, name: "frodo", secretHash: hash }, () => t);
    const header = `Bearer ${formatApiToken(ID, SECRET)}`;
    await auth.authenticate(header);
    t = 59_999;
    await auth.authenticate(header);
    t = 60_000;
    await auth.authenticate(header);
    expect(repo.touchLastUsed.mock.calls).toEqual([[ID], [ID]]);
  });

  it("a failed last_used_at update logs apiKeyId (a /token/i key would be redacted)", async () => {
    const { repo, auth } = service({ id: ID, name: "frodo", secretHash: hash });
    const err = new Error("db down");
    repo.touchLastUsed.mockRejectedValueOnce(err);
    const warn = spyOn(logger, "warn").mockImplementation(() => logger);
    // Another file's mock.module stub of the logger may be shared here.
    warn.mockClear();
    try {
      await auth.authenticate(`Bearer ${formatApiToken(ID, SECRET)}`);
      await new Promise((r) => setTimeout(r, 0));
      expect(warn.mock.calls).toEqual([
        [
          "api token last_used_at update failed",
          { apiKeyId: ID, message: "db down", stack: err.stack },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
