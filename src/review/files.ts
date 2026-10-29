import picomatch from "picomatch"

/** Files nobody wants reviewed line by line. */
export const DEFAULT_IGNORES = [
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lock", "**/bun.lockb", "**/Cargo.lock", "**/poetry.lock",
  "**/Pipfile.lock", "**/composer.lock", "**/Gemfile.lock", "**/go.sum", "**/*.lock",
  "**/*.min.js", "**/*.min.css", "**/*.map", "**/*.snap", "**/*.svg",
  "**/dist/**", "**/build/**", "**/vendor/**", "**/node_modules/**", "**/.next/**", "**/coverage/**",
  "**/*.generated.*", "**/__generated__/**", "**/*.pb.go", "**/*_pb2.py",
]

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", rb: "ruby", php: "php",
  cs: "csharp", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", swift: "swift", scala: "scala",
  sql: "sql", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", json: "json", tf: "terraform",
  vue: "vue", svelte: "svelte", html: "html", css: "css", scss: "scss", md: "markdown", dart: "dart",
}

export function languageOf(path: string): string {
  const base = path.split("/").pop() ?? path
  if (base === "Dockerfile" || base.endsWith(".dockerfile")) return "dockerfile"
  return LANGUAGES[base.split(".").pop()?.toLowerCase() ?? ""] ?? "text"
}

export const isTestPath = (path: string) => /(^|\/)(__tests__|tests?|spec|fixtures?|__mocks__)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i.test(path)

export type FileSkip = { path: string; reason: string }

export function makeIgnoreMatcher(userIgnores: string[]) {
  const isDefault = picomatch(DEFAULT_IGNORES, { dot: true })
  const isUser = userIgnores.length ? picomatch(userIgnores, { dot: true }) : () => false
  return (path: string): string | null => (isUser(path) ? "ignored by .diffwise.yml" : isDefault(path) ? "generated or lock file" : null)
}
