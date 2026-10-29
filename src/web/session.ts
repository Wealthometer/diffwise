import { createHmac, timingSafeEqual } from "node:crypto"

/** Stateless signed cookies: base64url(JSON) + "." + HMAC-SHA256. */
export function seal(secret: string, data: object, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url")
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`
}

export function unseal<T>(secret: string, value: string | undefined): T | null {
  if (!value) return null
  const [body, mac] = value.split(".")
  if (!body || !mac) return null
  const expected = createHmac("sha256", secret).update(body).digest("base64url")
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number }
    return data.exp > Date.now() / 1000 ? data : null
  } catch {
    return null
  }
}
