import { randomBytes } from "node:crypto"
import cookie from "@fastify/cookie"
import formbody from "@fastify/formbody"
import helmet from "@fastify/helmet"
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify"
import { config } from "../config.js"
import { db } from "../db/pool.js"
import { handleEvent } from "../github/events.js"
import { verifySignature } from "../github/webhooks.js"
import { logger } from "../logger.js"
import { queueStats } from "../queue/queue.js"
import { seal, unseal } from "./session.js"
import { FAVICON_SVG, html, layout, raw, timeAgo } from "./views.js"

type SessionUser = { id: number; login: string; avatar_url: string | null }
const SESSION = "dw_session"
const STATE = "dw_oauth_state"

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}

const STATUS_TAG: Record<string, string> = { completed: "ok", failed: "bad", skipped: "", superseded: "", queued: "warn", running: "warn" }
const OUTCOME_LABEL: Record<string, string> = {
  posted: "Posted inline",
  summary: "In summary (over comment limit)",
  duplicate: "Already reported on an earlier commit",
  below_threshold: "Below severity/confidence threshold",
  disabled_category: "Category turned off",
  unanchored: "Dropped: not on a line this PR added",
  superseded_by_rule: "Merged with another finding on the same line",
}

export async function buildApp() {
  const cfg = config()
  const app = Fastify({ loggerInstance: logger, trustProxy: "loopback,uniquelocal", bodyLimit: 25 * 1024 * 1024 })
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "https://avatars.githubusercontent.com", "data:"] } },
  })
  await app.register(cookie)
  await app.register(formbody)

  const cookieOpts = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: cfg.COOKIE_SECURE }
  const currentUser = (req: FastifyRequest) => unseal<SessionUser>(cfg.SESSION_SECRET, req.cookies[SESSION])
  const send = (reply: FastifyReply, title: string, user: SessionUser | null, body: ReturnType<typeof html>, code = 200) =>
    reply.code(code).type("text/html; charset=utf-8").send(layout({ title, user, body }))

  // Form posts must come from our own pages (defence in depth on top of SameSite cookies).
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "POST" && !req.url.startsWith("/webhooks/")) {
      const origin = req.headers.origin ?? req.headers.referer
      if (!origin || !origin.startsWith(new URL(cfg.PUBLIC_URL).origin)) return reply.code(403).send("Cross-site request blocked")
    }
  })

  // ── Webhooks ──────────────────────────────────────────────────────────────
  await app.register(async (scope) => {
    // Signatures are computed over the exact bytes GitHub sent, so keep the raw body.
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
      req.rawBody = body as Buffer
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")))
      } catch {
        done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }), undefined)
      }
    })
    scope.post("/webhooks/github", async (req, reply) => {
      const event = req.headers["x-github-event"]
      const delivery = req.headers["x-github-delivery"]
      if (!verifySignature(cfg.GITHUB_WEBHOOK_SECRET, req.rawBody ?? "", req.headers["x-hub-signature-256"] as string | undefined)) {
        return reply.code(401).send({ error: "Invalid signature" })
      }
      if (typeof event !== "string" || typeof delivery !== "string") return reply.code(400).send({ error: "Missing GitHub headers" })
      const result = await handleEvent(event, delivery, req.body)
      req.log.info({ event, delivery, ...result }, "webhook")
      return result
    })
  })

  // ── Favicon ──────────────────────────────────────────────────────────────
  // Browsers also request /favicon.ico on their own, so answer it rather than 404.
  for (const path of ["/favicon.svg", "/favicon.ico"]) {
    app.get(path, async (_req, reply) => reply.type("image/svg+xml").header("cache-control", "public, max-age=86400").send(FAVICON_SVG))
  }

  // ── Health ───────────────────────────────────────────────────────────────
  app.get("/health", async () => ({ ok: true }))
  app.get("/health/ready", async (_req, reply) => {
    try {
      await db().query("SELECT 1")
      return { ok: true, jobs: await queueStats() }
    } catch {
      return reply.code(503).send({ ok: false })
    }
  })

  // ── GitHub sign-in (OAuth web flow) ──────────────────────────────────────
  app.get("/login", async (_req, reply) => {
    if (!cfg.GITHUB_CLIENT_ID) return reply.code(503).type("text/plain").send("GitHub sign-in isn't configured (GITHUB_CLIENT_ID).")
    const state = randomBytes(16).toString("hex")
    reply.setCookie(STATE, state, { ...cookieOpts, maxAge: 600 })
    const url = new URL(`${cfg.GITHUB_WEB_URL}/login/oauth/authorize`)
    url.searchParams.set("client_id", cfg.GITHUB_CLIENT_ID)
    url.searchParams.set("redirect_uri", `${cfg.PUBLIC_URL}/auth/callback`)
    url.searchParams.set("state", state)
    return reply.redirect(url.toString())
  })

  app.get("/auth/callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string }
    if (!code || !state || state !== req.cookies[STATE]) return send(reply, "Sign-in failed", null, html`<h1>Sign-in failed</h1><p class="lede">The sign-in link expired or was opened in another browser. <a href="/login">Try again</a>.</p>`, 400)
    reply.clearCookie(STATE, { path: "/" })

    const tokenRes = await fetch(`${cfg.GITHUB_WEB_URL}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: cfg.GITHUB_CLIENT_ID, client_secret: cfg.GITHUB_CLIENT_SECRET, code, redirect_uri: `${cfg.PUBLIC_URL}/auth/callback` }),
    })
    const token = ((await tokenRes.json().catch(() => ({}))) as { access_token?: string }).access_token
    if (!token) return send(reply, "Sign-in failed", null, html`<h1>Sign-in failed</h1><p class="lede">GitHub didn't accept the sign-in. <a href="/login">Try again</a>.</p>`, 400)

    const gh = async <T>(path: string) => {
      const r = await fetch(`${cfg.GITHUB_API_URL}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "diffwise" } })
      if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}`)
      return (await r.json()) as T
    }
    const user = await gh<{ id: number; login: string; name: string | null; avatar_url: string | null }>("/user")
    // Installations of *this* app the user can access — the source of truth for what they may see.
    const ids: number[] = []
    for (let page = 1; page <= 10; page++) {
      const r = await gh<{ installations: { id: number }[] }>(`/user/installations?per_page=100&page=${page}`)
      ids.push(...r.installations.map((i) => i.id))
      if (r.installations.length < 100) break
    }
    await db().query(
      `INSERT INTO users (id, login, name, avatar_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, last_login_at = now()`,
      [user.id, user.login, user.name, user.avatar_url],
    )
    await db().query("DELETE FROM user_installations WHERE user_id = $1", [user.id])
    await db().query("INSERT INTO user_installations (user_id, installation_id) SELECT $1, id FROM installations WHERE id = ANY($2::bigint[])", [user.id, ids])
    reply.setCookie(SESSION, seal(cfg.SESSION_SECRET, { id: user.id, login: user.login, avatar_url: user.avatar_url }, 7 * 86400), { ...cookieOpts, maxAge: 7 * 86400 })
    return reply.redirect("/")
  })

  app.get("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION, { path: "/" })
    return reply.redirect("/")
  })

  // ── Dashboard ────────────────────────────────────────────────────────────
  app.get("/", async (req, reply) => {
    const user = currentUser(req)
    if (!user) return send(reply, "AI code review on the lines that changed", null, landing())

    const reviews = await db().query(
      `SELECT r.id, r.repo_full_name, r.pr_number, r.pr_title, r.status, r.mode, r.findings_count, r.comments_posted, r.input_tokens + r.output_tokens AS tokens,
              r.cost_usd, r.created_at, r.trigger, r.skip_reason
         FROM reviews r JOIN user_installations ui ON ui.installation_id = r.installation_id AND ui.user_id = $1
        ORDER BY r.created_at DESC LIMIT 100`,
      [user.id],
    )
    const installs = await db().query("SELECT count(*)::int AS n FROM user_installations WHERE user_id = $1", [user.id])
    return send(
      reply,
      "Reviews",
      user,
      html`<h1>Reviews</h1><p class="lede">Every pull request Diffwise looked at in the repositories you can access.</p>
      ${installs.rows[0].n === 0
        ? html`<div class="panel empty"><p>Diffwise isn't installed on any account you belong to yet.</p><p style="margin-top:12px"><a class="btn" href="${cfg.GITHUB_WEB_URL}/apps/${cfg.GITHUB_APP_SLUG}/installations/new">Install on GitHub</a></p><p class="small muted" style="margin-top:10px">Already installed? <a href="/login">Sign in again</a> to refresh your access.</p></div>`
        : reviews.rows.length === 0
          ? html`<div class="panel empty">No reviews yet. Open a pull request in an installed repository, or comment <span class="mono">${cfg.BOT_COMMAND} review</span> on one.</div>`
          : html`<div class="panel"><table><thead><tr><th>Pull request</th><th>Status</th><th class="r">Issues</th><th class="r hide-sm">Inline</th><th class="hide-sm">Mode</th><th class="r hide-sm">Tokens</th><th class="r">When</th></tr></thead><tbody>
          ${reviews.rows.map(
            (r) => html`<tr><td><a href="/reviews/${r.id}"><b>${r.repo_full_name}#${r.pr_number}</b></a><div class="small muted">${r.pr_title}</div></td>
            <td><span class="tag ${STATUS_TAG[r.status] ?? ""}">${r.status}</span>${r.skip_reason ? html`<div class="small muted">${r.skip_reason}</div>` : ""}</td>
            <td class="r mono">${r.status === "completed" ? r.findings_count : "—"}</td><td class="r mono hide-sm">${r.status === "completed" ? r.comments_posted : "—"}</td>
            <td class="small hide-sm">${r.mode === "rules_only" ? "Rules only" : r.mode === "full" ? "Rules + AI" : "—"}</td>
            <td class="r mono hide-sm">${r.tokens ? r.tokens.toLocaleString("en") : "—"}</td><td class="r small muted">${timeAgo(r.created_at)}</td></tr>`,
          )}</tbody></table></div>`}`,
    )
  })

  app.get("/reviews/:id", async (req, reply) => {
    const user = currentUser(req)
    if (!user) return reply.redirect("/login")
    const { id } = req.params as { id: string }
    if (!/^[0-9a-f-]{36}$/.test(id)) return send(reply, "Not found", user, html`<h1>Review not found</h1>`, 404)
    const r = (
      await db().query(
        `SELECT r.* FROM reviews r JOIN user_installations ui ON ui.installation_id = r.installation_id AND ui.user_id = $2 WHERE r.id = $1`,
        [id, user.id],
      )
    ).rows[0]
    if (!r) return send(reply, "Not found", user, html`<h1>Review not found</h1><p class="lede">It doesn't exist or you don't have access to its repository.</p>`, 404)
    const findings = (
      await db().query(
        `SELECT path, line, severity, category, title, body, confidence, source, rule_id, outcome FROM findings WHERE review_id = $1
          ORDER BY CASE outcome WHEN 'posted' THEN 0 WHEN 'summary' THEN 1 ELSE 2 END, CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, path, line`,
        [id],
      )
    ).rows
    const prUrl = `${cfg.GITHUB_WEB_URL}/${r.repo_full_name}/pull/${r.pr_number}`
    const shown = findings.filter((f) => f.outcome === "posted" || f.outcome === "summary")
    const filtered = findings.filter((f) => f.outcome !== "posted" && f.outcome !== "summary")
    const table = (rows: typeof findings) => html`<div class="panel"><table><thead><tr><th>Severity</th><th>Issue</th><th class="hide-sm">Source</th><th>Outcome</th></tr></thead><tbody>
      ${rows.map(
        (f) => html`<tr><td class="sev-${f.severity}">${f.severity}<div class="small muted">${f.category}</div></td>
        <td><b>${f.title}</b><div class="small mono muted">${f.path}${f.line ? `:${f.line}` : ""}</div><details><summary>Explanation</summary><p class="small">${f.body}</p></details></td>
        <td class="small hide-sm">${f.source === "rule" ? html`rule <span class="mono">${f.rule_id}</span>` : html`model · ${Math.round(f.confidence * 100)}%`}</td>
        <td class="small">${OUTCOME_LABEL[f.outcome] ?? f.outcome}</td></tr>`,
      )}</tbody></table></div>`

    return send(
      reply,
      `${r.repo_full_name}#${r.pr_number}`,
      user,
      html`<p class="small"><a href="/">← Reviews</a></p>
      <h1>${r.repo_full_name}#${r.pr_number}</h1>
      <p class="lede">${r.pr_title} · <a href="${prUrl}">Open on GitHub</a> · <span class="tag ${STATUS_TAG[r.status] ?? ""}">${r.status}</span> ${r.skip_reason ? html`<span class="muted">${r.skip_reason}</span>` : ""}</p>
      ${r.error ? html`<div class="panel" style="padding:12px 14px;margin-bottom:16px;color:var(--del)">${r.error}</div>` : ""}
      <dl class="facts">
        <div><dt>Commit</dt><dd>${r.head_sha ? r.head_sha.slice(0, 7) : "—"}</dd></div>
        <div><dt>Files reviewed</dt><dd>${r.files_reviewed}<span class="small muted"> / ${r.files_reviewed + r.files_skipped}</span></dd></div>
        <div><dt>Added lines</dt><dd>${r.lines_reviewed}</dd></div>
        <div><dt>Mode</dt><dd style="font-size:15px">${r.mode === "rules_only" ? "Rules only" : r.mode === "full" ? r.model : "—"}</dd></div>
        <div><dt>Tokens</dt><dd>${(r.input_tokens + r.output_tokens).toLocaleString("en")}</dd></div>
        <div><dt>Cost (est.)</dt><dd>$${Number(r.cost_usd).toFixed(4)}</dd></div>
        <div><dt>Took</dt><dd>${r.duration_ms === null ? "—" : r.duration_ms < 1000 ? `${r.duration_ms} ms` : `${(r.duration_ms / 1000).toFixed(1)}s`}</dd></div>
      </dl>
      <h2>Reported (${shown.length})</h2>
      ${shown.length ? table(shown) : html`<div class="panel empty">Nothing was reported on this commit.</div>`}
      <h2>Filtered out (${filtered.length})</h2>
      <p class="small muted" style="margin-bottom:10px">Findings Diffwise considered and chose not to post, and why. Useful for tuning <span class="mono">.diffwise.yml</span>.</p>
      ${filtered.length ? table(filtered) : html`<div class="panel empty">None.</div>`}`,
    )
  })

  app.get("/usage", async (req, reply) => {
    const user = currentUser(req)
    if (!user) return reply.redirect("/login")
    const rows = (
      await db().query(
        `SELECT i.id, i.account_login, i.monthly_review_limit, i.monthly_token_limit, i.suspended_at,
                COALESCE(u.reviews, 0) AS reviews, COALESCE(u.input_tokens + u.output_tokens, 0) AS tokens,
                (SELECT COALESCE(sum(cost_usd), 0) FROM reviews WHERE installation_id = i.id AND created_at >= date_trunc('month', now())) AS cost,
                (SELECT count(*)::int FROM repositories WHERE installation_id = i.id) AS repos
           FROM installations i
           JOIN user_installations ui ON ui.installation_id = i.id AND ui.user_id = $1
           LEFT JOIN usage_monthly u ON u.installation_id = i.id AND u.month = date_trunc('month', now())::date
          WHERE i.removed_at IS NULL ORDER BY i.account_login`,
        [user.id],
      )
    ).rows
    const pctOf = (a: number, b: number) => (b ? Math.min(100, Math.round((100 * a) / b)) : 0)
    return send(
      reply,
      "Usage",
      user,
      html`<h1>Usage this month</h1><p class="lede">AI reviews stop when an account reaches either limit; the built-in checks keep running for free.</p>
      <div class="cards">${rows.map(
        (i) => html`<div class="panel card"><b>${i.account_login}</b> <span class="small muted">${i.repos} repositor${i.repos === 1 ? "y" : "ies"}</span>
        ${i.suspended_at ? html` <span class="tag bad">suspended</span>` : ""}
        <p class="small" style="margin-top:12px">AI reviews <span class="mono">${i.reviews} / ${i.monthly_review_limit}</span></p><div class="meter"><span style="width:${pctOf(i.reviews, i.monthly_review_limit)}%"></span></div>
        <p class="small" style="margin-top:10px">Tokens <span class="mono">${Number(i.tokens).toLocaleString("en")} / ${Number(i.monthly_token_limit).toLocaleString("en")}</span></p><div class="meter"><span style="width:${pctOf(Number(i.tokens), Number(i.monthly_token_limit))}%"></span></div>
        <p class="small muted" style="margin-top:10px">Estimated model cost: $${Number(i.cost).toFixed(2)}</p></div>`,
      )}</div>${rows.length === 0 ? html`<div class="panel empty">No installations yet.</div>` : ""}`,
    )
  })

  app.setNotFoundHandler((req, reply) => send(reply, "Not found", currentUser(req), html`<h1>Page not found</h1><p class="lede"><a href="/">Back to reviews</a></p>`, 404))
  return app
}

function landing() {
  const cfg = config()
  return html`<section class="hero"><h1>Code review that points at the line.</h1>
  <p class="lede">Diffwise is a GitHub App that reviews every pull request: built-in checks for secrets, injection and swallowed errors, plus a model that only speaks up when it can name a concrete bug on a line you added. No style nitpicks, no repeats on every push.</p>
  <p><a class="btn" href="${cfg.GITHUB_WEB_URL}/apps/${cfg.GITHUB_APP_SLUG}/installations/new">Install on GitHub</a> <a class="btn ghost" href="/login">Sign in</a></p></section>
  <div class="diff" aria-label="Example review comment">
  <div> 41  const user = await db.users.find(id)</div>
  <div class="a">+42   const rows = await db.query("SELECT * FROM orders WHERE user = '" + req.query.user + "'")</div>
  <div class="c"><b class="sev-high">🟠 High · Security</b> — SQL built from string interpolation<br><span class="muted">Values are being inserted into SQL text. If any of them come from a user, this is a SQL injection. Pass them as query parameters instead.</span></div>
  <div class="a">+43   return rows</div>
  </div>
  ${raw("")}`
}
