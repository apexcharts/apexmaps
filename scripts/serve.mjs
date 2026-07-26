/**
 * Static file server for the examples.
 *
 * Deliberately dependency-free: `fetch` cannot read `file://` URLs, so the demos
 * need *a* server, and needing one should not mean needing a network install or a
 * Python on PATH. node:http is enough.
 *
 * Usage: `npm run examples` (builds first), or `node scripts/serve.mjs [port]`.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const PORT = Number(process.argv[2] || process.env.PORT || 8080)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer((request, response) => {
  const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)

  // Contain the server to the repository: `..` in a URL must not escape it.
  const target = resolve(join(ROOT, normalize(requested)))
  if (!target.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden')
    return
  }

  let file = target
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')

  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`404 ${requested}\n`)
    return
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  createReadStream(file).pipe(response)
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is in use. Try: node scripts/serve.mjs ${PORT + 1}`)
    process.exit(1)
  }
  throw error
})

server.listen(PORT, () => {
  console.log(`\n  ApexMaps examples: http://localhost:${PORT}/examples/\n`)
  console.log('  Ctrl-C to stop.\n')
})
