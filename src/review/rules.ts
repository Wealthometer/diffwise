import { isTestPath, languageOf } from "./files.js"
import type { Category, RuleId, Severity } from "./repo-config.js"

/**
 * Deterministic checks that run on every added line, with or without an LLM. They're cheap,
 * explainable, and catch the problems you never want to depend on a model noticing.
 */
export type RuleHit = {
  ruleId: RuleId
  category: Category
  severity: Severity
  confidence: number
  title: string
  body: string
  suggestion?: string
}

type Rule = {
  id: RuleId
  languages?: string[]
  test: (text: string, ctx: { path: string; lang: string; isTest: boolean }) => Omit<RuleHit, "ruleId"> | null
}

const JS = ["javascript", "typescript", "vue", "svelte"]
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const PLACEHOLDER = /(example|changeme|change-me|placeholder|dummy|sample|your[_-]|xxx|\*\*\*|<[^>]+>|\$\{|process\.env|os\.environ|getenv|redacted)/i

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk_live_[0-9a-zA-Z]{20,}\b/, "a Stripe live secret key"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/, "an API secret key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bsk_test_[0-9a-zA-Z]{20,}\b/, "a Stripe test key"],
]

export const RULES: Rule[] = [
  {
    id: "private-key",
    test: (t) =>
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(t)
        ? { category: "security", severity: "critical", confidence: 0.99, title: "Private key committed", body: "A private key is being added to the repository. Anyone with read access can use it. Remove it, rotate the key, and load it from a secret store or environment variable instead." }
        : null,
  },
  {
    id: "hardcoded-secret",
    test: (t, { isTest }) => {
      for (const [re, what] of SECRET_PATTERNS) {
        const m = t.match(re)
        if (m && !PLACEHOLDER.test(t)) {
          const testKey = what === "a Stripe test key"
          return {
            category: "security",
            severity: testKey || isTest ? "high" : "critical",
            confidence: isTest ? 0.8 : 0.97,
            title: `Hard-coded secret (${what.replace(/^an? /, "")})`,
            body: `This line contains what looks like ${what}. Secrets in git history stay exposed even after they're deleted. Rotate it, then read it from configuration (e.g. an environment variable).`,
          }
        }
      }
      // Matches DB_PASSWORD = "...", apiKey: '...', "client_secret": "..." (identifier may have prefixes/suffixes).
      const assign = t.match(/(?:^|[^A-Za-z0-9])[A-Za-z0-9_]*?(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i)
      if (assign && !PLACEHOLDER.test(t) && !/^(true|false|null|none|undefined)$/i.test(assign[2]!)) {
        return {
          category: "security",
          // Test fixtures are usually fake; real token formats above still apply in tests.
          severity: isTest ? "low" : "high",
          confidence: isTest ? 0.5 : 0.8,
          title: `Hard-coded ${assign[1]!.toLowerCase().replace(/[_-]/g, " ")}`,
          body: "A credential appears to be written directly in the code. Move it to configuration or a secret manager so it isn't shared with everyone who can read the repository.",
        }
      }
      return null
    },
  },
  {
    id: "tls-verification-disabled",
    test: (t) =>
      /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(false|0)|setHostnameVerifier\(.*ALLOW_ALL/.test(t)
        ? { category: "security", severity: "high", confidence: 0.92, title: "TLS certificate verification disabled", body: "Turning off certificate checks lets anyone on the network path impersonate the server and read or change the traffic. If this is for a self-signed certificate, trust that specific CA instead." }
        : null,
  },
  {
    id: "sql-injection",
    test: (t, { lang }) => {
      // A string literal only counts as SQL if it has SQL *structure*, not just a keyword ("Select an option").
      const isSql = (s: string) => /\b(SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\b[\s\S]*\bSET|DELETE\s+FROM)\b/i.test(s) || /\bWHERE\b/.test(s)
      const literals = [...t.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)]
      const concat =
        literals.some((m) => isSql(m[2]!) && new RegExp(`${escapeRe(m[0])}\\s*\\+\\s*[A-Za-z_$]`).test(t)) ||
        /\+\s*[A-Za-z_$][\w.$[\]]*\s*\+\s*(["'])\s*(WHERE|AND|OR|VALUES|SET|LIMIT|ORDER BY)\b/.test(t)
      const template = literals.some((m) => m[1] === "`" && isSql(m[2]!) && /\$\{[^}]+\}/.test(m[2]!))
      const fstring = lang === "python" && /\bf(["'])((?:(?!\1).)*)\1/.test(t) && [...t.matchAll(/\bf(["'])((?:(?!\1).)*)\1/g)].some((m) => isSql(m[2]!) && /\{[^}]+\}/.test(m[2]!))
      const percent = lang === "python" && literals.some((m) => isSql(m[2]!) && /%s/.test(m[2]!) && new RegExp(`${escapeRe(m[0])}\\s*%\\s*[\\w(]`).test(t))
      const format = literals.some((m) => isSql(m[2]!) && new RegExp(`${escapeRe(m[0])}\\s*\\.format\\(`).test(t))
      if (!(concat || template || fstring || percent || format)) return null
      return {
        category: "security",
        severity: "high",
        confidence: 0.8,
        title: "SQL built from string interpolation",
        body: "Values are being inserted into SQL text. If any of them come from a user, this is a SQL injection. Pass them as query parameters (placeholders) instead of building the string.",
      }
    },
  },
  {
    id: "dynamic-code-execution",
    test: (t, { lang }) => {
      const js = JS.includes(lang) && /(^|[^.\w])eval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*["'`]/.test(t)
      const py = lang === "python" && /(^|[^.\w])(eval|exec)\s*\(/.test(t)
      return js || py
        ? { category: "security", severity: "high", confidence: 0.75, title: "Dynamic code execution", body: "Evaluating a string as code runs whatever that string contains. If any part of it can be influenced by input, an attacker can run arbitrary code. Parse the data (e.g. JSON.parse / ast.literal_eval) or dispatch through a fixed table instead." }
        : null
    },
  },
  {
    id: "unsafe-html",
    languages: [...JS, "html"],
    test: (t) => {
      const rhs = t.match(/\.(?:innerHTML|outerHTML)\s*\+?=\s*(.+)$/)?.[1]
      const inner = rhs !== undefined && !/^(["'`])[^"'`$]*\1\s*;?\s*$/.test(rhs) // a plain string literal is safe
      const react = /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*(?!["'`])/.test(t)
      const write = /document\.write\s*\(/.test(t)
      return inner || react || write
        ? { category: "security", severity: "medium", confidence: 0.7, title: "HTML injected from a variable", body: "Inserting a variable as raw HTML allows cross-site scripting if the value can contain user input. Use textContent, or sanitize the HTML (e.g. DOMPurify) before inserting it." }
        : null
    },
  },
  {
    id: "weak-hash",
    test: (t, { lang }) => {
      const weak = /createHash\(\s*["'](md5|sha1)["']\s*\)|hashlib\.(md5|sha1)\s*\(|MessageDigest\.getInstance\(\s*"(MD5|SHA-?1)"\s*\)|\b(md5|sha1)\.(New|Sum)\(/i.test(t)
      if (!weak) return null
      const passwordish = /pass(word)?|pwd|secret|token|sign/i.test(t)
      return {
        category: "security",
        severity: passwordish ? "high" : "low",
        confidence: passwordish ? 0.85 : 0.5,
        title: passwordish ? "Weak hash used for a secret" : "MD5/SHA-1 in use",
        body: passwordish
          ? `MD5 and SHA-1 are broken for this purpose. For passwords use a slow KDF (argon2, bcrypt, scrypt); for signatures/tokens use HMAC-SHA-256${lang === "python" ? " (hmac + hashlib.sha256)" : ""}.`
          : "MD5 and SHA-1 are fine for checksums but not for anything security-sensitive. If this protects data or identities, switch to SHA-256 or better.",
      }
    },
  },
  {
    id: "empty-catch",
    test: (t, { lang }) =>
      (JS.includes(lang) || ["java", "kotlin", "csharp", "dart", "php"].includes(lang)) && /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.test(t)
        ? { category: "reliability", severity: "medium", confidence: 0.85, title: "Error swallowed silently", body: "This catch block discards the error, so failures here will be invisible in logs and hard to debug. Log it, handle it, or let it propagate; if ignoring it is intentional, add a comment saying why." }
        : lang === "python" && /^\s*except(\s+\w[\w.]*)?\s*:\s*pass\s*$/.test(t)
          ? { category: "reliability", severity: "medium", confidence: 0.85, title: "Exception swallowed silently", body: "`except: pass` hides every failure here, including bugs. Catch the specific exception you expect and log or handle it." }
          : null,
  },
  {
    id: "debugger-statement",
    languages: JS,
    test: (t) =>
      /^\s*debugger\s*;?\s*$/.test(t)
        ? { category: "bug", severity: "medium", confidence: 0.95, title: "Leftover debugger statement", body: "`debugger` pauses execution whenever dev tools are open. Remove it before merging.", suggestion: "" }
        : null,
  },
  {
    id: "console-log",
    languages: JS,
    test: (t, { isTest }) =>
      !isTest && /^\s*console\.(log|debug)\(/.test(t)
        ? { category: "maintainability", severity: "low", confidence: 0.6, title: "Debug logging left in", body: "This looks like temporary debug output. Remove it or use the project's logger." }
        : null,
  },
]

export function runRules(path: string, lines: Map<number, string>, enabled: (id: RuleId) => boolean) {
  const lang = languageOf(path)
  const isTest = isTestPath(path)
  const hits: (RuleHit & { line: number })[] = []
  for (const [line, text] of lines) {
    if (text.length > 1000) continue // minified or data blobs
    for (const rule of RULES) {
      if (!enabled(rule.id) || (rule.languages && !rule.languages.includes(lang))) continue
      const hit = rule.test(text, { path, lang, isTest })
      if (hit) {
        hits.push({ ...hit, ruleId: rule.id, line })
        if (rule.id === "private-key" || rule.id === "hardcoded-secret") break // one secret finding per line
      }
    }
  }
  return hits
}
