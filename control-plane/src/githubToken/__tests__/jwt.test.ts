import { describe, expect, it } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt } from "../jwt";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = new Date("2026-10-19T12:00:00Z");

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("appJwt", () => {
  it("signs an RS256 App JWT backdated 60 s and valid for 9 min", () => {
    const jwt = appJwt(123, privateKey, NOW);
    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(jwt.split(".")).toHaveLength(3);
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({ iat: 1792411140, exp: 1792411740, iss: "123" });
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${claims}`);
    expect(verify.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("uses base64url without padding", () => {
    expect(appJwt(123, privateKey, NOW)).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
  });
});
