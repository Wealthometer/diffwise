import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

type Responder = (req: { system: string; prompt: string; model: string; tools: unknown[]; toolChoice: unknown }) => unknown[]

/**
 * A stand-in for the Anthropic Messages API: checks auth/version headers and the forced tool call,
 * returns findings from a programmable responder, and can inject overload (529) errors.
 */
export class FakeAnthropic {
  url = ""
  requests: { system: string; prompt: string; model: string; tools: unknown[]; toolChoice: unknown }[] = []
  failures: number[] = [] // statuses to return before succeeding, e.g. [529, 529]
  private server!: Server

  constructor(
    public respond: Responder = () => [],
    private apiKey = "test-key",
  ) {}

  async start() {
    this.server = createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify(body))
        }
        if (req.url !== "/v1/messages" || req.method !== "POST") return send(404, { type: "error", error: { type: "not_found_error" } })
        if (req.headers["x-api-key"] !== this.apiKey) return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
        if (!req.headers["anthropic-version"]) return send(400, { type: "error", error: { type: "invalid_request_error", message: "anthropic-version header is required" } })
        const failure = this.failures.shift()
        if (failure) return send(failure, { type: "error", error: { type: failure === 529 ? "overloaded_error" : "api_error", message: "Overloaded" } })

        const body = JSON.parse(raw)
        const prompt = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : ""
        const entry = { system: body.system, prompt, model: body.model, tools: body.tools, toolChoice: body.tool_choice }
        this.requests.push(entry)
        const findings = this.respond(entry)
        send(200, {
          id: `msg_${this.requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "report_findings", input: { findings } }],
          usage: { input_tokens: Math.ceil((body.system.length + prompt.length) / 4), output_tokens: 40 + findings.length * 60 },
        })
      })
    })
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()))
  }
}
