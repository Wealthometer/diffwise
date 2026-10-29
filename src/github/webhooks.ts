import { createHmac, timingSafeEqual } from "node:crypto"

/** Verifies X-Hub-Signature-256 against the raw request body, in constant time. */
export function verifySignature(secret: string, rawBody: Buffer | string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}
