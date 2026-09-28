'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { test } = require('node:test')
const upstream = require('fs-write-stream-atomic')
const modern = require('../index.js')
const {
  makeTestDirectory,
  observeWrite,
  removeTestDirectory,
  waitForClose
} = require('./helpers')

test('modern implementation matches the upstream successful lifecycle', async (t) => {
  const upstreamDirectory = await makeTestDirectory('atomic-diff-upstream')
  const modernDirectory = await makeTestDirectory('atomic-diff-modern')
  t.after(() => Promise.all([
    removeTestDirectory(upstreamDirectory),
    removeTestDirectory(modernDirectory)
  ]))

  const upstreamResult = await observeWrite(upstream, upstreamDirectory)
  const modernResult = await observeWrite(modern, modernDirectory)
  assert.deepEqual(modernResult, upstreamResult)
})

test('modern implementation matches upstream for encoding and mixed chunks', async (t) => {
  const cases = [
    { name: 'utf8', chunks: ['snowman: ', '☃'], options: { encoding: 'utf8' } },
    { name: 'utf16le', chunks: ['alpha', 'β'], options: { encoding: 'utf16le' } },
    { name: 'mixed', chunks: ['text:', Buffer.from('buffer')], options: {} }
  ]

  const results = []
  for (const implementation of [upstream, modern]) {
    const directory = await makeTestDirectory('atomic-diff-encoding')
    t.after(() => removeTestDirectory(directory))
    const implementationResults = []

    for (const scenario of cases) {
      const target = path.join(directory, scenario.name + '.txt')
      const stream = implementation(target, scenario.options)
      for (const chunk of scenario.chunks.slice(0, -1)) stream.write(chunk)
      stream.end(scenario.chunks.at(-1))
      await waitForClose(stream)
      implementationResults.push(await fs.promises.readFile(target))
    }
    results.push(implementationResults)
  }

  // Comparing bytes rather than decoded strings also covers the UTF-16LE and
  // Buffer forwarding details.
  assert.deepEqual(results[1], results[0])
})

test('pipe completes only after the destination has been moved into place', async (t) => {
  for (const implementation of [upstream, modern]) {
    const directory = await makeTestDirectory('atomic-diff-pipe')
    t.after(() => removeTestDirectory(directory))
    const target = path.join(directory, 'piped.txt')
    const destination = implementation(target)
    const events = []

    destination.on('pipe', () => events.push('pipe'))
    destination.on('unpipe', () => events.push('unpipe'))
    destination.on('finish', () => {
      events.push('finish')
      assert.equal(fs.readFileSync(target, 'utf8'), 'one-two-three')
    })
    destination.on('close', () => events.push('close'))

    Readable.from(['one-', 'two-', 'three']).pipe(destination)
    await waitForClose(destination)
    assert.deepEqual(events, ['pipe', 'finish', 'unpipe', 'close'])
  }
})

async function observeDestroy (implementation, withError) {
  const directory = await makeTestDirectory('atomic-diff-destroy')
  const target = path.join(directory, 'target.txt')
  const stream = implementation(target)
  const events = []

  stream.on('open', () => events.push('open'))
  stream.on('error', (error) => events.push(['error', error.message]))
  stream.on('finish', () => events.push('finish'))
  stream.on('close', () => events.push('close'))
  stream.destroy(withError ? new Error('destroyed intentionally') : undefined)
  await new Promise((resolve) => stream.once('close', resolve))

  const result = {
    events,
    targetExists: fs.existsSync(target),
    temporaryExists: fs.existsSync(stream.__atomicTmp)
  }
  await removeTestDirectory(directory)
  return result
}

test('destroy and destroy(error) retain upstream finalization semantics', async () => {
  for (const withError of [false, true]) {
    assert.deepEqual(
      await observeDestroy(modern, withError),
      await observeDestroy(upstream, withError)
    )
  }
})

async function observeWriteAfterEnd (implementation) {
  const directory = await makeTestDirectory('atomic-diff-after-end')
  const target = path.join(directory, 'target.txt')
  const stream = implementation(target)
  const events = []

  stream.on('error', (error) => events.push(['error', error.name, error.code || null]))
  stream.on('finish', () => events.push(['finish']))
  stream.on('close', () => events.push(['close']))
  stream.end('accepted')
  stream.write('rejected', (error) => {
    events.push(['callback', error ? error.code || error.name : null])
  })
  await new Promise((resolve) => stream.once('close', resolve))

  const result = {
    events,
    content: await fs.promises.readFile(target, 'utf8'),
    temporaryExists: fs.existsSync(stream.__atomicTmp)
  }
  await removeTestDirectory(directory)
  return result
}

test('write after end matches upstream error and completion behavior', async () => {
  assert.deepEqual(
    await observeWriteAfterEnd(modern),
    await observeWriteAfterEnd(upstream)
  )
})
