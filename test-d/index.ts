import atomic = require('..')
import { Writable } from 'node:stream'

const stream: Writable = atomic('output.txt', {
  encoding: 'utf8',
  mode: 0o600,
  flags: 'w',
  highWaterMark: 16,
  chown: { uid: 1, gid: 1 },
  isWin: false
})

stream.write('hello')
stream.end()

const constructed: Writable = new atomic('constructed.txt')
constructed.end(Buffer.from('hello'))
