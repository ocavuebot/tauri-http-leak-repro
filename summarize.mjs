// Prints a Markdown table from `results/*.json`.
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? 'results')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

const rows = []
for (const file of files) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
  const name = file.replace(/\.json$/, '')
  if (r.gc) continue
  if (r.fatal) {
    rows.push(`| ${name} | fatal: ${r.fatal.split('\n')[0]} |`)
    continue
  }
  const snap = Object.fromEntries(r.snapshots.map((s) => [s.label, s]))
  const before = snap.before
  const cells = (s) => {
    const res = s.resources.ReqwestResponse ?? 0
    const app = s.clientSockets.app ?? 0
    const webkit = s.clientSockets['com.apple.WebKit.Networking'] ?? 0
    return `${res} / ${app} / ${webkit} / ${s.server?.open}`
  }
  const errors = Object.entries(r.loop.errors)
    .map(([k, v]) => `${v}× ${k}`)
    .join('; ')
  const rss = (s) => Math.round((s.rssKb - before.rssKb) / 1024)
  rows.push(
    [
      name,
      `${r.loop.ok}/${r.config.n}`,
      r.loop.perRequestMs.mean,
      r.loop.totalMs,
      snap.end.server ? `${snap.end.server.accepted - before.server.accepted}` : "n/a",
      cells(snap.end),
      cells(snap.idle),
      snap['after-reload'] ? cells(snap['after-reload']) : '',
      `${rss(snap.end)} / ${rss(snap.idle)}`,
      `${snap.end.fds - before.fds}`,
      snap.idle.collectedResponses,
      errors,
    ]
      .map((c) => ` ${c} `)
      .join('|')
      .replace(/^/, '|')
      .replace(/$/, '|'),
  )
}

console.log(
  '| scenario | ok | ms/req | total ms | new TCP conns | end: Resp / app sock / WebKit sock / server open | idle | after reload | RSS Δ MB end / idle | app FD Δ | GC-collected | errors |',
)
console.log('|' + ' --- |'.repeat(12))
for (const row of rows) console.log(row)
