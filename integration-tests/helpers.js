'use strict'

const express = require('express')
const bodyParser = require('body-parser')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const EventEmitter = require('events')
const { fork } = require('child_process')
const http = require('http')

class FakeAgent extends EventEmitter {
  constructor (port = 0) {
    super()
    this.port = port
  }

  async start () {
    const app = express()
    app.use(bodyParser.raw({ limit: Infinity, type: 'application/msgpack' }))
    app.put('/v0.4/traces', (req, res) => {
      if (req.body.length === 0) return res.status(200).send()
      res.status(200).send({ rate_by_service: { 'service:,env:': 1 } })
      this.emit('message', {
        headers: req.headers,
        payload: msgpack.decode(req.body, { codec })
      })
    })

    return new Promise((resolve, reject) => {
      const timeoutObj = setTimeout(() => {
        reject(new Error('agent timed out starting up'))
      }, 10000)
      this.server = http.createServer(app).listen(this.port, () => {
        this.port = this.server.address().port
        clearTimeout(timeoutObj)
        resolve(this)
      })
    })
  }

  stop () {
    this.server.close()
  }

  assertMessageReceived (fn, timeout) {
    timeout = timeout || 5000
    let resultResolve
    let resultReject
    const errors = []

    const timeoutObj = setTimeout(() => {
      resultReject([...errors, new Error('timeout')])
    }, timeout)

    const resultPromise = new Promise((resolve, reject) => {
      resultResolve = () => {
        clearTimeout(timeoutObj)
        resolve()
      }
      resultReject = (e) => {
        clearTimeout(timeoutObj)
        reject(e)
      }
    })

    const messageHandler = msg => {
      try {
        fn(msg)
        resultResolve()
        this.removeListener('message', messageHandler)
      } catch (e) {
        errors.push(e)
      }
    }
    this.on('message', messageHandler)

    return resultPromise
  }
}

function spawnProc (filename, options = {}) {
  const proc = fork(filename, options)
  return new Promise((resolve, reject) => {
    proc.on('message', ({ port }) => {
      proc.url = `http://localhost:${port}`
      resolve(proc)
    }).on('error', reject)
  })
}

async function curl (url) {
  if (typeof url === 'object') {
    if (url.then) {
      return curl(await url)
    }
    url = url.url
  }
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const bufs = []
      res.on('data', d => bufs.push(d))
      res.on('end', () => {
        res.body = Buffer.concat(bufs).toString('utf8')
        resolve(res)
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function curlAndAssertMessage (agent, procOrUrl, fn, timeout) {
  const resultPromise = agent.assertMessageReceived(fn, timeout)
  await curl(procOrUrl)
  return resultPromise
}

module.exports = {
  FakeAgent,
  spawnProc,
  curl,
  curlAndAssertMessage
}
