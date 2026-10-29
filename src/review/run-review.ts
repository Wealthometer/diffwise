import { config } from "../config.js"
import { db, withTransaction } from "../db/pool.js"
import { installationToken } from "../github/app-auth.js"
import { GitHubClient, GitHubError } from "../github/client.js"
import { logger } from "../logger.js"
import { NonRetryableError, type Job } from "../queue/queue.js"
import { analyze, select, type Finding } from "./analyze.js"
import { LlmError, type LlmProvider } from "./llm/provider.js"
import { commentBody, summaryBody } from "./format.js"
import { defaultProvider } from "./provider-factory.js"
import { parseRepoConfig } from "./repo-config.js"
import { monthUsage, recordUsage } from "./usage.js"

export type ReviewJob = { reviewId: string; commandCommentId: number | null }

type ReviewRow = {
  id: string
  installation_id: number
  repo_full_name: string
  pr_number: number
  head_sha: string | null
  trigger: string
  status: string
  github_review_id: number | null
  suspended_at: Date | null
  removed_at: Date | null
}

export type ReviewDeps = {
  provider: () => LlmProvider | null
  github: (installationId: number) => GitHubClient
}

const defaultDeps: ReviewDeps = {
  provider: defaultProvider,
  github: (id) => new GitHubClient(() => installationToken(id)),
}

async function finish(id: string, status: "completed" | "skipped" | "superseded" | "failed", fields: Record<string, unknown> = {}) {
  const cols = Object.keys(fields)
  await db().query(
    `UPDATE reviews SET status = $2, completed_at = now(), duration_ms = (extract(epoch FROM now() - COALESCE(started_at, now())) * 1000)::int
       ${cols.map((c, i) => `, ${c} = $${i + 3}`).join("")}
      WHERE id = $1`,
    [id, status, ...Object.values(fields)],
  )
}

/**
 * The review job. Idempotent: it can be retried at any point without double-posting, because the
 * GitHub review id is saved the moment the review is created and checked before posting again.
 */
export async function runReview(job: Job<ReviewJob>, deps: ReviewDeps = defaultDeps): Promise<void> {
  const res = await db().query<ReviewRow>(
    `SELECT r.id, r.installation_id, r.repo_full_name, r.pr_number, r.head_sha, r.trigger, r.status, r.github_review_id, i.suspended_at, i.removed_at
       FROM reviews r JOIN installations i ON i.id = r.installation_id WHERE r.id = $1`,
    [job.payload.reviewId],
  )
  const review = res.rows[0]
  if (!review || review.status === "superseded" || review.status === "completed" || review.status === "skipped") return
  if (review.github_review_id) return finish(review.id, "completed") // posted on a previous attempt
  if (review.suspended_at || review.removed_at) return finish(review.id, "skipped", { skip_reason: "The GitHub App is suspended or uninstalled" })

  await db().query("UPDATE reviews SET status = 'running', started_at = COALESCE(started_at, now()), error = NULL WHERE id = $1", [review.id])
  const log = logger.child({ reviewId: review.id, repo: review.repo_full_name, pr: review.pr_number })
  const gh = deps.github(review.installation_id)
  const isLastAttempt = job.attempts >= job.max_attempts

  try {
    if (job.payload.commandCommentId) await gh.reactToComment(review.repo_full_name, job.payload.commandCommentId, "eyes").catch(() => {})

    const pr = await gh.getPull(review.repo_full_name, review.pr_number)
    if (pr.state !== "open") return finish(review.id, "skipped", { skip_reason: "The pull request is closed" })
    let headSha = review.head_sha
    if (review.trigger === "command") {
      headSha = pr.head.sha
      await db().query("UPDATE reviews SET head_sha = $2, pr_title = $3 WHERE id = $1", [review.id, headSha, pr.title])
    } else if (pr.head.sha !== headSha) {
      return finish(review.id, "superseded", { skip_reason: "A newer commit was pushed" })
    }

    // Config comes from the base branch, so a PR can't switch off its own review.
    const { config: repoCfg, error: configError } = parseRepoConfig(await gh.getFile(review.repo_full_name, ".diffwise.yml", pr.base.ref))
    if (!repoCfg.enabled && review.trigger !== "command") return finish(review.id, "skipped", { skip_reason: "Disabled in .diffwise.yml" })
    if (pr.draft && !repoCfg.review_drafts && review.trigger !== "command") return finish(review.id, "skipped", { skip_reason: "Draft pull request" })

    const files = await gh.listPullFiles(review.repo_full_name, review.pr_number)
    const changed = files.reduce((n, f) => n + f.additions + f.deletions, 0)
    const limit = config().MAX_PR_CHANGED_LINES
    if (changed > limit && review.trigger !== "command") {
      await gh.createIssueComment(
        review.repo_full_name,
        review.pr_number,
        `Diffwise skipped this pull request because it changes ${changed.toLocaleString("en")} lines (the limit is ${limit.toLocaleString("en")}). Large reviews get worse results; consider splitting it, or comment \`${config().BOT_COMMAND} review\` to review it anyway.`,
      )
      return finish(review.id, "skipped", { skip_reason: `Too large (${changed} changed lines)` })
    }

    const usage = await monthUsage(review.installation_id)
    let provider = deps.provider()
    const extraNotes: string[] = []
    if (provider && usage && !usage.aiAllowed) {
      provider = null
      extraNotes.push(`This installation has used its AI review allowance for the month (${usage.reviews}/${usage.reviewLimit} reviews), so only the built-in checks ran.`)
    }
    if (!provider && !config().ANTHROPIC_API_KEY) extraNotes.push("No model is configured, so only the built-in checks ran.")

    const analysis = await analyze(
      files.map((f) => ({ path: f.filename, status: f.status, patch: f.patch ?? null, previousPath: f.previous_filename })),
      repoCfg,
      { provider, prTitle: pr.title, maxPromptChars: config().MAX_PROMPT_CHARS_PER_BATCH, degradeOnLlmError: isLastAttempt },
    )
    analysis.notes.push(...extraNotes)

    const prior = await db().query<{ fingerprint: string }>(
      "SELECT DISTINCT fingerprint FROM findings WHERE repo_id = (SELECT repo_id FROM reviews WHERE id = $1) AND pr_number = $2 AND outcome = 'posted'",
      [review.id, review.pr_number],
    )
    const ranked = select(analysis.findings, new Set(prior.rows.map((r) => r.fingerprint)), repoCfg.max_comments)
    const inline = ranked.filter((f) => f.outcome === "posted")
    const overflow = ranked.filter((f) => f.outcome === "summary")
    const duplicates = analysis.findings.filter((f) => f.outcome === "duplicate").length

    const earlier = await db().query("SELECT 1 FROM reviews WHERE repo_id = (SELECT repo_id FROM reviews WHERE id = $1) AND pr_number = $2 AND status = 'completed' AND github_review_id IS NOT NULL LIMIT 1", [review.id, review.pr_number])
    // On later pushes, stay quiet unless there's something new to say.
    const shouldPost = ranked.length > 0 || review.trigger === "command" || earlier.rowCount === 0
    const cost = (analysis.usage.inputTokens * config().LLM_INPUT_PRICE_PER_MTOK + analysis.usage.outputTokens * config().LLM_OUTPUT_PRICE_PER_MTOK) / 1e6

    // Save what we found before talking to GitHub, so a crash afterwards loses nothing.
    await withTransaction(async (c) => {
      await c.query("DELETE FROM findings WHERE review_id = $1", [review.id])
      for (const f of analysis.findings) {
        await c.query(
          `INSERT INTO findings (review_id, repo_id, pr_number, path, line, severity, category, title, body, suggestion, confidence, source, rule_id, fingerprint, outcome)
           SELECT $1, repo_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14 FROM reviews WHERE id = $1`,
          [review.id, review.pr_number, f.path, f.line, f.severity, f.category, f.title, f.body, f.suggestion, f.confidence, f.source, f.ruleId, f.fingerprint, f.outcome],
        )
      }
      await c.query(
        `UPDATE reviews SET mode = $2, model = $3, input_tokens = $4, output_tokens = $5, cost_usd = $6, files_reviewed = $7, files_skipped = $8,
                lines_reviewed = $9, findings_count = $10, comments_posted = $11 WHERE id = $1`,
        [review.id, analysis.mode, analysis.usage.model, analysis.usage.inputTokens, analysis.usage.outputTokens, cost, analysis.reviewedFiles.length,
         analysis.skippedFiles.length, analysis.linesReviewed, ranked.length, inline.length],
      )
    })
    await recordUsage(review.installation_id, analysis.usage.inputTokens, analysis.usage.outputTokens, analysis.mode === "full")

    if (!shouldPost) {
      log.info({ findings: 0 }, "nothing new to report; not posting")
      return finish(review.id, "completed")
    }

    const repoUrl = `${config().GITHUB_WEB_URL}/${review.repo_full_name}`
    const summary = (reviewedAll: boolean, inlineList: Finding[], over: Finding[]) =>
      summaryBody(analysis, { posted: inlineList, overflow: over, duplicates, repoUrl, headSha: headSha!, command: config().BOT_COMMAND, configError, reviewedAll })

    let posted: { id: number }
    try {
      posted = await gh.createReview(review.repo_full_name, review.pr_number, {
        commit_id: headSha!,
        body: summary(true, inline, overflow),
        comments: inline.map((f) => ({ path: f.path, line: f.line!, side: "RIGHT" as const, body: commentBody(f) })),
      })
    } catch (err) {
      // 422: GitHub couldn't place a comment (e.g. the diff moved). Post everything in the summary instead.
      if (!(err instanceof GitHubError && err.status === 422) || inline.length === 0) throw err
      log.warn({ err: err.message }, "inline comments rejected; posting summary only")
      posted = await gh.createReview(review.repo_full_name, review.pr_number, { commit_id: headSha!, body: summary(false, [], [...inline, ...overflow]), comments: [] })
      await db().query("UPDATE findings SET outcome = 'summary' WHERE review_id = $1 AND outcome = 'posted'", [review.id])
      await db().query("UPDATE reviews SET comments_posted = 0 WHERE id = $1", [review.id])
    }
    await finish(review.id, "completed", { github_review_id: posted.id })
    log.info({ inline: inline.length, overflow: overflow.length, mode: analysis.mode }, "review posted")
  } catch (err) {
    const permanent =
      err instanceof NonRetryableError ||
      (err instanceof GitHubError && !err.retryable) ||
      (err instanceof LlmError && !err.retryable)
    if (permanent || isLastAttempt) {
      await finish(review.id, "failed", { error: (err as Error).message.slice(0, 1000) })
      throw permanent ? new NonRetryableError((err as Error).message) : err
    }
    await db().query("UPDATE reviews SET status = 'queued', error = $2 WHERE id = $1", [review.id, `Retrying: ${(err as Error).message.slice(0, 500)}`])
    throw err
  }
}
