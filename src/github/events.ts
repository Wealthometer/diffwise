import type { PoolClient } from "pg"
import { config } from "../config.js"
import { withTransaction } from "../db/pool.js"
import { enqueue } from "../queue/queue.js"

type Account = { login: string; type: string }
type Repo = { id: number; full_name: string; private?: boolean }
type Installation = { id: number; account?: Account }

export type EventResult = { outcome: "duplicate" | "ignored" | "handled" | "queued"; detail?: string; reviewId?: string }

const PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"])
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

async function upsertInstallation(c: PoolClient, inst: Installation) {
  const cfg = config()
  await c.query(
    `INSERT INTO installations (id, account_login, account_type, monthly_review_limit, monthly_token_limit)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET account_login = EXCLUDED.account_login, removed_at = NULL`,
    [inst.id, inst.account?.login ?? "unknown", inst.account?.type ?? "User", cfg.DEFAULT_MONTHLY_REVIEW_LIMIT, cfg.DEFAULT_MONTHLY_TOKEN_LIMIT],
  )
}

async function upsertRepos(c: PoolClient, installationId: number, repos: Repo[]) {
  for (const r of repos) {
    await c.query(
      `INSERT INTO repositories (id, installation_id, full_name, private) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, installation_id = EXCLUDED.installation_id`,
      [r.id, installationId, r.full_name, r.private ?? false],
    )
  }
}

async function queueReview(
  c: PoolClient,
  p: { installationId: number; repo: Repo; prNumber: number; title: string; author: string; headSha: string | null; trigger: string; commandCommentId?: number },
): Promise<EventResult> {
  const cfg = config()
  const repoRow = await c.query<{ enabled: boolean }>("SELECT enabled FROM repositories WHERE id = $1", [p.repo.id])
  if (repoRow.rows[0] && !repoRow.rows[0].enabled) return { outcome: "ignored", detail: "repository disabled in Diffwise" }

  const inserted = await c.query<{ id: string }>(
    `INSERT INTO reviews (installation_id, repo_id, repo_full_name, pr_number, pr_title, pr_author, head_sha, trigger)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (repo_id, pr_number, head_sha) WHERE trigger <> 'command' DO NOTHING
     RETURNING id`,
    [p.installationId, p.repo.id, p.repo.full_name, p.prNumber, p.title, p.author, p.headSha, p.trigger],
  )
  const reviewId = inserted.rows[0]?.id
  if (!reviewId) return { outcome: "duplicate", detail: "this commit is already queued or reviewed" }

  // A newer push makes earlier queued reviews of this PR pointless.
  await c.query(
    `UPDATE reviews SET status = 'superseded', completed_at = now()
      WHERE repo_id = $1 AND pr_number = $2 AND status = 'queued' AND id <> $3`,
    [p.repo.id, p.prNumber, reviewId],
  )
  await enqueue(
    {
      type: "review",
      payload: { reviewId, commandCommentId: p.commandCommentId ?? null },
      dedupeKey: `review:${reviewId}`,
      groupKey: `pr:${p.repo.id}:${p.prNumber}`,
      supersede: true,
      // Debounce automatic reviews so a burst of pushes produces one review; commands run now.
      delaySeconds: p.trigger === "command" ? 0 : cfg.REVIEW_DEBOUNCE_SECONDS,
    },
    c,
  )
  return { outcome: "queued", reviewId }
}

/**
 * Applies one webhook delivery. Runs in a transaction that also records the delivery id, so a
 * redelivered webhook is a no-op and a review job exists only if its review row does.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleEvent(event: string, deliveryId: string, payload: any): Promise<EventResult> {
  return withTransaction(async (c) => {
    const fresh = await c.query("INSERT INTO webhook_deliveries (id, event, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [deliveryId, event, payload.action ?? null])
    if (!fresh.rowCount) return { outcome: "duplicate", detail: "delivery already processed" }

    const installation: Installation | undefined = payload.installation

    switch (event) {
      case "ping":
        return { outcome: "handled", detail: "pong" }

      case "installation": {
        if (!installation) return { outcome: "ignored" }
        if (payload.action === "created" || payload.action === "new_permissions_accepted") {
          await upsertInstallation(c, installation)
          await upsertRepos(c, installation.id, payload.repositories ?? [])
        } else if (payload.action === "deleted") {
          await c.query("UPDATE installations SET removed_at = now() WHERE id = $1", [installation.id])
          await c.query("UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE status = 'queued' AND payload->>'reviewId' IN (SELECT id::text FROM reviews WHERE installation_id = $1)", [installation.id])
        } else if (payload.action === "suspend") {
          await c.query("UPDATE installations SET suspended_at = now() WHERE id = $1", [installation.id])
        } else if (payload.action === "unsuspend") {
          await c.query("UPDATE installations SET suspended_at = NULL WHERE id = $1", [installation.id])
        }
        return { outcome: "handled", detail: `installation ${payload.action}` }
      }

      case "installation_repositories": {
        if (!installation) return { outcome: "ignored" }
        await upsertInstallation(c, installation)
        await upsertRepos(c, installation.id, payload.repositories_added ?? [])
        const removed: Repo[] = payload.repositories_removed ?? []
        if (removed.length) await c.query("DELETE FROM repositories WHERE id = ANY($1::bigint[])", [removed.map((r) => r.id)])
        return { outcome: "handled" }
      }

      case "pull_request": {
        if (!installation) return { outcome: "ignored" }
        const pr = payload.pull_request
        if (payload.action === "closed") {
          await c.query("UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE group_key = $1 AND status = 'queued'", [`pr:${payload.repository.id}:${pr.number}`])
          await c.query("UPDATE reviews SET status = 'superseded', completed_at = now() WHERE repo_id = $1 AND pr_number = $2 AND status = 'queued'", [payload.repository.id, pr.number])
          return { outcome: "handled", detail: "PR closed; pending reviews cancelled" }
        }
        if (!PR_ACTIONS.has(payload.action)) return { outcome: "ignored", detail: `pull_request.${payload.action}` }
        if (pr.draft && payload.action !== "ready_for_review") return { outcome: "ignored", detail: "draft PR (comment /diffwise review to review it anyway)" }
        await upsertInstallation(c, installation)
        await upsertRepos(c, installation.id, [payload.repository])
        return queueReview(c, {
          installationId: installation.id,
          repo: payload.repository,
          prNumber: pr.number,
          title: pr.title,
          author: pr.user?.login ?? "",
          headSha: pr.head.sha,
          trigger: payload.action,
        })
      }

      case "issue_comment": {
        if (!installation || payload.action !== "created" || !payload.issue?.pull_request) return { outcome: "ignored" }
        const body: string = payload.comment?.body ?? ""
        const command = config().BOT_COMMAND
        if (!new RegExp(`^\\s*${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+review\\b`, "i").test(body)) return { outcome: "ignored" }
        // Only people with write-level association can spend the installation's review budget.
        if (!TRUSTED_ASSOCIATIONS.has(payload.comment.author_association)) return { outcome: "ignored", detail: "commenter is not a collaborator" }
        await upsertInstallation(c, installation)
        await upsertRepos(c, installation.id, [payload.repository])
        return queueReview(c, {
          installationId: installation.id,
          repo: payload.repository,
          prNumber: payload.issue.number,
          title: payload.issue.title,
          author: payload.issue.user?.login ?? "",
          headSha: null,
          trigger: "command",
          commandCommentId: payload.comment.id,
        })
      }

      default:
        return { outcome: "ignored", detail: event }
    }
  })
}
