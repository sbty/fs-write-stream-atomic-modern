'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const project = path.resolve(__dirname, '..')
// Invoke npm through Node instead of spawning `npm.cmd`. The latter requires a
// shell on Windows, while npm exposes the exact CLI entry point to lifecycle
// scripts through npm_execpath on every supported platform.
const npmCli = process.env.npm_execpath || path.join(
  path.dirname(process.execPath),
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js'
)
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-tarball-smoke-'))
const packageDirectory = path.join(temporaryRoot, 'package')
const consumerDirectory = path.join(temporaryRoot, 'consumer')

try {
  fs.mkdirSync(packageDirectory)
  fs.mkdirSync(consumerDirectory)

  const packOutput = execFileSync(process.execPath, [npmCli,
    'pack',
    '--json',
    '--pack-destination', packageDirectory
  ], { cwd: project, encoding: 'utf8' })
  const [{ filename }] = JSON.parse(packOutput)
  const tarball = path.join(packageDirectory, filename)

  fs.writeFileSync(path.join(consumerDirectory, 'package.json'), JSON.stringify({
    private: true,
    dependencies: {
      'fs-write-stream-atomic-modern': `file:${tarball}`
    }
  }, null, 2))

  execFileSync(process.execPath, [npmCli,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund'
  ], { cwd: consumerDirectory, stdio: 'inherit' })

  const atomic = require(path.join(
    consumerDirectory,
    'node_modules',
    'fs-write-stream-atomic-modern'
  ))
  const target = path.join(consumerDirectory, 'written.txt')
  const stream = atomic(target)
  const events = []

  stream.on('finish', function () {
    events.push('finish')
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello from tarball')
    assert.equal(fs.existsSync(stream.__atomicTmp), false)
  })
  stream.on('close', function () {
    events.push('close')
    assert.deepEqual(events, ['finish', 'close'])
    assert.equal(fs.existsSync(stream.__atomicTmp), false)
    console.log('tarball smoke test passed')
  })
  stream.on('error', function (error) { throw error })
  stream.end('hello from tarball')
} finally {
  process.on('exit', function () {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })
}
