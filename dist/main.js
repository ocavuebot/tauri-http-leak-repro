// Runs one scenario from `REPRO_CONFIG`, then writes the result and quits.
//
// config: {
//   client: 'native' | 'plugin' | 'synthetic',
//   mode: 'read' | 'unread' | 'cancel',
//   url: string, n: number, port, statsPort, idleMs, out,
//   reload?: boolean   // reload the page after the loop, then measure again
// }
const { invoke } = window.__TAURI__.core
const pluginFetch = window.__TAURI__.http.fetch

const logEl = document.getElementById('log')
function log(message) {
  logEl.textContent += message + '\n'
  void invoke('log', { message })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(cfg, label) {
  const [resources, snap] = await Promise.all([
    invoke('resources'),
    invoke('snapshot', { port: cfg.port, statsPort: cfg.statsPort }),
  ])
  const ipcCallbacks = window.__TAURI_INTERNALS__.callbacks.size
  return { label, at: Math.round(performance.now()), resources, ipcCallbacks, ...snap }
}

// Allocate and drop a lot of memory, so that JavaScriptCore runs a full GC.
async function gcPressure() {
  for (let round = 0; round < 5; round++) {
    let junk = []
    for (let i = 0; i < 40; i++) junk.push(new Array(250_000).fill({ i }))
    junk = null
    await sleep(200)
  }
}

let collected = 0
const registry = new FinalizationRegistry(() => collected++)

async function runLoop(cfg) {
  const doFetch = {
    native: (u) => fetch(u, { cache: 'no-store' }),
    plugin: (u) => pluginFetch(u),
    // Control: a `Response` over a JS `ReadableStream`, with no IPC at all.
    synthetic: async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(1024))
            c.close()
          },
        }),
      ),
  }[cfg.client]
  const latencies = []
  const errors = {}
  let ok = 0
  const start = performance.now()
  for (let i = 0; i < cfg.n; i++) {
    const t0 = performance.now()
    try {
      const res = await doFetch(cfg.url)
      if (cfg.mode === 'read') await res.arrayBuffer()
      else if (cfg.mode === 'cancel') await res.body?.cancel()
      // 'unread': drop `res` on the floor, as `if (!res.ok) return` does.
      registry.register(res, i)
      ok++
    } catch (error) {
      const key = String(error?.message ?? error).slice(0, 200)
      errors[key] = (errors[key] ?? 0) + 1
    }
    latencies.push(performance.now() - t0)
    if ((i + 1) % 100 === 0) log(`${i + 1}/${cfg.n}`)
  }
  const totalMs = performance.now() - start
  const sorted = [...latencies].sort((a, b) => a - b)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  return {
    ok,
    errors,
    totalMs: Math.round(totalMs),
    perRequestMs: {
      mean: +(totalMs / cfg.n).toFixed(3),
      p50: +pct(50).toFixed(3),
      p90: +pct(90).toFixed(3),
      p99: +pct(99).toFixed(3),
      max: +sorted[sorted.length - 1].toFixed(3),
    },
  }
}

// Which part of the plugin's `Response` keeps it alive? Each variant builds
// `n` responses like the plugin does, minus one piece, and drops them.
const GC_VARIANTS = {
  // A `ReadableStream` with a sync `pull`.
  'stream-sync-pull': () => new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(8)), c.close()) })),
  // `pull` that awaits a timer.
  'stream-async-pull': () =>
    new Response(new ReadableStream({ pull: async (c) => { await sleep(0); c.enqueue(new Uint8Array(8)); c.close() } })),
  // `pull` that awaits an IPC call, as the plugin does.
  'stream-ipc-pull': () =>
    new Response(new ReadableStream({ pull: async (c) => { await invoke('resources'); c.enqueue(new Uint8Array(8)); c.close() } })),
  // A null body with the plugin's own `url`, `headers` and `clone` properties (like the plugin's 204).
  'null-body-patched': () => patch(new Response(null, { status: 204 })),
  // A sync stream with the plugin's own properties.
  'stream-patched': () =>
    patch(new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(8)), c.close()) }))),
  // The stream's own closure refers back to the `Response`: a cycle through the body.
  'cycle-direct': () => {
    let res
    res = new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(8)), c.close(), void res) }))
    return res
  },
  // The same cycle, the way the plugin makes it: a bound `clone` in the scope that `pull` closes over.
  'cycle-bind': () => {
    const res = new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(8)), c.close(), void bound) }))
    const bound = res.clone.bind(res)
    return res
  },
  // Control: a cycle through a plain property, not through the body stream.
  'cycle-property': () => {
    const res = new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(8)), c.close()) }))
    res.self = { res }
    return res
  },
  // Only the `clone` override.
  'stream-clone-only': () =>
    patch(new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(8)), c.close()) })), { clone: true }),
  // Only the `url` and `headers` overrides.
  'stream-url-headers-only': () =>
    patch(new Response(new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(8)), c.close()) })), { clone: false }),
}

function patch(res, { clone = true } = {}) {
  Object.defineProperty(res, 'url', { value: 'http://x/', writable: false })
  Object.defineProperty(res, 'headers', { value: new Headers(), writable: false })
  if (clone) {
    const originalClone = res.clone.bind(res)
    Object.defineProperty(res, 'clone', { value: () => originalClone() })
  }
  return res
}


// A copy of `fetch` from @tauri-apps/plugin-http 2.8.3 (dist-js/index.js),
// reduced to a GET, with switches to drop one piece at a time.
async function replicaFetch(url, opts = {}) {
  const { start = true, cancel = true, patchProps = true, ipcPull = true, prelude = true } = opts
  if (prelude) {
    const req = new Request(url)
    await req.arrayBuffer()
  }
  const rid = await invoke('plugin:http|fetch', {
    clientConfig: { method: 'GET', url, headers: [], data: null },
  })
  const { status, statusText, headers: responseHeaders, rid: responseRid } = await invoke('plugin:http|fetch_send', { rid })
  let bodyDropped = false
  const dropBody = () => {
    if (bodyDropped) return Promise.resolve()
    bodyDropped = true
    return invoke('plugin:http|fetch_cancel_body', { rid: responseRid }).catch(() => {})
  }
  const readChunk = async (controller) => {
    if (!ipcPull) {
      controller.enqueue(new Uint8Array(8))
      controller.close()
      return
    }
    let data
    try {
      data = await invoke('plugin:http|fetch_read_body', { rid: responseRid })
    } catch (e) {
      controller.error(e)
      void dropBody()
      return
    }
    const dataUint8 = new Uint8Array(data)
    const lastByte = dataUint8[dataUint8.byteLength - 1]
    const actualData = dataUint8.slice(0, dataUint8.byteLength - 1)
    if (lastByte === 1) {
      controller.close()
      return
    }
    controller.enqueue(actualData)
  }
  const source = { pull: (controller) => readChunk(controller) }
  if (start) source.start = (controller) => {}
  if (cancel) source.cancel = () => void dropBody()
  const res = new Response(new ReadableStream(source), { status, statusText })
  if (patchProps) patch(res)
  return res
}


// Loads the plugin's own `api-iife.js` (copied from the crate), with optional
// text edits, into a private `window` so that it does not replace the real one.
async function loadIife(edits = []) {
  let text = await (await fetch('plugin-iife.js')).text()
  for (const [from, to] of edits) {
    if (!text.includes(from)) throw new Error(`edit not found: ${from}`)
    text = text.replace(from, to)
  }
  const fakeWindow = { __TAURI__: { core: window.__TAURI__.core } }
  new Function('window', text)(fakeWindow)
  return fakeWindow.__TAURI__.http.fetch
}

const IIFE_EDITS = {
  verbatim: [],
  'no-clone-patch': [['return Object.defineProperty(A,"clone",', 'return A;Object.defineProperty(A,"clone",']],
  'no-headers-patch': [[',Object.defineProperty(A,"headers",{value:new Headers(g),writable:!1})', '']],
  'no-url-patch': [['Object.defineProperty(A,"url",{value:b,writable:!1}),', '']],
  'no-start': [['start:e=>{a?.addEventListener("abort",()=>{e.error(r),m()})},', '']],
  'no-abort-listener': [['a?.addEventListener("abort",()=>{f()});', '']],
}
// Everything after `new Response(...)`: the `url`, `headers` and `clone` patches.
const PATCHES =
  'Object.defineProperty(A,"url",{value:b,writable:!1}),Object.defineProperty(A,"headers",{value:new Headers(g),writable:!1});const P=A.clone.bind(A);return Object.defineProperty(A,"clone",{value:()=>{const e=P();return Object.defineProperty(e,"url",{value:b,writable:!1}),Object.defineProperty(e,"headers",{value:new Headers(g),writable:!1}),e}}),A'
IIFE_EDITS['all-patches'] = [[PATCHES, 'return A']]
IIFE_EDITS['all-five'] = [...IIFE_EDITS['all-patches'], ...IIFE_EDITS['no-start'], ...IIFE_EDITS['no-abort-listener']]
// Keep `url` and `headers`, drop only the `clone` override and its `P=A.clone.bind(A)`.
IIFE_EDITS['no-clone-bind'] = [['const P=A.clone.bind(A);return Object.defineProperty(A,"clone",{value:()=>{const e=P();return Object.defineProperty(e,"url",{value:b,writable:!1}),Object.defineProperty(e,"headers",{value:new Headers(g),writable:!1}),e}}),A', 'return A']]

async function gcBisect(cfg) {
  // One registry per batch. Finalizers can run late, during a later batch's GC,
  // so count them all again after several GC rounds at the end.
  const counts = {}
  const variants = {
    ...GC_VARIANTS,
    // The real thing, for comparison.
    'plugin-fetch-1k': () => pluginFetch(cfg.url),
    'plugin-fetch-204': () => pluginFetch(cfg.url.replace(/\/body.*/, '/empty')),
    'native-fetch-1k': () => fetch(cfg.url),
    'replica-full': () => replicaFetch(cfg.url),
    'replica-no-start': () => replicaFetch(cfg.url, { start: false }),
    'replica-no-cancel': () => replicaFetch(cfg.url, { cancel: false }),
    'replica-no-patch': () => replicaFetch(cfg.url, { patchProps: false }),
    'replica-no-ipc-pull': () => replicaFetch(cfg.url, { ipcPull: false }),
    'replica-no-prelude': () => replicaFetch(cfg.url, { prelude: false }),
  }
  for (const [name, edits] of Object.entries(IIFE_EDITS)) {
    const f = await loadIife(edits)
    variants[`iife-${name}`] = () => f(cfg.url)
  }
  if (cfg.only) for (const k of Object.keys(variants)) if (!k.startsWith(cfg.only)) delete variants[k]
  for (const [name, make] of Object.entries(variants)) {
    for (const mode of ['unread', 'read']) {
      const key = `${name}/${mode}`
      counts[key] = 0
      const reg = new FinalizationRegistry(() => counts[key]++)
      for (let i = 0; i < cfg.n; i++) {
        const res = await make()
        if (mode === 'read') await res.arrayBuffer()
        reg.register(res, i)
      }
      // Keep the registry alive until the end.
      registries.push(reg)
    }
  }
  const rounds = []
  for (let round = 0; round < 3; round++) {
    await gcPressure()
    await sleep(3000)
    rounds.push({ ...counts })
    log(`gc round ${round}: ${JSON.stringify(counts)}`)
  }
  return rounds
}
const registries = []

async function main() {
  const cfg = await invoke('config')
  const saved = sessionStorage.getItem('repro')
  if (saved) {
    // Second load, after `location.reload()`.
    sessionStorage.removeItem('repro')
    const result = JSON.parse(saved)
    await sleep(500)
    result.snapshots.push(await measure(cfg, 'after-reload'))
    await invoke('finish', { result })
    return
  }

  log(`scenario ${JSON.stringify(cfg)}`)
  if (cfg.client === 'gc-bisect') {
    await invoke('finish', { result: { config: cfg, gc: await gcBisect(cfg) } })
    return
  }
  // Warm up both paths once, so that the first-request cost does not skew the loop.
  if (cfg.warmup !== false) {
    for (const f of [fetch, pluginFetch]) {
      const res = await f(cfg.warmupUrl ?? `http://127.0.0.1:${cfg.port}/body?size=16`)
      await res.arrayBuffer()
      log(`warmed up ${f === fetch ? 'native' : 'plugin'}`)
    }
  }
  const snapshots = [await measure(cfg, 'before')]
  log('measured')
  const loop = await runLoop(cfg)
  snapshots.push(await measure(cfg, 'end'))
  await gcPressure()
  await sleep(cfg.idleMs)
  await gcPressure()
  snapshots.push({ ...(await measure(cfg, 'idle')), collectedResponses: collected })

  const result = { config: cfg, userAgent: navigator.userAgent, loop, snapshots }
  if (cfg.reload) {
    sessionStorage.setItem('repro', JSON.stringify(result))
    location.reload()
    return
  }
  await invoke('finish', { result })
}

main().catch(async (error) => {
  log(`fatal: ${error?.stack ?? error}`)
  const cfg = await invoke('config')
  await invoke('finish', { result: { fatal: String(error?.stack ?? error) } })
})
