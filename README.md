# fs-write-stream-atomic-modern

`fs-write-stream-atomic-modern` is a compatibility-focused maintained fork of
[`fs-write-stream-atomic`](https://github.com/npm/fs-write-stream-atomic).

It provides the same CommonJS Writable-stream API for supported modern Node.js
versions, while replacing safe-to-remove legacy dependencies and modernizing
the tests, type declarations, and cross-platform CI.

## Install

```console
npm install fs-write-stream-atomic-modern
```

Node.js 22 or newer is required.

## Usage

```js
const fs = require('node:fs')
const fsWriteStreamAtomic = require('fs-write-stream-atomic-modern')

const destination = fsWriteStreamAtomic('output.txt')
fs.createReadStream('input.txt').pipe(destination)

destination.on('finish', () => {
  // The temporary file has closed and the rename has completed. At this point
  // output.txt contains all bytes accepted by this stream.
})
```

The export works both as a function and as a constructor:

```js
const first = fsWriteStreamAtomic('first.txt')
const second = new fsWriteStreamAtomic('second.txt')
```

### `fsWriteStreamAtomic(filename[, options])`

- `filename` accepts the path values supported by `fs.WriteStream`.
- `options.chown` may contain numeric `uid` and `gid` values. Ownership is
  applied to the temporary file before rename.
- `options.encoding` defaults to `utf8`.
- `options.mode` defaults to `0o666`.
- `options.flags` defaults to `w`.
- Other Writable and filesystem WriteStream options are forwarded for
  compatibility.

The returned object is a Writable stream. It supports `write()`, `end()`,
`pipe()` as a destination, `destroy()`, and the normal EventEmitter methods.

## Completion events

This package intentionally delays its outer `finish` event. The sequence on a
successful write is:

```text
write temporary file
→ close temporary file
→ optional chown
→ rename temporary file over destination
→ finish
→ asynchronous boundary
→ close
```

Therefore the destination is ready when `finish` fires. On an operation error,
the stream attempts to remove its temporary file and emits `error` before
`close`; it does not emit `finish`.

## What “atomic” means here

The package writes beside the destination and then asks the filesystem to
replace the destination with `rename()`. On filesystems where same-filesystem
rename replacement is atomic, readers do not observe a partially streamed
destination.

This is not a power-loss durability guarantee. The package does not call
`fsync()`, does not provide a cross-filesystem copy fallback, and cannot extend
local rename guarantees to every network filesystem.

## Migrating without changing imports

After this package is published, npm aliases can let an application retain its
old `require('fs-write-stream-atomic')` calls:

```json
{
  "dependencies": {
    "fs-write-stream-atomic": "npm:fs-write-stream-atomic-modern@^1.0.10"
  }
}
```

See [COMPATIBILITY.md](COMPATIBILITY.md) for observable behavior and known
differences, and [MODERNIZATION.md](MODERNIZATION.md) for the dependency and
tooling decisions.

## Credits and license

The original implementation is by Isaac Z. Schlueter and contributors. This
fork retains the ISC license and original copyright notice.
