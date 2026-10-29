import { createSign } from "node:crypto"
import { config } from "../config.js"
import { GitHubError } from "./client.js"

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url")

/** A GitHub App JWT (RS256), valid ~9 minutes. Backdated 60s to tolerate clock drift. */
export function createAppJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey)
  return `${header}.${payload}.${b64url(signature)}`
}

const cache = new Map<number, { token: string; expiresAt: number }>()

/** Installation access tokens last an hour; cache and refresh a minute early. */
export async function installationToken(installationId: number): Promise<string> {
  const hit = cache.get(installationId)
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token

  const cfg = config()
  const res = await fetch(`${cfg.GITHUB_API_URL}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${createAppJwt(cfg.GITHUB_APP_ID, cfg.GITHUB_PRIVATE_KEY)}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "diffwise",
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new GitHubError(res.status, `Could not get an installation token (${res.status})`, res.status >= 500 || res.status === 429)
  const data = (await res.json()) as { token: string; expires_at: string }
  cache.set(installationId, { token: data.token, expiresAt: new Date(data.expires_at).getTime() })
  return data.token
}

export function clearTokenCache() {
  cache.clear()
}
