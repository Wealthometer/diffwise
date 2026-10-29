import { config } from "../config.js"

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryable: boolean,
    public retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = "GitHubError"
  }
}

export type PullRequest = {
  number: number
  title: string
  state: "open" | "closed"
  draft: boolean
  user: { login: string }
  head: { sha: string; ref: string }
  base: { sha: string; ref: string }
  additions: number
  deletions: number
  changed_files: number
}

export type PullFile = {
  filename: string
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
  additions: number
  deletions: number
  changes: number
  patch?: string
  previous_filename?: string
}

export type ReviewComment = { path: string; line: number; side: "RIGHT"; body: string }

/** Thin REST client. Every call is authenticated by a token getter so tokens refresh transparently. */
export class GitHubClient {
  constructor(
    private token: () => Promise<string>,
    private baseUrl = config().GITHUB_API_URL,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "diffwise",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const message = (() => {
        try {
          return (JSON.parse(text) as { message?: string }).message ?? text
        } catch {
          return text
        }
      })()
      const rateLimited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))
      const retryAfter = Number(res.headers.get("retry-after")) || undefined
      throw new GitHubError(res.status, `GitHub ${method} ${path} → ${res.status}: ${message.slice(0, 300)}`, rateLimited || res.status >= 500, retryAfter)
    }
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T)
    return { data, headers: res.headers }
  }

  async getPull(repo: string, number: number): Promise<PullRequest> {
    return (await this.request<PullRequest>("GET", `/repos/${repo}/pulls/${number}`)).data
  }

  /** All files in the PR (GitHub caps this at 3000), following Link pagination. */
  async listPullFiles(repo: string, number: number): Promise<PullFile[]> {
    const files: PullFile[] = []
    for (let page = 1; page <= 30; page++) {
      const { data, headers } = await this.request<PullFile[]>("GET", `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)
      files.push(...data)
      if (data.length < 100 || !/rel="next"/.test(headers.get("link") ?? "")) break
    }
    return files
  }

  /** File contents at a ref, or null if it doesn't exist. */
  async getFile(repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.request<{ content?: string; encoding?: string; type: string }>(
        "GET",
        `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      )
      if (data.type !== "file" || !data.content) return null
      return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf8")
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null
      throw err
    }
  }

  async createReview(repo: string, number: number, review: { commit_id: string; body: string; comments: ReviewComment[] }) {
    return (await this.request<{ id: number; html_url: string }>("POST", `/repos/${repo}/pulls/${number}/reviews`, { ...review, event: "COMMENT" })).data
  }

  async createIssueComment(repo: string, number: number, body: string) {
    return (await this.request<{ id: number }>("POST", `/repos/${repo}/issues/${number}/comments`, { body })).data
  }

  async reactToComment(repo: string, commentId: number, content: "eyes" | "+1" | "confused") {
    await this.request("POST", `/repos/${repo}/issues/comments/${commentId}/reactions`, { content })
  }
}
