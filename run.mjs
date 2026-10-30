// Runs every scenario in a fresh app process and writes `results/<name>.json`.
//
//   node run.mjs              # all scenarios
//   node run.mjs plugin-204 https   # only scenarios whose name contains a filter
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server.mjs'

const BIN = process.env.REPRO_BIN ?? '/tmp/tauri-http-leak-target/release/http-leak-repro'
const OUT_DIR = path.resolve(process.env.REPRO_OUT ?? 'results')
const N = Number(process.env.REPRO_N ?? 300)
const IDLE_MS = 8000 // longer than the server's 5 s keep-alive timeout

const SMALL = '/body?size=1024'
const LARGE = '/body?size=262144'

const scenarios = []
for (const [size, p] of [['1k', SMALL], ['256k', LARGE]]) {
  for (const client of ['native', 'plugin']) {
    for (const mode of ['read', 'unread', 'cancel']) {
      scenarios.push({ name: `${client}-${mode}-${size}`, client, mode, path: p })
    }
  }
}
for (const client of ['native', 'plugin']) {
  scenarios.push({ name: `${client}-204`, client, mode: 'unread', path: '/empty' })
  scenarios.push({ name: `${client}-204-read`, client, mode: 'read', path: '/empty' })
}
scenarios.push({ name: 'plugin-unread-1k-reload', client: 'plugin', mode: 'unread', path: SMALL, reload: true })
// Many servers keep idle connections open much longer than Node's 5 s default.
for (const client of ['native', 'plugin']) {
  scenarios.push({ name: `ka60-${client}-unread-256k`, client, mode: 'unread', path: LARGE, keepAliveTimeout: 60_000 })
}
// A macOS app started from Finder or the Dock gets launchd's soft limit of 256 file descriptors.
for (const client of ['native', 'plugin']) {
  scenarios.push({ name: `fd256-${client}-unread-1k`, client, mode: 'unread', path: SMALL, n: 400, ulimit: 256 })
  scenarios.push({ name: `fd256-${client}-204`, client, mode: 'unread', path: '/empty', n: 400, ulimit: 256 })
  scenarios.push({ name: `fd256-${client}-unread-256k`, client, mode: 'unread', path: LARGE, n: 400, ulimit: 256 })
}
// Control for GC: `Response` objects over a JS stream, with no IPC.
for (const mode of ['read', 'unread']) {
  scenarios.push({ name: `synthetic-${mode}`, client: 'synthetic', mode, path: SMALL })
}
scenarios.push({ name: 'gc-bisect', client: 'gc-bisect', mode: 'unread', path: SMALL, timeoutMs: 600_000 })
scenarios.push({ name: 'gc-iife', client: 'gc-bisect', mode: 'unread', path: SMALL, only: 'iife', timeoutMs: 600_000 })
scenarios.push({ name: 'gc-cycle', client: 'gc-bisect', mode: 'unread', path: SMALL, only: 'cycle', timeoutMs: 600_000 })
scenarios.push({ name: 'gc-replica', client: 'gc-bisect', mode: 'unread', path: SMALL, only: 'replica', timeoutMs: 600_000 })
// Real HTTPS: the plugin builds a new `reqwest::Client` (and so a new TLS session) per request.
for (const client of ['native', 'plugin']) {
  scenarios.push({
    name: `https-${client}-read`,
    client,
    mode: 'read',
    url: 'https://cdn.jsdelivr.net/npm/react@18.3.1/package.json',
    n: 30,
    warmupUrl: 'https://cdn.jsdelivr.net/npm/react@18.3.1/package.json',
  })
}

const filters = process.argv.slice(2)
fs.mkdirSync(OUT_DIR, { recursive: true })

for (const s of scenarios) {
  if (filters.length && !filters.some((f) => s.name.includes(f))) continue
  const server = await startServer({ keepAliveTimeout: s.keepAliveTimeout })
  const out = path.join(OUT_DIR, `${s.name}.json`)
  fs.rmSync(out, { force: true })
  const cfg = {
    name: s.name,
    client: s.client,
    mode: s.mode,
    url: s.url ?? `http://127.0.0.1:${server.port}${s.path}`,
    n: s.n ?? N,
    port: server.port,
    statsPort: server.statsPort,
    idleMs: IDLE_MS,
    reload: s.reload ?? false,
    ulimit: s.ulimit ?? null,
    keepAliveTimeout: s.keepAliveTimeout ?? 5000,
    warmupUrl: s.warmupUrl,
    only: s.only,
    out,
  }
  const cmd = s.ulimit ? `ulimit -n ${s.ulimit}; exec "${BIN}"` : `exec "${BIN}"`
  const started = Date.now()
  const code = await new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], {
      env: { ...process.env, REPRO_CONFIG: JSON.stringify(cfg) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stdout.on('end', () => {
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
      if (line) fs.writeFileSync(out, JSON.stringify(JSON.parse(line.slice(7)), null, 2))
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), s.timeoutMs ?? 180_000)
    child.on('close', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  server.close()
  const ok = fs.existsSync(out)
  console.log(`${s.name}: exit ${code}, ${ok ? 'ok' : 'NO RESULT'}, ${Date.now() - started} ms`)
}
