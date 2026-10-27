// The GitHub App JWT: RS256 over GitHub's PKCS#1 PEM, `iat`
// backdated 60 s for clock drift, `exp` 9 min out (GitHub's limit is 10), `iss`
// the App id as a string. Never log the result: it authenticates as the App.

import { createSign } from "node:crypto";

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function appJwt(appId: number, privateKeyPem: string, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: String(appId),
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKeyPem, "base64url")}`;
}
