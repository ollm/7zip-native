> [!CAUTION]
> This project was generated with the assistance of an LLM and may contain errors. Review and validate it before use, especially in production.

# 7zip-native

Native Node-API bindings for the 7-Zip archive engine. Parsing and extraction through the `Archive` API run in native worker tasks and never invoke `7z`, `7zz`, or another archive executable. The optional comparison benchmark invokes `7zip-bin-full` only as a command-line baseline.

> **Platform status:** the release workflow builds and tests Linux x64/arm64, macOS x64/arm64, and Windows x64/arm64. This checkout has only been verified locally on Linux x64 with Node.js 22; do not treat other targets as tested until the corresponding GitHub Actions runs pass. This remains an early end-to-end implementation, not a claim of full parity with every requirement in the project specification.

## Build from source

```sh
git clone --recurse-submodules https://github.com/ollm/7zip-native.git
cd 7zip-native
npm ci
npm run build
npm test
```

Source builds require a C++17 toolchain, Python 3, Node.js headers (downloaded by `node-gyp`), and the upstream submodule. Linux and macOS use GNU make; Windows builds the upstream bundle with `nmake` and Visual C++ build tools. `npm run build:native` compiles the `Format7zF` handler bundle and Node-API addon, then stages both under `prebuilds/<platform>-<arch>/`. Archive operations never shell out.

The `Build and publish` GitHub Actions workflow builds and runs tests on all six targets for version tags (`v*`) or a manual dispatch. For manual runs, publishing is off by default; enable it only when dispatching the matching `v<package-version>` tag. npm publishing uses trusted publishing (OIDC), so configure this repository as a trusted publisher in npm before publishing. The release matrix uses GitHub-hosted arm64 runners and depends on their availability for the repository.

To update upstream deliberately:

```sh
git submodule update --remote vendor/7zip
git -C vendor/7zip rev-parse HEAD
git add .gitmodules vendor/7zip
```

Review and commit the new gitlink revision. The current submodule is pinned to 7-Zip 26.05 (`b88c6bc09339de32f7d18bbab900686b244f42ba`).

## API

```ts
import {Archive} from '7zip-native';

const archive = await Archive.open('/path/to/file.zip');
const entries = await archive.entries();
const first = entries[0];
if (first && !first.isDirectory) {
	const header = await archive.read(first.id, {offset: 0, length: 64 * 1024});
	const [cover, page] = await archive.extract([first.id, entries[1]!.id]);
}
await archive.close();
```

- `Archive.open(path, {password})` supplies the archive password to upstream handlers for encrypted headers and entries. The password is kept only for this archive handle and is never logged. Passwords are limited to 1 MiB of UTF-8 data.
- `Archive.open(path)` opens and indexes the archive off the event loop.
- `Archive.concurrency()` returns the process-wide native extraction worker count. `Archive.concurrency(n)` sets it; use `0` to reset to the default. The default is Node's available parallelism, capped at 4 workers to avoid oversubscribing typical archive workloads. The setting applies to extraction, streams, and ranged reads.
- `entries()` returns cached metadata. IDs are zero-based and stable for that archive handle.
- `getEntry(idOrPath)` looks up a cached item by ID or full path.
- `extract(id)` returns one `Buffer`; `extract(ids)` returns buffers in request order. The current in-memory limit is 256 MiB per operation and 512 MiB for native extraction results pending transfer to JavaScript.
- `createReadStream(id, {highWaterMark, maxBytes, signal})` returns a Node.js `Readable`. Native output is delivered in bounded 64 KiB chunks on demand; destroying the stream or aborting its signal cancels extraction. A stream is limited to 4 GiB by default; set `maxBytes` to another non-negative integer or `bigint`, or to `null` for no output-size limit.
- `extractToStream(id, writable, options)` pipes an entry to a Node.js `Writable`, respecting backpressure and ending the destination on success. Destination errors and abort signals stop the source stream.
- `extractToFolder(directory, {ids, maxBytes, signal})` extracts all entries (or the selected IDs) sequentially with bounded memory. Its default total output limit is 4 GiB; `maxBytes: null` disables that limit. Existing files are never overwritten. Unsafe paths, path collisions, and symlinked destination components are rejected. Archive links are written as regular file data; the API does not create symbolic or hard links. A failed extraction can leave already-written or partial files in the destination.
- `read(id, {offset, length})` returns only the selected bytes. Ranges accept safe integers or `bigint`; requested reads are limited to 64 MiB.
- `close()` rejects future calls. Work already submitted retains the native state until that work completes.
- Concurrent `extract()` or `read()` calls on one handle use independent, lazily opened decoder contexts and can run in parallel. Solid archives may need to decompress the same earlier data more than once, so parallelism does not guarantee a speedup; use batched extraction to let 7-Zip process related entries together.
- `ArchiveError` exposes a stable `code`; input validation also uses standard `TypeError` and `RangeError`.

Entry metadata includes `id`, `path`, `size`, `compressedSize`, `isDirectory`, `encrypted`, `attributes`, and `crc` when provided by the format. Sizes are `bigint`.

## Formats and limitations

The addon uses the pinned upstream `Format7zF` bundle and its registered handlers rather than a hand-maintained subset. The bundle includes handlers for 7z, ZIP, RAR, TAR, GZIP, BZIP2, XZ, WIM, ISO/UDF, CAB, ARJ, LZH, CPIO, Zstandard, and additional formats enabled by the upstream makefile. An archive's actual extraction still depends on the handler and decoder method being available; unsupported methods, corrupt data, and integrity failures reject extraction.

- RAR decompression is upstream code under its LGPL terms and the unRAR restriction. This package does not create RAR archives or implement the proprietary RAR compression algorithm. Read upstream's unRAR notice before redistribution.
- ACE is not supplied by this 7-Zip revision and is not supported.
- The upstream 7z handler is covered by a native open-and-extract integration test on Linux x64. Support for individual compression methods and encrypted variants still depends on the capabilities of the upstream handler.
- Password callbacks are wired for upstream archive opening and extraction. AES-256 encrypted ZIP entry extraction and ranged reads are tested on Linux x64. Wrong or missing passwords requested by a handler are reported with `ArchiveError.code === 'ERR_ARCHIVE_PASSWORD'`. Encrypted-header behavior and password variants in other formats are not yet verified.
- Partial reads bound memory to the selected range but use the normal `IInArchive::Extract` path. Sequential or solid decoders may decompress preceding data or the whole entry; this is not constant-time random access and does not promise early decoder termination.
- Opening and metadata queries use Node's libuv workers. Extraction and ranged reads use a persistent native worker pool, defaulting to the lesser of 4 and the processors available to Node. `Archive.concurrency(n)` sets the process-wide pool size; submitted native operations remain bounded.
- The addon never calls one `IInArchive` instance concurrently. It retains independent archive and input-stream contexts per handle and lazily creates more as concurrent work needs them. Context creation checks the archive's size and modification time; reopen the archive after changing it.
- Concurrent extraction from a solid archive is safe with independent contexts but may repeat decompression of shared solid blocks. There is no decompressed-block cache, so batching related entries can be faster.
- Cancellation of buffered `extract()`/`read()` requests and decompressed-block caching are not implemented. Streaming and folder extraction have bounded defaults that can be adjusted per operation; buffered methods retain their fixed in-memory limits.
- Cross-platform builds and runtime behavior are not claimed until the corresponding matrix jobs succeed. No performance claim is made without measurements on the target platform.

## Benchmark harness

Run `npm run benchmark -- ./archive.zip` to measure native open/list, first 64 KiB, full extraction, and 1/2/4/8 reads across independent archive handles.

For a direct CLI comparison, install the development dependencies and run:

```sh
npm run benchmark:compare -- --archive "./archive.zip" --entry "chapter/page.jpg" --iterations 20 --read-bytes 65536 --concurrency 4
```

The comparison uses `7zip-bin-full`'s platform binary to measure open/list, single and batched extraction, prefix reads, and a range read. It validates that both backends list the same number of entries and return identical data before reporting median and p95 latency. It also compares extracting every file sequentially and with the selected concurrency in both backends, using the same bounded batches and validating each batch's output. CLI timings include process startup. The CLI has no ranged-read API, so range measurements extract the whole entry to stdout and slice the requested bytes; this is intentionally reported as a baseline limitation, not as an equivalent random-access implementation. The benchmark verifies the complete entry path/type listing, selected entry, and SHA-256 of every operation's output; result byte counts are included where applicable. By default, the benchmark samples 15 times, reads up to 64 KiB, and uses the native pool's configured default concurrency. Set `--iterations`, `--read-bytes`, and `--concurrency` to change these values. Captured output is capped at 256 MiB; full-archive comparison is skipped if an entry exceeds that limit. Use representative archives; smoke-test timings are not performance claims.

Compare extracting every file from one archive sequentially versus the configured native concurrency:

```sh
npm run benchmark:concurrency -- --archive "/path/to/archive.7z" --iterations 20 --concurrencies 1,2,3,4,5,8,16
```

The report includes median and p95 latency, throughput, and speedup. It defaults to the native pool's configured concurrency. Use `--concurrencies 1,2,4,8,16` to compare several worker counts in one run, or `--concurrency` to compare the serial baseline with one selected count. Each worker count processes the same single-entry jobs and fixed memory-limited batches, and the report shows the maximum number of entries that can overlap. Use `--max-files 20` to select evenly spaced entries from a larger archive; the report shows both the sample and archive entry counts. This can prevent excessive repeated decompression when benchmarking solid archives. It reports measurements only and does not claim a speedup.

## Electron

The addon uses Node-API, but its native engine and addon still need to match the target OS and architecture. Electron applications must rebuild from source for the Electron target (for example with `npm rebuild` and the appropriate `--runtime=electron --target=<version>` arguments), or package the matching prebuild from `prebuilds/<platform>-<arch>/`. Keep the engine (`7z.so` or `7z.dll`) beside `7zip_native.node`.

See [docs/architecture.md](./docs/architecture.md) for verified source and concurrency constraints, and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for redistribution requirements.
