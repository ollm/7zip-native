# Architecture and verified constraints

## Integration boundary

The project pins the official `ip7z/7zip` repository as a git submodule at
`vendor/7zip`; the pinned revision is 7-Zip 26.05. Upstream exposes its archive
handlers through the COM-style `IInArchive` interface and `CreateArchiver`
registration exports, not a stable general-purpose C++ library API.

The Linux build compiles upstream's `CPP/7zip/Bundles/Format7zF` bundle.
`Arc_gcc.mak` includes the handlers, codecs, archive interfaces, and
`ArchiveExports.cpp`. The addon calls those exports and uses an in-process
`IInStream` adapter plus an `IArchiveExtractCallback` backed by bounded native
buffers. It does not invoke a command-line executable. The upstream bundle is
a shared library placed beside the Node-API module; archive parsing and
decompression algorithms remain upstream code.

## Threading and ownership

Opening and metadata queries use Node-API `AsyncWorker` tasks on Node's
persistent libuv worker pool. Extraction, streaming, and ranged reads use a
persistent native worker pool; its process-wide size defaults to Node's
available parallelism, capped at 4 based on sample archive benchmarks, and is configurable with
`Archive.concurrency()`.
A process-wide cap of 128 submitted operations bounds the native backlog.

Upstream `IArchive.h` warns against concurrent calls on one `IInArchive`.
Instead, each handle retains independent archive and input-stream contexts.
The first context opens and indexes the archive; additional contexts are
opened lazily up to the configured concurrency and reused by later jobs. A
context is leased to only one operation at a time, and every context has its
own input stream. Creating another context checks the source file's size and
modification time against the values recorded at open.

Completion callbacks and Promise settlement are marshalled back to the
JavaScript thread through Node-API thread-safe functions. Closing a handle
removes it from the public handle table, while submitted jobs retain the
shared archive state until they finish.

Metadata is captured at open and reused by later lookups. Native output
allocations are transferred into Node buffers with N-API finalizers. Full
extraction is limited to 256 MiB per operation and to 512 MiB of native
results pending transfer to JavaScript; ranged reads retain at most 64 MiB per
operation.

Streaming uses the same native worker pool and an independent 7-Zip decoder
context. Its extraction callback emits at most 64 KiB per chunk through a
single-slot thread-safe function and waits for the JavaScript `Readable` to
request more data before continuing. This bounds native in-flight output and
propagates Node stream backpressure; destroying the stream wakes and cancels
the worker at the next output boundary. Cancellation cannot interrupt a
decoder while it is processing internally without producing output.

Folder extraction is sequential and pipes each entry through a Node `Transform`
to a file, so it does not allocate whole entries in memory. It prevalidates
relative paths and collisions, rejects symlinked destination components, and
opens files exclusively rather than overwriting them. Archive link entries are
written as regular data; no filesystem links are created. Streaming defaults
to a 4 GiB output limit per stream or folder operation; callers may set another
limit or explicitly disable it with `maxBytes: null`.

## Partial reads

The output callback discards bytes before the requested offset and retains
only the requested interval. This limits allocation and JavaScript/native
copy cost, but calls the normal handler extraction interface. Many decoders
still need to process earlier or subsequent data, particularly for solid
archives. The implementation therefore makes no random-access complexity or
early-stop guarantee. No decompressed-block cache is present.

## Formats and concurrency findings

Format support comes from the registered handlers in the pinned bundle, not
from extensions alone. The adapter first asks upstream signature callbacks to
identify the format, then also considers matching extensions for handlers
without a signature callback. This is required for 7z, whose handler has no
signature probe, and avoids probing unrelated parsers for arbitrary data. The
selected upstream makefile
includes ZIP, 7z, RAR, TAR, CAB, ISO, WIM, ARJ, LZH, CPIO, GZIP, BZIP2, XZ,
Zstandard, and other handlers in that revision, subject to available decoder
methods. Standalone codecs are not archive handlers. ACE is absent.

The upstream interface does not guarantee simultaneous operations on one
`IInArchive`, so concurrent jobs use separate handler instances rather than
assuming that object is thread-safe. This permits same-handle concurrency for
handlers that support independent archive instances. Separate contexts for
solid archives can decompress shared data more than once; batched extraction
lets a handler process related entries together. There is no solid-block
deduplication cache, so parallelism does not guarantee a speedup.

Passwords are passed to upstream through `ICryptoGetTextPassword` on the
`IArchiveOpenCallback` and `IArchiveExtractCallback` interfaces. The native
archive handle owns its password until close and clears its stored copy during
destruction; the converted password buffer is wiped after use and BSTR
ownership is returned to the upstream handler. AES-256 encrypted ZIP entry
extraction and ranged reads are covered by integration tests; other
password-encryption modes remain format-specific and unverified.

The 7z handler does not provide its own signature probe, so a matching 7z
extension must still be considered even if another handler reports a
signature match. Otherwise, a false-positive signature (the supplied 7z
archive also matched UDF) can prevent the 7z handler from being tried. A
generated 7z archive is covered by the native open-and-extract integration
tests.

## Not yet implemented

This is an end-to-end Linux x64 integration, not the complete
cross-platform product specification. Cancellation of buffered operations,
decompressed-block caching, broader configurable worker/resource limits, CI
coverage outside Linux x64, and prebuild distribution remain incomplete.
Partial reads still rely on the handler's regular extraction work.
