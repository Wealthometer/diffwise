import { createVerify } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { parsePatch } from "../../src/review/diff.js"

/**
 * An in-memory GitHub that behaves like the real API where it matters to Diffwise:
 * it verifies app JWTs with the app's public key, paginates PR files, serves file contents,
 * and rejects review comments on lines that aren't in the diff (422), like GitHub does.
 */
export type FakePr = {
  number: number
  title: string
  state?: "open" | "closed"
  draft?: boolean
  author?: string
  headSha: string
  baseRef?: string
  files: { filename: string; status?: string; patch?: string; additions?: number; deletions?: number }[]
}

export class FakeGitHub {
  url = ""
  private server!: Server
  prs = new Map<string, FakePr>() // "owner/repo#n"
  contents = new Map<string, string>() // "owner/repo:ref:path"
  reviews: { repo: string; number: number; commit_id: string; body: string; comments: { path: string; line: number; body: string }[] }[] = []
  issueComments: { repo: string; number: number; body: string }[] = []
  reactions: { repo: string; commentId: number; content: string }[] = []
  tokenRequests = 0
  failNext: { path: RegExp; status: number; times: number } | null = null
  oauth = { code: "good-code", token: "user-token", user: { id: 9001, login: "octocat", name: "Octo Cat", avatar_url: null as string | null }, installations: [] as number[] }

  constructor(private publicKey: string) {}

  addPr(repo: string, pr: FakePr) {
    this.prs.set(`${repo}#${pr.number}`, pr)
  }

  async start() {
    this.server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        try {
          const out = this.route(req, body)
          res.statusCode = out.status
          if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v)
          res.setHeader("content-type", "application/json")
          res.end(out.body === undefined ? "" : JSON.stringify(out.body))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ message: (err as Error).message }))
        }
      })
    })
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()))
  }

  private verifyAppJwt(auth: string | undefined) {
    const jwt = auth?.replace(/^Bearer /, "") ?? ""
    const [h, p, s] = jwt.split(".")
    if (!h || !p || !s) return false
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(this.publicKey, Buffer.from(s, "base64url"))
    const claims = JSON.parse(Buffer.from(p, "base64url").toString())
    return ok && claims.exp > Date.now() / 1000 && claims.iat <= Date.now() / 1000
  }

  private route(req: IncomingMessage, raw: string): { status: number; body?: unknown; headers?: Record<string, string> } {
    const url = new URL(req.url ?? "/", "http://x")
    const path = url.pathname
    const auth = req.headers.authorization

    if (this.failNext && this.failNext.path.test(path) && this.failNext.times > 0) {
      this.failNext.times--
      return { status: this.failNext.status, body: { message: "Injected failure" } }
    }

    let m: RegExpMatchArray | null
    if ((m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === "POST") {
      if (!this.verifyAppJwt(auth)) return { status: 401, body: { message: "A JSON web token could not be decoded" } }
      this.tokenRequests++
      return { status: 201, body: { token: `inst-${m[1]}-token`, expires_at: new Date(Date.now() + 3600_000).toISOString() } }
    }
    // OAuth (web host). Authorize approves instantly, as if the user clicked "Authorize".
    if (path === "/login/oauth/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "/")
      redirect.searchParams.set("code", this.oauth.code)
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "")
      return { status: 302, headers: { location: redirect.toString() } }
    }
    if (path === "/login/oauth/access_token" && req.method === "POST") {
      const b = JSON.parse(raw || "{}")
      return b.code === this.oauth.code ? { status: 200, body: { access_token: this.oauth.token } } : { status: 200, body: { error: "bad_verification_code" } }
    }
    if (path === "/user") return auth === `Bearer ${this.oauth.token}` ? { status: 200, body: this.oauth.user } : { status: 401, body: { message: "Bad credentials" } }
    if (path === "/user/installations") return { status: 200, body: { installations: this.oauth.installations.map((id) => ({ id })) } }

    if (!auth?.startsWith("Bearer inst-")) return { status: 401, body: { message: "Requires authentication" } }

    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/))) {
      const pr = this.prs.get(`${m[1]}#${m[2]}`)
      if (!pr) return { status: 404, body: { message: "Not Found" } }
      return {
        status: 200,
        body: {
          number: pr.number, title: pr.title, state: pr.state ?? "open", draft: pr.draft ?? false, user: { login: pr.author ?? "dev" },
          head: { sha: pr.headSha, ref: "feature" }, base: { sha: "base000", ref: pr.baseRef ?? "main" },
          additions: pr.files.reduce((n, f) => n + (f.additions ?? 0), 0), deletions: 0, changed_files: pr.files.length,
        },
      }
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/))) {
      const pr = this.prs.get(`${m[1]}#${m[2]}`)
      if (!pr) return { status: 404, body: { message: "Not Found" } }
      const page = Number(url.searchParams.get("page") ?? 1)
      const per = Number(url.searchParams.get("per_page") ?? 30)
      const slice = pr.files.slice((page - 1) * per, page * per).map((f) => {
        const hunks = f.patch ? parsePatch(f.patch) : []
        const adds = hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").length
        return { filename: f.filename, status: f.status ?? "modified", additions: f.additions ?? adds, deletions: f.deletions ?? 0, changes: adds, patch: f.patch }
      })
      const more = page * per < pr.files.length
      return { status: 200, body: slice, headers: more ? { link: `<${this.url}${path}?page=${page + 1}>; rel="next"` } : {} }
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/))) {
      const content = this.contents.get(`${m[1]}:${url.searchParams.get("ref")}:${decodeURIComponent(m[2]!)}`)
      return content === undefined ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") } }
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/)) && req.method === "POST") {
      const pr = this.prs.get(`${m[1]}#${m[2]}`)!
      const b = JSON.parse(raw)
      // Like GitHub: every inline comment must target a right-side line present in the diff.
      for (const c of b.comments ?? []) {
        const file = pr.files.find((f) => f.filename === c.path)
        const lines = file?.patch ? parsePatch(file.patch).flatMap((h) => h.lines).filter((l) => l.kind !== "del").map((l) => (l as { newLine: number }).newLine) : []
        if (!lines.includes(c.line)) return { status: 422, body: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] } }
      }
      if (b.event !== "COMMENT") return { status: 422, body: { message: "bad event" } }
      this.reviews.push({ repo: m[1]!, number: Number(m[2]), commit_id: b.commit_id, body: b.body, comments: b.comments ?? [] })
      return { status: 200, body: { id: 5000 + this.reviews.length, html_url: "https://github.test/review" } }
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/)) && req.method === "POST") {
      this.issueComments.push({ repo: m[1]!, number: Number(m[2]), body: JSON.parse(raw).body })
      return { status: 201, body: { id: 7000 + this.issueComments.length } }
    }
    if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)\/reactions$/)) && req.method === "POST") {
      this.reactions.push({ repo: m[1]!, commentId: Number(m[2]), content: JSON.parse(raw).content })
      return { status: 201, body: {} }
    }
    return { status: 404, body: { message: `Fake GitHub has no route for ${req.method} ${path}` } }
  }
}
