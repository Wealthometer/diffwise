import pino from "pino"

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: {},
  redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.token", "*.secret", "*.privateKey"], censor: "[redacted]" },
})

export function setService(name: string) {
  logger.setBindings({ service: name })
}
