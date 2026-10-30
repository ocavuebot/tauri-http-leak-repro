// The same GC cycle probe, outside Tauri, in Playwright's Chromium and WebKit.
//   node browser/gc-cycle.mjs   (needs `playwright` resolvable, e.g. NODE_PATH)
import { chromium, webkit } from 'playwright'

const probe = async (n) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const chunk = () => new Uint8Array(8)
  const variants = {
    'no-cycle': () => new Response(new ReadableStream({ pull: (c) => (c.enqueue(chunk()), c.close()) })),
    'cycle-direct': () => {
      let res
      res = new Response(new ReadableStream({ pull: (c) => (c.enqueue(chunk()), c.close(), void res) }))
      return res
    },
    'cycle-bind': () => {
      const res = new Response(new ReadableStream({ pull: (c) => (c.enqueue(chunk()), c.close(), void bound) }))
      const bound = res.clone.bind(res)
      return res
    },
    'cycle-property': () => {
      const res = new Response(new ReadableStream({ pull: (c) => (c.enqueue(chunk()), c.close()) }))
      res.self = { res }
      return res
    },
  }
  const counts = {}
  const keep = []
  for (const [name, make] of Object.entries(variants)) {
    for (const mode of ['unread', 'read']) {
      const key = `${name}/${mode}`
      counts[key] = 0
      const reg = new FinalizationRegistry(() => counts[key]++)
      keep.push(reg)
      for (let i = 0; i < n; i++) {
        const res = make()
        if (mode === 'read') await res.arrayBuffer()
        reg.register(res, i)
      }
    }
  }
  for (let round = 0; round < 3; round++) {
    if (globalThis.gc) globalThis.gc()
    for (let r = 0; r < 5; r++) {
      let junk = []
      for (let i = 0; i < 40; i++) junk.push(new Array(250_000).fill({ i }))
      junk = null
      await sleep(200)
    }
    await sleep(3000)
  }
  return counts
}

for (const [name, type, args] of [
  ['chromium', chromium, ['--js-flags=--expose-gc']],
  ['webkit', webkit, []],
]) {
  const browser = await type.launch({ args })
  const page = await browser.newPage()
  await page.goto('about:blank')
  const counts = await page.evaluate(probe, 300)
  console.log(name, browser.version(), JSON.stringify(counts))
  await browser.close()
}
