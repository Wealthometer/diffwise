import { generateKeyPairSync } from "node:crypto"

// A throwaway RSA key pair for the GitHub App; the fake GitHub verifies JWTs with the public half.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })

process.env.NODE_ENV = "test"
process.env.LOG_LEVEL = "silent"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/diffwise_test"
process.env.SESSION_SECRET = "test-session-secret-test-session-secret"
process.env.GITHUB_APP_ID = "12345"
process.env.GITHUB_PRIVATE_KEY = privateKey
process.env.TEST_GITHUB_PUBLIC_KEY = publicKey
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret"
process.env.GITHUB_CLIENT_ID = "Iv1.test"
process.env.GITHUB_CLIENT_SECRET = "client-secret"
process.env.PUBLIC_URL = "http://diffwise.test"
process.env.REVIEW_DEBOUNCE_SECONDS = "0"
delete process.env.ANTHROPIC_API_KEY
