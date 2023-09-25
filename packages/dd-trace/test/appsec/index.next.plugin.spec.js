'use strict'
const getPort = require('get-port')
const { spawn, execSync } = require('child_process')
const axios = require('axios')
const { writeFileSync } = require('fs')
const { satisfies } = require('semver')
const path = require('path')

const { DD_MAJOR } = require('../../../../version')
const agent = require('../plugins/agent')

describe('test suite', () => {
  let server
  let port

  const satisfiesStandalone = version => satisfies(version, '>=12.0.0')

  withVersions('next', 'next', DD_MAJOR >= 4 && '>=11', version => {
    const realVersion = require(`${__dirname}/../../../../versions/next@${version}`).version()
    // if (realVersion !== '13.4.13') return

    function initApp (appName) {
      const appDir = path.join(__dirname, 'next', appName)

      before(async function () {
        this.timeout(120 * 1000) // Webpack is very slow and builds on every test run

        const cwd = appDir

        const pkg = require(`${__dirname}/../../../../versions/next@${version}/package.json`)

        if (realVersion.startsWith('10')) {
          return this.skip() // TODO: Figure out why 10.x tests fail.
        }
        delete pkg.workspaces

        // builds fail for next.js 9.5 using node 14 due to webpack issues
        // note that webpack version cannot be set in v9.5 in next.config.js so we do it here instead
        // the link below highlights the initial support for webpack 5 (used to fix this issue) in next.js 9.5
        // https://nextjs.org/blog/next-9-5#webpack-5-support-beta
        if (realVersion.startsWith('9')) pkg.resolutions = { webpack: '^5.0.0' }

        writeFileSync(`${appDir}/package.json`, JSON.stringify(pkg, null, 2))

        // installing here for standalone purposes, copying `nodules` above was not generating the server file properly
        // if there is a way to re-use nodules from somewhere in the versions folder, this `execSync` will be reverted
        execSync('yarn install', { cwd })

        // building in-process makes tests fail for an unknown reason
        execSync('yarn exec next build', {
          cwd,
          env: {
            ...process.env,
            version
          },
          stdio: ['pipe', 'ignore', 'pipe']
        })

        if (satisfiesStandalone(realVersion)) {
          // copy public and static files to the `standalone` folder
          // const publicOrigin = `${appDir}/public`
          const publicDestination = `${appDir}/.next/standalone/public`
          const rulesFileOrigin = `${appDir}/appsec-rules.json`
          const rulesFileDestination = `${appDir}/.next/standalone/appsec-rules.json`

          execSync(`mkdir ${publicDestination}`)
          // execSync(`cp ${publicOrigin}/test.txt ${publicDestination}/test.txt`)
          execSync(`cp ${rulesFileOrigin} ${rulesFileDestination}`)
        }
      })

      after(function () {
        this.timeout(5000)
        const files = [
          'package.json',
          'node_modules',
          '.next',
          'yarn.lock'
        ]
        const paths = files.map(file => `${appDir}/${file}`)
        execSync(`rm -rf ${paths.join(' ')}`)
      })
    }

    const startServer = ({ appName, serverPath }, schemaVersion = 'v0', defaultToGlobalService = false) => {
      const appDir = path.join(__dirname, 'next', appName)

      before(async () => {
        port = await getPort()

        return agent.load('next')
      })

      before(function (done) {
        this.timeout(40000)
        const cwd = appDir

        server = spawn('node', [serverPath], {
          cwd,
          env: {
            ...process.env,
            VERSION: version,
            PORT: port,
            DD_TRACE_AGENT_PORT: agent.server.address().port,
            DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: schemaVersion,
            DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: defaultToGlobalService,
            NODE_OPTIONS: `--require ${appDir}/datadog.js`,
            HOSTNAME: '127.0.0.1'
          }
        })

        server.once('error', done)
        server.stdout.once('data', () => {
          done()
        })
        server.stderr.on('data', chunk => process.stderr.write(chunk))
        server.stdout.on('data', chunk => process.stdout.write(chunk))
      })

      after(async function () {
        this.timeout(5000)

        server.kill()

        await agent.close({ ritmReset: false })
      })
    }

    const tests = [
      {
        appName: 'pages-dir',
        serverPath: 'server'
      }
    ]

    if (satisfies(realVersion, '>=13.2')) {
      tests.push({
        appName: 'app-dir',
        serverPath: '.next/standalone/server.js'
      })
    }

    tests.forEach(({ appName, serverPath }) => {
      describe(`detect threats in ${appName}`, () => {
        initApp(appName)

        startServer({ appName, serverPath })

        it('in request body', function (done) {
          this.timeout(5000)

          function findBodyThreat (traces) {
            let attackFound = false

            traces.forEach(trace => {
              trace.forEach(span => {
                if (span.meta['_dd.appsec.json']) {
                  attackFound = true
                }
              })
            })

            if (attackFound) {
              agent.unsubscribe(findBodyThreat)
              done()
            }
          }

          agent.subscribe(findBodyThreat)
          axios
            .post(`http://127.0.0.1:${port}/api/test`, {
              key: 'testattack'
            }).catch(e => { done(e) })
        })
        if (appName === 'app-dir') {
          it('in request body with .text() function', function (done) {
            this.timeout(5000)

            function findBodyThreat (traces) {
              let attackFound = false

              traces.forEach(trace => {
                trace.forEach(span => {
                  if (span.meta['_dd.appsec.json']) {
                    attackFound = true
                  }
                })
              })

              if (attackFound) {
                agent.unsubscribe(findBodyThreat)
                done()
              }
            }

            agent.subscribe(findBodyThreat)
            axios
              .post(`http://127.0.0.1:${port}/api/test-text`, {
                key: 'testattack'
              }).catch(e => {
                done(e)
              })
          })
        }

        it('in request query', function (done) {
          this.timeout(5000)

          function findBodyThreat (traces) {
            let attackFound = false
            traces.forEach(trace => {
              trace.forEach(span => {
                if (span.meta['_dd.appsec.json']) {
                  attackFound = true
                }
              })
            })
            if (attackFound) {
              agent.unsubscribe(findBodyThreat)
              done()
            }
          }

          axios
            .get(`http://127.0.0.1:${port}/api/test?param=testattack`)
            .catch(e => { done(e) })

          agent.subscribe(findBodyThreat)
        })
      })
    })
  })
})
