# Modernization analysis

## Reference implementation

- Package: `fs-write-stream-atomic@1.0.10`
- Entry point: `index.js`
- Module format: CommonJS
- Export: the `WriteStreamAtomic` function constructor itself
- Invocation: both `WriteStreamAtomic(path, options)` and `new WriteStreamAtomic(path, options)` return a writable instance
- Inheritance: `util.inherits(WriteStreamAtomic, readable-stream.Writable)`

The reference code was inspected before changing production code. Its original
test suite was also run on Windows with Node 22.18.0. `rename-fail`,
`rename-eperm`, and `slow-close` passed. `basic` encountered real Windows
`EPERM` errors while several writers replaced one target, `chown` assumed the
POSIX-only `process.getuid()` API, and `toolong` observed `ENOENT` rather than
the Linux-oriented expected `ENAMETOOLONG`. These are baseline platform issues,
not modernization regressions.

## Observable API and stream behavior

`require('fs-write-stream-atomic')(filename, options)` returns a Writable
stream. The same is true when the export is called with `new`. The object
supports the ordinary Writable methods, events, piping destination behavior,
backpressure, and manual `emit()` inherited from the stream implementation.

The implementation exposes several double-underscore properties. They are not
documented public API, but callers can observe them, so compatibility tests
cover their continued meaning:

- `__isWin`: selected Windows behavior, overridable through `options.isWin`
- `__atomicTarget`: requested destination path
- `__atomicTmp`: generated temporary path
- `__atomicChown`: requested `{ uid, gid }`, if any
- `__atomicClosed`: duplicate-close guard
- `__atomicStream`: underlying filesystem WriteStream

Options are forwarded to the underlying WriteStream. Documented options are
`chown`, `encoding`, `mode`, and `flags`; observable pass-through options
include `autoClose`, `emitClose`, `start`, `highWaterMark`, `decodeStrings`, and
`defaultEncoding`. Unknown options are likewise passed through. The internal
`isWin` option remains accepted.

## Temporary file and atomic replacement sequence

The temporary name is the target plus `.` plus a decimal MurmurHash3 result.
The hash inputs are this module's filename, the process ID, and a monotonically
increasing per-process invocation counter. Different invocations therefore
normally produce different names. `__atomicTmp` makes this observable, so the
MurmurHash dependency is a compatibility boundary.

The successful sequence is:

1. Write every chunk to the temporary file.
2. Wait for the underlying WriteStream to close.
3. Apply optional `chown` to the temporary file.
4. Rename the temporary path over the destination.
5. Emit outer `finish` only after rename succeeds.
6. Cross an asynchronous boundary, then emit outer `close`.

The overridden `emit('finish')` suppresses the Writable implementation's
ordinary finish event and ends the underlying file stream instead. This is the
central compatibility contract: at outer `finish`, the destination is already
in place and complete.

`_write()` forwards to the temporary WriteStream. A `true` return completes the
outer write immediately; a `false` return waits for the underlying `drain`,
preserving backpressure.

## Errors and cleanup

An underlying WriteStream error synchronously attempts to unlink the temporary
file, then emits outer `error` followed by `close`. A `chown` or ordinary rename
failure asynchronously attempts the unlink and then emits `error` followed by
`close`; cleanup errors are ignored and do not replace the original error.
`finish` is not emitted on those paths. `__atomicClosed` prevents the normal
close handler from running twice.

For a Windows `rename` error whose syscall is `rename` and code is `EPERM`, the
implementation hashes the temporary and destination files with SHA-512. Equal
contents are treated as success after temporary cleanup; different contents or
a hash read failure preserve the original `EPERM`. This workaround must remain.
`EXDEV` has no copy fallback and remains an error.

The optional ownership operation occurs only after the temporary stream closes
and before rename. Actual successful `chown` is platform-dependent; its order
and failure path can be tested deterministically with a filesystem stub.

## Atomicity and concurrency

Writers never intentionally stream partial content into the destination. Each
writer uses its own temporary path and competes only at rename time, so the
final content is one complete writer payload rather than mixed chunks. A target
that is overwritten or removed while a write is in progress is replaced when a
writer successfully renames. A symlink at the target path is replaced as a
directory entry; the link target is not opened for the streamed write.

This is atomic replacement in the sense provided by a same-filesystem
`rename()`. It is not an `fsync` durability guarantee, a cross-filesystem copy,
or a promise about network filesystem behavior.

## Dependencies before modernization

Runtime dependencies: 4.

- `graceful-fs`: filesystem calls plus EMFILE/ENFILE queuing and historical
  Windows workarounds
- `iferr`: callback error dispatch
- `imurmurhash`: observable temporary-name generation
- `readable-stream`: Writable implementation and its historical lifecycle

Development dependencies are old `tap`, `standard`, and `rimraf` versions with
a large transitive tree. The modern suite can use `node:test`,
`node:assert/strict`, `fs.mkdtemp`, and `fs.rm` instead.

## Modernization candidates and decisions

- Inline the two small `iferr` branches. This has low compatibility risk and
  avoids a runtime helper.
- Replace `graceful-fs` with `node:fs`. This drops graceful-fs's EMFILE/ENFILE
  queue and must be documented as an intentional difference.
- Evaluate `node:stream.Writable` behind differential tests. Current Writable
  defaults (`autoDestroy` and `emitClose`) differ from the old stream version;
  compatibility may require explicit lifecycle options.
- Retain `imurmurhash`. Replacing it with randomness or a custom implementation
  would change `__atomicTmp` and add avoidable compatibility or maintenance
  risk.
- Keep the function constructor and `util.inherits`; class syntax offers no
  compatibility benefit here.
- Keep the delayed close boundary and Windows EPERM hash workaround.

## Compatibility and security risks

- `readable-stream` v1/v2 and current `node:stream` differ in finish, automatic
  destruction, close emission, invalid chunks, and write-after-end behavior.
- Native `node:fs` does not provide graceful-fs's process-wide descriptor
  exhaustion queue. Heavy workloads can surface `EMFILE`/`ENFILE` sooner.
- Predictable temporary names permit a local actor with directory write access
  to anticipate names. Opening with the caller's default `w` flag can follow an
  attacker-created symlink. Changing names or default flags would be a visible
  behavior change; this risk is documented rather than silently altered.
- Rename replacement and symlink behavior depend on filesystem and platform.
- Windows can return `EPERM` for replacement races. Only the established
  same-content recovery is treated as success.
- `chown` is unavailable or restricted on some platforms.
- A failed unlink can leave a temporary file because upstream deliberately
  ignores cleanup errors.
- No `fsync` is performed, so power-loss durability is not guaranteed.

