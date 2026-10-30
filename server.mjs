// Test server. Counts TCP connections so that a leaked response shows up on
// the server side too.
//
//   GET /body?size=N  200 with N bytes
//   GET /empty        204
//
// Stats are on a second port, so that reading them does not add a connection.
import http from 'node:http'

export function startServer({ port = 0, keepAliveTimeout = 5000 } = {}) {
  const stats = { accepted: 0, open: 0, maxOpen: 0, requests: 0, reused: 0 }
  const chunks = new Map()

  const server = http.createServer((req, res) => {
    stats.requests++
    if (req.socket.requests++ > 0) stats.reused++
    const url = new URL(req.url, 'http://x')
    const headers = {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    }
    if (url.pathname === '/empty') {
      res.writeHead(204, headers).end()
      return
    }
    const size = Number(url.searchParams.get('size') ?? 1024)
    let body = chunks.get(size)
    if (!body) chunks.set(size, (body = Buffer.alloc(size, 'a')))
    res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': size })
    res.end(body)
  })
  server.keepAliveTimeout = keepAliveTimeout
  server.on('connection', (socket) => {
    socket.requests = 0
    stats.accepted++
    stats.open++
    stats.maxOpen = Math.max(stats.maxOpen, stats.open)
    socket.on('close', () => stats.open--)
  })

  const statsServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify(stats))
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      statsServer.listen(0, '127.0.0.1', () => {
        resolve({
          port: server.address().port,
          statsPort: statsServer.address().port,
          stats,
          close: () => {
            server.closeAllConnections()
            server.close()
            statsServer.close()
          },
        })
      })
    })
  })
}
