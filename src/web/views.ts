/** Tiny HTML templating with automatic escaping. Values wrapped in raw() are trusted. */
export class Raw {
  constructor(public value: string) {}
}
export const raw = (s: string) => new Raw(s)

const esc = (v: unknown): string =>
  v instanceof Raw ? v.value : Array.isArray(v) ? v.map(esc).join("") : v === null || v === undefined || v === false ? "" : String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  return new Raw(strings.reduce((out, s, i) => out + s + (i < values.length ? esc(values[i]) : ""), ""))
}

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#0d1117;--ink2:#4b5563;--ink3:#8a93a3;--line:#e3e6ea;--add:#1a7f37;--add-bg:#e6f4ea;--del:#cf222e;--del-bg:#fbe9eb;--warn:#9a6700;--warn-bg:#fff4d6;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans)}
a{color:inherit}.mono{font-family:var(--mono);font-size:.92em}.muted{color:var(--ink3)}.small{font-size:13px}
header.top{border-bottom:1px solid var(--line);background:var(--panel)}
.bar{max-width:1120px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:18px}
.logo{font:600 16px var(--mono);text-decoration:none;display:flex;align-items:center;gap:8px}
.logo b{display:inline-flex;font-size:12px;line-height:1}.logo .p{color:var(--add)}.logo .m{color:var(--del)}
.bar nav{display:flex;gap:14px;margin-left:auto;font-size:14px;align-items:center}.bar nav a{text-decoration:none;color:var(--ink2)}.bar nav a:hover{color:var(--ink)}
.avatar{width:24px;height:24px;border-radius:50%;vertical-align:middle}
main{max-width:1120px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:24px;letter-spacing:-.01em;margin-bottom:4px}h2{font-size:16px;margin:28px 0 10px}
.lede{color:var(--ink2);margin-bottom:20px;max-width:65ch}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-weight:500;color:var(--ink3);font-size:12.5px;padding:9px 14px;border-bottom:1px solid var(--line);background:#fafbfc}
td{padding:10px 14px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}.r{text-align:right}
.tag{display:inline-block;font:500 12px/1 var(--sans);padding:4px 7px;border-radius:4px;background:#eef0f3;color:var(--ink2);white-space:nowrap}
.tag.ok{background:var(--add-bg);color:var(--add)}.tag.bad{background:var(--del-bg);color:var(--del)}.tag.warn{background:var(--warn-bg);color:var(--warn)}
.sev-critical,.sev-high{color:var(--del);font-weight:600}.sev-medium{color:var(--warn);font-weight:600}.sev-low{color:var(--ink3)}
.meter{height:6px;background:#eceef1;border-radius:3px;overflow:hidden;margin-top:6px}.meter span{display:block;height:100%;background:var(--ink)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.card{padding:16px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.facts div{background:var(--panel);padding:12px 14px}.facts dt{font-size:12.5px;color:var(--ink3)}.facts dd{font:600 18px var(--mono)}
.btn{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:6px;border:1px solid var(--ink);background:var(--ink);color:#fff;font:500 14px var(--sans);text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent;color:var(--ink);border-color:#c9ced6}.btn.sm{height:28px;font-size:13px;padding:0 10px}
.hero{padding:56px 0 24px;max-width:720px}.hero h1{font-size:40px;line-height:1.1;letter-spacing:-.02em;margin-bottom:14px}
.diff{font:13px/1.6 var(--mono);background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:26px 0}
.diff div{padding:0 14px;white-space:pre}.diff .a{background:var(--add-bg)}.diff .d{background:var(--del-bg)}.diff .c{padding:12px 14px;white-space:normal;font-family:var(--sans);font-size:14px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:#fffdf5}
.empty{padding:28px;text-align:center;color:var(--ink2)}
details summary{cursor:pointer;color:var(--ink2);font-size:14px;margin:6px 0}
@media (max-width:700px){.hide-sm{display:none}td,th{padding:8px 10px}.hero h1{font-size:30px}}
`

export function layout(opts: { title: string; user?: { login: string; avatar_url: string | null } | null; body: Raw }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)} · Diffwise</title><style>${CSS}</style></head><body>
${html`<header class="top"><div class="bar"><a class="logo" href="/"><b><span class="p">+</span><span class="m">−</span></b>diffwise</a>
<nav>${opts.user ? html`<a href="/">Reviews</a><a href="/usage">Usage</a><span class="small muted hide-sm">${opts.user.login}</span>${opts.user.avatar_url ? html`<img class="avatar" src="${opts.user.avatar_url}" alt="">` : ""}<a href="/logout">Sign out</a>` : html`<a href="/login">Sign in with GitHub</a>`}</nav></div></header>`.value}
<main>${opts.body.value}</main></body></html>`
}

export function timeAgo(d: Date | string | null): string {
  if (!d) return "—"
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
