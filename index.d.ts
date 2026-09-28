import { Writable, WritableOptions } from 'node:stream'

interface ChownOptions {
  uid: number
  gid: number
}

interface AtomicWriteStreamOptions extends WritableOptions {
  chown?: ChownOptions
  encoding?: BufferEncoding
  mode?: number
  flags?: string
  isWin?: boolean
}

declare const WriteStreamAtomic: {
  (path: string, options?: AtomicWriteStreamOptions): Writable
  new (path: string, options?: AtomicWriteStreamOptions): Writable
}

export = WriteStreamAtomic
