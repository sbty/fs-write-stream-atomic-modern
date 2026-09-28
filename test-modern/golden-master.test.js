'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { Writable } = require('readable-stream')
const upstream = require('fs-write-stream-atomic')
const {
  makeTestDirectory,
  observeWrite,
  removeTestDirectory,
  waitForClose
} = require('./helpers')

test('upstream 1.0.10 golden master: construction and successful lifecycle', async (t) => {
  const directory = await makeTestDirectory('atomic-upstream-golden')
  t.after(() => removeTestDirectory(directory))

  const called = upstream(path.join(directory, 'called.txt'))
  const constructed = new upstream(path.join(directory, 'constructed.txt'))

  assert.ok(called instanceof upstream)
  assert.ok(constructed instanceof upstream)
  assert.ok(called instanceof Writable)
  called.destroy()
  constructed.destroy()

  const observation = await observeWrite(upstream, directory)
  assert.deepEqual(observation, {
    events: [['open', 'number'], ['finish'], ['close']],
    finalContent: 'first\nlast\n',
    finishContent: 'first\nlast\n',
    temporaryExistsAtFinish: false,
    temporaryExistsAfterClose: false,
    targetMatches: true,
    temporaryPrefixMatches: true,
    temporarySuffixIsDecimal: true,
    observableProperties: [
      '__atomicChown',
      '__atomicClosed',
      '__atomicStream',
      '__atomicTarget',
      '__atomicTmp'
    ],
    writableMethods: true
  })
})

test('upstream 1.0.10 golden master: open failure emits error before close', async (t) => {
  const directory = await makeTestDirectory('atomic-upstream-error')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'missing', 'target.txt')
  const events = []
  const stream = upstream(target)

  stream.on('error', (error) => events.push(['error', error.code, error.syscall]))
  stream.on('finish', () => events.push(['finish']))
  stream.on('close', () => events.push(['close']))
  stream.end('data')
  await new Promise((resolve) => stream.once('close', resolve))

  assert.deepEqual(events, [['error', 'ENOENT', 'open'], ['close']])
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
})

test('upstream 1.0.10 golden master: invocation changes the temporary name', async (t) => {
  const directory = await makeTestDirectory('atomic-upstream-names')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const first = upstream(target)
  const second = upstream(target)

  assert.notEqual(first.__atomicTmp, second.__atomicTmp)
  assert.equal(first.__atomicTarget, target)
  assert.equal(second.__atomicTarget, target)

  first.end('first')
  await waitForClose(first)
  second.end('second')
  await waitForClose(second)
})
