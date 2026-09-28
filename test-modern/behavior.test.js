'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const gracefulFs = require('graceful-fs')
const path = require('node:path')
const { test } = require('node:test')
const atomic = require('../index.js')
const {
  assertCompleteWriterWon,
  makeTestDirectory,
  removeTestDirectory,
  waitForClose
} = require('./helpers')

test('finish observes the final content and close follows exactly once', async (t) => {
  const directory = await makeTestDirectory('atomic-lifecycle')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  await fs.promises.writeFile(target, 'old')

  const stream = atomic(target)
  const events = []
  stream.on('finish', () => {
    events.push('finish')
    assert.equal(fs.readFileSync(target, 'utf8'), 'new')
    assert.equal(fs.existsSync(stream.__atomicTmp), false)
  })
  stream.on('close', () => events.push('close'))
  stream.end('new')
  await waitForClose(stream)

  assert.deepEqual(events, ['finish', 'close'])
})

test('concurrent writers leave one complete payload and no temporary files', async (t) => {
  const directory = await makeTestDirectory('atomic-concurrent')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const payloads = Array.from({ length: 10 }, (_, writer) =>
    Array.from({ length: 64 }, (_, line) => `${writer}:${line}\n`).join(''))
  const streams = payloads.map(() => atomic(target))
  const errors = []

  for (const stream of streams) stream.on('error', (error) => errors.push(error))
  await Promise.all(streams.map((stream, index) => {
    stream.end(payloads[index])
    return new Promise((resolve) => stream.once('close', resolve))
  }))

  await assertCompleteWriterWon(target, payloads)
  const leftovers = (await fs.promises.readdir(directory))
    .filter((entry) => entry.startsWith('target.txt.'))
  assert.deepEqual(leftovers, [])

  // Windows can reject a replacement race with EPERM. The compatibility
  // contract is that such a failure is reported and cleaned up, never that it
  // is silently converted into a partial or mixed destination.
  assert.ok(errors.every((error) => process.platform === 'win32' && error.code === 'EPERM'))
})

test('one hundred short-lived streams complete on distinct targets', async (t) => {
  const directory = await makeTestDirectory('atomic-many-targets')
  t.after(() => removeTestDirectory(directory))
  const streams = Array.from({ length: 100 }, (_, index) => {
    const target = path.join(directory, `${index}.txt`)
    const stream = atomic(target)
    stream.end(String(index))
    return { index, target, stream }
  })

  await Promise.all(streams.map(({ stream }) => waitForClose(stream)))
  for (const { index, target, stream } of streams) {
    assert.equal(await fs.promises.readFile(target, 'utf8'), String(index))
    assert.equal(fs.existsSync(stream.__atomicTmp), false)
  }
})

test('large writes honor backpressure and retain every byte', async (t) => {
  const directory = await makeTestDirectory('atomic-large')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'large.bin')
  const stream = atomic(target, { highWaterMark: 32 })
  const chunk = crypto.randomBytes(64 * 1024)
  const expected = Buffer.concat(Array.from({ length: 48 }, () => chunk))
  let offset = 0
  let sawBackpressure = false

  while (offset < expected.length) {
    const next = expected.subarray(offset, offset + chunk.length)
    offset += next.length
    if (!stream.write(next)) {
      sawBackpressure = true
      await new Promise((resolve) => stream.once('drain', resolve))
    }
  }
  stream.end()
  await waitForClose(stream)

  assert.equal(sawBackpressure, true)
  assert.deepEqual(crypto.createHash('sha256').update(await fs.promises.readFile(target)).digest(),
    crypto.createHash('sha256').update(expected).digest())
})

test('rename failure preserves the original error, cleans up, and skips finish', async (t) => {
  const directory = await makeTestDirectory('atomic-rename-error')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const originalRename = fs.rename
  const originalGracefulRename = gracefulFs.rename
  const expected = Object.assign(new Error('rename failed'), { code: 'EXDEV', syscall: 'rename' })
  const events = []

  fs.rename = function (source, destination, callback) {
    callback(expected)
  }
  gracefulFs.rename = fs.rename
  t.after(() => {
    fs.rename = originalRename
    gracefulFs.rename = originalGracefulRename
  })

  const stream = atomic(target, { isWin: false })
  stream.on('error', (error) => events.push(['error', error]))
  stream.on('finish', () => events.push(['finish']))
  stream.on('close', () => events.push(['close']))
  stream.end('data')
  await new Promise((resolve) => stream.once('close', resolve))

  assert.deepEqual(events, [['error', expected], ['close']])
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
  assert.equal(fs.existsSync(target), false)
})

test('Windows EPERM with equal content is treated as success', async (t) => {
  const directory = await makeTestDirectory('atomic-eperm-equal')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const originalRename = fs.rename
  const originalGracefulRename = gracefulFs.rename
  const events = []

  fs.rename = function (source, destination, callback) {
    fs.copyFile(source, destination, (copyError) => {
      if (copyError) return callback(copyError)
      callback(Object.assign(new Error('simulated Windows replacement race'), {
        code: 'EPERM',
        syscall: 'rename'
      }))
    })
  }
  gracefulFs.rename = fs.rename
  t.after(() => {
    fs.rename = originalRename
    gracefulFs.rename = originalGracefulRename
  })

  const stream = atomic(target, { isWin: true })
  stream.on('error', (error) => events.push(['error', error.code]))
  stream.on('finish', () => events.push(['finish']))
  stream.on('close', () => events.push(['close']))
  stream.end('same bytes')
  await waitForClose(stream)

  assert.deepEqual(events, [['finish'], ['close']])
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
})

test('Windows EPERM with different content emits error and no finish', async (t) => {
  const directory = await makeTestDirectory('atomic-eperm-different')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  await fs.promises.writeFile(target, 'different bytes')
  const originalRename = fs.rename
  const originalGracefulRename = gracefulFs.rename
  const events = []

  fs.rename = function (source, destination, callback) {
    callback(Object.assign(new Error('simulated Windows replacement race'), {
      code: 'EPERM',
      syscall: 'rename'
    }))
  }
  gracefulFs.rename = fs.rename
  t.after(() => {
    fs.rename = originalRename
    gracefulFs.rename = originalGracefulRename
  })

  const stream = atomic(target, { isWin: true })
  stream.on('error', (error) => events.push(['error', error.code]))
  stream.on('finish', () => events.push(['finish']))
  stream.on('close', () => events.push(['close']))
  stream.end('new bytes')
  await new Promise((resolve) => stream.once('close', resolve))

  assert.deepEqual(events, [['error', 'EPERM'], ['close']])
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'different bytes')
})

test('chown happens after temporary close and before rename', async (t) => {
  if (typeof process.getuid !== 'function') return t.skip('POSIX ownership APIs are unavailable')

  const directory = await makeTestDirectory('atomic-chown')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const originalChown = fs.chown
  const originalRename = fs.rename
  const originalGracefulChown = gracefulFs.chown
  const originalGracefulRename = gracefulFs.rename
  const operations = []

  fs.chown = function (file, uid, gid, callback) {
    operations.push('chown')
    originalChown(file, uid, gid, callback)
  }
  fs.rename = function (source, destination, callback) {
    operations.push('rename')
    originalRename(source, destination, callback)
  }
  gracefulFs.chown = fs.chown
  gracefulFs.rename = fs.rename
  t.after(() => {
    fs.chown = originalChown
    fs.rename = originalRename
    gracefulFs.chown = originalGracefulChown
    gracefulFs.rename = originalGracefulRename
  })

  const stream = atomic(target, { chown: { uid: process.getuid(), gid: process.getgid() } })
  stream.end('owned')
  await waitForClose(stream)
  assert.deepEqual(operations, ['chown', 'rename'])
})

test('open failure and overly long paths report error before close', async (t) => {
  const directory = await makeTestDirectory('atomic-open-errors')
  t.after(() => removeTestDirectory(directory))
  const targets = [
    path.join(directory, 'missing', 'target.txt'),
    path.join(directory, 'x'.repeat(1000))
  ]

  for (const target of targets) {
    const events = []
    const stream = atomic(target)
    stream.on('error', (error) => events.push(['error', error.code]))
    stream.on('finish', () => events.push(['finish']))
    stream.on('close', () => events.push(['close']))
    stream.end('data')
    await new Promise((resolve) => stream.once('close', resolve))

    assert.equal(events[0][0], 'error')
    assert.ok(['ENOENT', 'ENAMETOOLONG'].includes(events[0][1]))
    assert.deepEqual(events.at(-1), ['close'])
    assert.equal(events.some(([name]) => name === 'finish'), false)
  }
})

test('the target stays untouched while the temporary file is open', async (t) => {
  const directory = await makeTestDirectory('atomic-visibility')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  await fs.promises.writeFile(target, 'old content')
  const stream = atomic(target)

  await new Promise((resolve, reject) => {
    stream.once('open', resolve)
    stream.once('error', reject)
  })
  assert.equal(fs.existsSync(stream.__atomicTmp), true)
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'old content')

  stream.end('new content')
  await waitForClose(stream)
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'new content')
})

test('external overwrite and deletion do not mix with the streamed payload', async (t) => {
  const directory = await makeTestDirectory('atomic-external-mutation')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  await fs.promises.writeFile(target, 'initial')
  const stream = atomic(target)

  await new Promise((resolve, reject) => {
    stream.once('open', resolve)
    stream.once('error', reject)
  })
  stream.write('complete ')
  await fs.promises.writeFile(target, 'external overwrite')
  await fs.promises.unlink(target)
  await fs.promises.writeFile(target, 'second external overwrite')
  stream.end('payload')
  await waitForClose(stream)

  assert.equal(await fs.promises.readFile(target, 'utf8'), 'complete payload')
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
})

test('a delayed underlying close delays outer finish and close', async (t) => {
  const directory = await makeTestDirectory('atomic-slow-close')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const originalEmit = fs.WriteStream.prototype.emit
  let physicalCloseCompleted = false

  fs.WriteStream.prototype.emit = function (event) {
    if (event !== 'close') return originalEmit.apply(this, arguments)
    const stream = this
    const args = arguments
    setTimeout(function () {
      physicalCloseCompleted = true
      originalEmit.apply(stream, args)
    }, 50)
    return true
  }
  t.after(() => { fs.WriteStream.prototype.emit = originalEmit })

  const stream = atomic(target)
  stream.on('finish', () => assert.equal(physicalCloseCompleted, true))
  stream.on('close', () => assert.equal(physicalCloseCompleted, true))
  stream.end('delayed')
  await waitForClose(stream)
})

test('chown failure cleans up and emits the error before close', async (t) => {
  const directory = await makeTestDirectory('atomic-chown-error')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const originalChown = fs.chown
  const expected = Object.assign(new Error('chown failed'), { code: 'EPERM', syscall: 'chown' })
  const events = []

  fs.chown = function (file, uid, gid, callback) { callback(expected) }
  t.after(() => { fs.chown = originalChown })

  const stream = atomic(target, { chown: { uid: 1, gid: 1 } })
  stream.on('error', (error) => events.push(['error', error]))
  stream.on('finish', () => events.push(['finish']))
  stream.on('close', () => events.push(['close']))
  stream.end('data')
  await new Promise((resolve) => stream.once('close', resolve))

  assert.deepEqual(events, [['error', expected], ['close']])
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
  assert.equal(fs.existsSync(target), false)
})

test('a hash read failure preserves the original Windows EPERM', async (t) => {
  const directory = await makeTestDirectory('atomic-eperm-hash-error')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const originalRename = fs.rename
  const originalCreateReadStream = fs.createReadStream
  const expected = Object.assign(new Error('rename failed'), { code: 'EPERM', syscall: 'rename' })
  const events = []

  fs.rename = function (source, destination, callback) { callback(expected) }
  fs.createReadStream = function () {
    const stream = originalCreateReadStream(path.join(directory, 'missing-hash-input'))
    return stream
  }
  t.after(() => {
    fs.rename = originalRename
    fs.createReadStream = originalCreateReadStream
  })

  const stream = atomic(target, { isWin: true })
  stream.on('error', (error) => events.push(['error', error]))
  stream.on('close', () => events.push(['close']))
  stream.end('data')
  await new Promise((resolve) => stream.once('close', resolve))

  assert.deepEqual(events, [['error', expected], ['close']])
  assert.equal(fs.existsSync(stream.__atomicTmp), false)
})

test('cleanup failure does not replace the operation error', async (t) => {
  const directory = await makeTestDirectory('atomic-cleanup-error')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const originalRename = fs.rename
  const originalUnlink = fs.unlink
  const expected = Object.assign(new Error('rename failed'), { code: 'EXDEV', syscall: 'rename' })
  const events = []

  fs.rename = function (source, destination, callback) { callback(expected) }
  fs.unlink = function (file, callback) {
    callback(Object.assign(new Error('cleanup failed'), { code: 'EACCES' }))
  }
  t.after(() => {
    fs.rename = originalRename
    fs.unlink = originalUnlink
  })

  const stream = atomic(target, { isWin: false })
  stream.on('error', (error) => events.push(['error', error]))
  stream.on('close', () => events.push(['close']))
  stream.end('data')
  await new Promise((resolve) => stream.once('close', resolve))

  assert.deepEqual(events, [['error', expected], ['close']])
  assert.equal(fs.existsSync(stream.__atomicTmp), true)
})

test('mode, flags, and isWin options remain observable', async (t) => {
  const directory = await makeTestDirectory('atomic-options')
  t.after(() => removeTestDirectory(directory))
  const target = path.join(directory, 'target.txt')
  const stream = atomic(target, { mode: 0o600, flags: 'a', isWin: false, unknownOption: true })

  assert.equal(stream.__isWin, false)
  stream.end('replacement')
  await waitForClose(stream)
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'replacement')
  if (process.platform !== 'win32') {
    assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o600)
  }
})

test('renaming over a symlink replaces the link, not its referent', async (t) => {
  const directory = await makeTestDirectory('atomic-symlink')
  t.after(() => removeTestDirectory(directory))
  const referent = path.join(directory, 'referent.txt')
  const target = path.join(directory, 'target.txt')
  await fs.promises.writeFile(referent, 'referent')

  try {
    await fs.promises.symlink(referent, target, 'file')
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('creating symlinks requires additional Windows privileges')
    throw error
  }

  const stream = atomic(target)
  stream.end('replacement')
  await waitForClose(stream)

  assert.equal((await fs.promises.lstat(target)).isSymbolicLink(), false)
  assert.equal(await fs.promises.readFile(target, 'utf8'), 'replacement')
  assert.equal(await fs.promises.readFile(referent, 'utf8'), 'referent')
})

test('an error without a listener retains EventEmitter process-failure behavior', () => {
  const modulePath = path.resolve(__dirname, '..', 'index.js')
  const script = [
    `const atomic = require(${JSON.stringify(modulePath)})`,
    `const stream = atomic(${JSON.stringify(path.join('missing-parent', 'target.txt'))})`,
    "stream.end('data')"
  ].join(';')
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ENOENT/)
})
