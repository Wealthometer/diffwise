-- Diffwise initial schema

CREATE TABLE installations (
  id                    bigint PRIMARY KEY,           -- GitHub installation id
  account_login         text NOT NULL,
  account_type          text NOT NULL,                -- User | Organization
  suspended_at          timestamptz,
  monthly_review_limit  int NOT NULL,
  monthly_token_limit   bigint NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  removed_at            timestamptz
);

CREATE TABLE repositories (
  id               bigint PRIMARY KEY,                -- GitHub repository id
  installation_id  bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  full_name        text NOT NULL,
  private          boolean NOT NULL DEFAULT false,
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repositories_installation_idx ON repositories (installation_id);

-- GitHub redelivers webhooks; the delivery id makes processing idempotent.
CREATE TABLE webhook_deliveries (
  id           text PRIMARY KEY,
  event        text NOT NULL,
  action       text,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Job queue (Postgres, FOR UPDATE SKIP LOCKED) ───────────────────────────
CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed', 'cancelled');
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  dedupe_key    text,
  group_key     text,                                 -- e.g. one PR: newer jobs supersede older queued ones
  status        job_status NOT NULL DEFAULT 'queued',
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 4,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe_key ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX jobs_group_idx ON jobs (group_key) WHERE status = 'queued';

-- ── Reviews and findings ───────────────────────────────────────────────────
CREATE TYPE review_status AS ENUM ('queued', 'running', 'completed', 'skipped', 'failed', 'superseded');
CREATE TABLE reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id    bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repo_id            bigint NOT NULL,
  repo_full_name     text NOT NULL,
  pr_number          int NOT NULL,
  pr_title           text NOT NULL DEFAULT '',
  pr_author          text NOT NULL DEFAULT '',
  head_sha           text,                            -- filled at run time for /diffwise commands
  trigger            text NOT NULL,                   -- opened | synchronize | reopened | ready_for_review | command
  status             review_status NOT NULL DEFAULT 'queued',
  skip_reason        text,
  mode               text,                            -- full | rules_only
  model              text,
  input_tokens       int NOT NULL DEFAULT 0,
  output_tokens      int NOT NULL DEFAULT 0,
  cost_usd           numeric(10, 4) NOT NULL DEFAULT 0,
  files_reviewed     int NOT NULL DEFAULT 0,
  files_skipped      int NOT NULL DEFAULT 0,
  lines_reviewed     int NOT NULL DEFAULT 0,
  findings_count     int NOT NULL DEFAULT 0,
  comments_posted    int NOT NULL DEFAULT 0,
  github_review_id   bigint,
  duration_ms        int,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz
);
-- Automatic reviews: one per PR head commit. Manual re-runs (/diffwise review) may repeat.
CREATE UNIQUE INDEX reviews_auto_unique ON reviews (repo_id, pr_number, head_sha) WHERE trigger <> 'command';
CREATE INDEX reviews_pr_idx ON reviews (repo_id, pr_number, created_at DESC);
CREATE INDEX reviews_installation_idx ON reviews (installation_id, created_at DESC);

CREATE TYPE finding_severity AS ENUM ('critical', 'high', 'medium', 'low');
CREATE TABLE findings (
  id              bigserial PRIMARY KEY,
  review_id       uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  repo_id         bigint NOT NULL,
  pr_number       int NOT NULL,
  path            text NOT NULL,
  line            int,
  severity        finding_severity NOT NULL,
  category        text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  suggestion      text,
  confidence      real NOT NULL,
  source          text NOT NULL CHECK (source IN ('rule', 'llm')),
  rule_id         text,
  fingerprint     text NOT NULL,
  -- posted | summary (over the comment cap) | duplicate | below_threshold | unanchored | disabled_category
  outcome         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX findings_review_idx ON findings (review_id);
CREATE INDEX findings_pr_fingerprint_idx ON findings (repo_id, pr_number, fingerprint) WHERE outcome = 'posted';

CREATE TABLE usage_monthly (
  installation_id  bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  month            date NOT NULL,
  reviews          int NOT NULL DEFAULT 0,
  input_tokens     bigint NOT NULL DEFAULT 0,
  output_tokens    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, month)
);

-- ── Dashboard users (GitHub OAuth) ─────────────────────────────────────────
CREATE TABLE users (
  id             bigint PRIMARY KEY,                  -- GitHub user id
  login          text NOT NULL,
  name           text,
  avatar_url     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz NOT NULL DEFAULT now()
);
-- Which installations a user may see. Refreshed from GitHub on every sign-in.
CREATE TABLE user_installations (
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id  bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, installation_id)
);
