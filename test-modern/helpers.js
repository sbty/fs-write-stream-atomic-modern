'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function makeTestDirectory (name) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), name + '-'))
}

async function removeTestDirectory (directory) {
  await fs.promises.rm(directory, { recursive: true, force: true })
}

function waitForClose (stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.once('close', resolve)
  })
}

async function observeWrite (implementation, directory, options) {
  const target = path.join(directory, 'target.txt')
  const events = []
  const stream = implementation(target, options)
  const observableProperties = Object.keys(stream)
    .filter((key) => key.startsWith('__atomic'))
    .sort()

  let finishContent
  let temporaryExistsAtFinish

  stream.on('open', (fd) => events.push(['open', typeof fd]))
  stream.on('finish', () => {
    events.push(['finish'])
    finishContent = fs.readFileSync(target, 'utf8')
    temporaryExistsAtFinish = fs.existsSync(stream.__atomicTmp)
  })
  stream.on('close', () => events.push(['close']))

  stream.write('first\n')
  stream.end('last\n')
  await waitForClose(stream)

  return {
    events,
    finalContent: fs.readFileSync(target, 'utf8'),
    finishContent,
    temporaryExistsAtFinish,
    temporaryExistsAfterClose: fs.existsSync(stream.__atomicTmp),
    targetMatches: stream.__atomicTarget === target,
    temporaryPrefixMatches: stream.__atomicTmp.startsWith(target + '.'),
    temporarySuffixIsDecimal: /^\d+$/.test(stream.__atomicTmp.slice(target.length + 1)),
    observableProperties,
    writableMethods: ['write', 'end', 'on', 'once', 'emit', 'destroy']
      .every((method) => typeof stream[method] === 'function')
  }
}

async function assertCompleteWriterWon (target, payloads) {
  const result = await fs.promises.readFile(target, 'utf8')
  assert.ok(payloads.includes(result), 'the destination contains one complete writer payload')
}

module.exports = {
  assertCompleteWriterWon,
  makeTestDirectory,
  observeWrite,
  removeTestDirectory,
  waitForClose
}
