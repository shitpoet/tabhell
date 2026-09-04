#!/usr/bin/env node
import * as http from 'node:http'
import { WebSocketServer } from 'ws'
import * as bridge from './bridge.js'
import * as spec from './commands.js'

const PING_MS = 20_000
const REQUEST_TIMEOUT_MS = 30_000
const BIND_RETRY_MS = 100
const BIND_RETRIES = 20

const port = spec.resolvePort(process.env)
const assemble = bridge.makeAssembler()
const pending = {}

let counter = 0
let buffer = Buffer.alloc(0)

function log(...args) {
  console.error('[tabhell]', ...args)
}

function toExtension(msg) {
  for (const envelope of bridge.fragment(msg)) {
    const data = Buffer.from(JSON.stringify(envelope))
    const header = Buffer.alloc(4)
    header.writeUInt32LE(data.length, 0)
    process.stdout.write(Buffer.concat([header, data]))
  }
}

function ask(action, params) {
  return new Promise((resolve) => {
    const id = 'r' + (++counter)
    const timer = setTimeout(() => {
      delete pending[id]
      resolve({ ok: false, result: 'extension did not answer in time' })
    }, REQUEST_TIMEOUT_MS)

    pending[id] = (reply) => {
      clearTimeout(timer)
      resolve(reply)
    }
    toExtension({ id, action, params })
  })
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0)
    if (buffer.length >= 4 + length) {
      const envelope = JSON.parse(buffer.subarray(4, 4 + length).toString())
      buffer = buffer.subarray(4 + length)
      const msg = assemble(envelope)
      if (msg && pending[msg.id]) {
        const settle = pending[msg.id]
        delete pending[msg.id]
        settle({ ok: msg.ok, result: msg.result })
      }
    } else {
      break
    }
  }
})

// Chrome closes our stdin when the extension reloads or the worker is torn down.
// Exiting releases the port for the host Chrome spawns next.
process.stdin.on('end', () => {
  log('extension went away, exiting')
  setTimeout(() => process.exit(0), 50)
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const action = url.pathname.slice(1)
  const command = spec.commands[action]

  if (command === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, result: 'unknown command: ' + action }))
    return
  }

  const params = spec.parseParams(url.searchParams, command.params)
  const reply = await ask(action, params)

  if (reply.ok && action === 'getFavicon' && params.format === 'binary') {
    const bytes = Buffer.from(reply.result, 'base64')
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length })
    res.end(bytes)
    return
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(JSON.stringify(reply))
})

const wss = new WebSocketServer({ server })

// ws re-emits the http server's errors here, and an unhandled 'error' would
// take the process down before the bind retry below gets a chance.
wss.on('error', (e) => log('ws:', String(e)))

wss.on('connection', (socket) => {
  socket.on('message', async (raw) => {
    let msg = null
    try {
      msg = JSON.parse(raw.toString())
    } catch (e) {
      socket.send(JSON.stringify({ ok: false, result: 'bad json: ' + String(e) }))
      return
    }
    const reply = await ask(msg.action, msg.params || {})
    socket.send(JSON.stringify({ id: msg.id, ...reply }))
  })
})

// A dying host can still hold the port when Chrome spawns our replacement.
function listen(attempt) {
  server.listen(port, '127.0.0.1')
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < BIND_RETRIES) {
      setTimeout(() => listen(attempt + 1), BIND_RETRY_MS)
    } else {
      log('listen failed:', String(e))
      process.exit(1)
    }
  })
}

listen(0)
server.once('listening', () => log('listening on 127.0.0.1:' + port, 'DISPLAY=' + (process.env.DISPLAY || '')))

// Traffic on the port is what keeps the MV3 service worker from being evicted.
setInterval(() => ask('ping', {}), PING_MS)
