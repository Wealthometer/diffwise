import { db } from "../db/pool.js"

const MONTH = "date_trunc('month', now())::date"

export async function monthUsage(installationId: number) {
  const res = await db().query<{ reviews: number; input_tokens: number; output_tokens: number; monthly_review_limit: number; monthly_token_limit: number }>(
    `SELECT COALESCE(u.reviews, 0) AS reviews, COALESCE(u.input_tokens, 0) AS input_tokens, COALESCE(u.output_tokens, 0) AS output_tokens,
            i.monthly_review_limit, i.monthly_token_limit
       FROM installations i
       LEFT JOIN usage_monthly u ON u.installation_id = i.id AND u.month = ${MONTH}
      WHERE i.id = $1`,
    [installationId],
  )
  const r = res.rows[0]
  if (!r) return null
  const tokens = r.input_tokens + r.output_tokens
  return {
    reviews: r.reviews,
    tokens,
    reviewLimit: r.monthly_review_limit,
    tokenLimit: r.monthly_token_limit,
    /** AI reviews stop at either limit; built-in checks keep running for free. */
    aiAllowed: r.reviews < r.monthly_review_limit && tokens < r.monthly_token_limit,
  }
}

export async function recordUsage(installationId: number, inputTokens: number, outputTokens: number, countsAsAiReview: boolean) {
  await db().query(
    `INSERT INTO usage_monthly (installation_id, month, reviews, input_tokens, output_tokens) VALUES ($1, ${MONTH}, $2, $3, $4)
     ON CONFLICT (installation_id, month) DO UPDATE SET
       reviews = usage_monthly.reviews + EXCLUDED.reviews,
       input_tokens = usage_monthly.input_tokens + EXCLUDED.input_tokens,
       output_tokens = usage_monthly.output_tokens + EXCLUDED.output_tokens`,
    [installationId, countsAsAiReview ? 1 : 0, inputTokens, outputTokens],
  )
}
