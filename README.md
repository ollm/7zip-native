> [!CAUTION]
> This project was generated primarily by an LLM and may contain errors. Review and validate it before use, especially in production.

# 7zip-native

### Current version `26.06`
Upstream 7-Zip archive engine from https://github.com/ip7z/7zip/

Native Node-API bindings for the 7-Zip archive engine. Use a typed, Promise-based Node.js API to inspect archives, read entry data, stream large files, or extract entries without launching `7z`, `7zz`, or another archive executable.

The package includes the native addon and the matching 7-Zip engine for each supported target. Compression and decompression are provided by the upstream 7-Zip implementation.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [API](#api)
  - [`Archive.open()`](#archiveopen)
  - [`archive.entries()`](#archiveentries)
  - [`archive.getEntry()`](#archivegetentry)
  - [`archive.extractToFolder()`](#archiveextracttofolder)
  - [`archive.extract()`](#archiveextract)
  - [`archive.read()`](#archiveread)
  - [`archive.createReadStream()`](#archivecreatereadstream)
  - [`archive.extractToStream()`](#archiveextracttostream)
  - [`Archive.create()`](#archivecreate)
  - [`Archive.concurrency()`](#archiveconcurrency)
  - [`archive.close()`](#archiveclose)
- [Errors and limits](#errors-and-limits)
- [Supported formats](#supported-formats)
- [Platform support](#platform-support)
- [Electron](#electron)
- [Build from source](#build-from-source)
- [Benchmarks](#benchmarks)
- [License](#license)

## Installation

```sh
npm install 7zip-native
```

The package requires Node.js 18.14.0 or newer.

## Quick start

```ts
import {Archive} from '7zip-native';

const archive = await Archive.open('./file.zip');

try
{
	const entries = await archive.entries();
	const file = await archive.getEntry('image.jpg');

	if(file && !file.isDirectory)
	{
		const preview = await archive.read(file.path, {offset: 0, length: 64 * 1024});
		const image = await archive.extract(file.path);
		console.log(entries.length, preview.length, image.length);
	}
}
finally
{
	await archive.close();
}
```

The package supports both ES modules and CommonJS:

```js
// ES module
import {Archive} from '7zip-native';

// CommonJS
const {Archive} = require('7zip-native');
```

## API

### `Archive.open()`

Opens an archive from a filesystem path and indexes its metadata asynchronously.

```ts
const archive = await Archive.open('./archive.7z', {password: 'secret'});
```

`Archive.open()` accepts these options:

- `password`: Optional; not set by default. Passed to the upstream handler if it requests a password. It is held for the lifetime of the archive handle, is not logged, and is limited to 1 MiB of UTF-8 data.
- `deflateBufferSize`: Input buffer size in bytes for Deflate extraction. Default: `32 KiB`; accepts integers from `4 KiB` through `2 MiB`. It is stored per archive and applied to each extraction, so different open archives can use different values.

```ts
const archive = await Archive.open('./archive.zip', {deflateBufferSize: 256 * 1024});
```

### `archive.entries()`

```ts
const entries = await archive.entries();
```

`entries()` returns cached metadata. Entry IDs are zero-based and stable for the lifetime of the opened archive.

Each entry includes:

| Property | Type | Description |
| --- | --- | --- |
| `id` | `number` | Stable ID within this opened archive |
| `path` | `string` | Entry path, using `/` separators |
| `extractedPath` | `string` | Relative output path after platform-specific filename normalization; Windows-invalid characters are replaced |
| `size` | `bigint` | Uncompressed size |
| `compressedSize` | `bigint` | Compressed size |
| `isDirectory` | `boolean` | Whether the entry is a directory |
| `encrypted` | `boolean` | Whether the entry is encrypted |
| `attributes` | `number` | Format-specific attributes |
| `crc` | `number \| undefined` | CRC when supplied by the format |

### `archive.getEntry()`

```ts
const byPath = await archive.getEntry('folder/page.jpg');
const byId = await archive.getEntry(0);
```

`getEntry()` returns `undefined` if the ID or full path does not match.

All entry-targeted methods accept either the entry's numeric `id` or its exact archive-internal `path`: `extract()`, `read()`, `createReadStream()`, and `extractToStream()`. Batch `extract()` calls can mix IDs and paths. For folder extraction, use either the `ids` or `paths` option; omit both to extract every entry.

### `archive.extractToFolder()`

```ts
await archive.extractToFolder('./unpacked', {
	paths: ['chapter/page1.jpg', 'chapter/page2.jpg'], // alternatively, use ids
	overwrite: true,
	onExtract: ({entry, outputPath, percent}) => {
		console.log(`Extracted ${entry.path} to ${outputPath} (${percent}%)`);
	},
	maxBytes: 2n * 1024n * 1024n * 1024n,
	signal: abortController.signal,
});
```

`extractToFolder()` accepts these options:

- `ids`: Entry IDs to extract. Default: all entries are selected when both `ids` and `paths` are omitted.
- `paths`: Exact, original archive paths to extract, using `/` separators. Cannot be combined with `ids`.
- `concurrency`: Maximum number of native extraction batches this call runs simultaneously. Default: `1`; accepts integers from `1` to `128` and is capped at the process-wide native worker-pool concurrency. This does not change `Archive.concurrency()`. For 7z archives, values above `1` are generally not recommended because the format may use multiple threads internally.
- `overwrite`: Default: `false`, so existing files are not overwritten. When `true`, an existing regular file is removed before the new file is written directly to its final path. A failed extraction can leave the destination missing.
- `onExtract`: Optional; no callback is invoked by default. Called after each regular file has been completely written and closed; it does not wait for the rest of the batch. Concurrent extraction can make event order differ from selection order. Receives `{entry, outputPath, percent}`, where `percent` is the completed-file count divided by the total selected regular files. `entry` retains the original archive metadata and `outputPath` is the final destination path.
- `maxBytes`: Maximum total uncompressed output size. Default: `4 GiB`; set to `null` to disable the limit.
- `signal`: Optional `AbortSignal`; omitted by default. Cancellation stops new files from starting, cancels or waits for active extractions, cleans temporary replacement files, and rejects the call.

Each native extraction call receives a batch of entry IDs and output paths. The addon queues disk writes asynchronously while 7-Zip continues extracting later entries; `onExtract` runs after that file's queued writes have completed and the file is closed. File contents are not streamed through Node.js or Electron. The `extractToFolder()` promise resolves after all `onExtract` callbacks have run.

On Windows only, unsupported filename characters (including control characters), trailing dots/spaces in each destination component, and reserved device names are normalized for the output path; selectors and entry metadata remain unchanged. On Linux and macOS, platform-supported filename characters are preserved. Unsafe archive paths, path collisions, symlinked destination components, and symlink or non-file targets are rejected. Archive links are written as regular file data; the API does not create symbolic or hard links. If extraction fails partway through, files already written (or partially written) may remain in the destination.

### `archive.extract()`

```ts
const image = await archive.extract(entry.id); // Buffer
const sameImage = await archive.extract(entry.path); // Buffer
const pages = await archive.extract([page1.id, page2.path]); // Buffer[]
```

Paths use `/` separators. Batch results are returned in the same order as the requested selectors; duplicate entries are rejected. A missing path rejects with `ERR_INVALID_ENTRY`. A buffered extraction is limited to 256 MiB per entry, with a 512 MiB cap on native results pending transfer to JavaScript. For large entries, use a stream or extract to a folder instead.

### `archive.read()`

```ts
const header = await archive.read(entry.path, {
	offset: 0,
	length: 64 * 1024,
});
const headers = await archive.read([first.path, second.id], {
	offset: 0,
	length: 64 * 1024,
});
const prefixes = await archive.read([
	{entry: first.path, offset: 0, length: 8192},
	{entry: second.id, offset: 0, length: 64},
]);
```

`read()` accepts one entry selector or a batch. For a selector array, the same range is used for every entry; use `ReadRequest[]` to specify a different range per entry. Both batch forms return buffers in request order and run as one native extraction operation. The selector-array form preserves repeated selectors; `ReadRequest[]` must contain unique entries.

`read()` accepts these options:

- `offset`: Byte position at which to start reading. Default: `0`; accepts a non-negative safe integer or `bigint`.
- `length`: Number of bytes to return. Required; has no default. Accepts a non-negative safe integer or `bigint`. A range read is limited to 64 MiB.

A range read returns only the requested bytes. A batch is limited to 64 MiB per entry and 256 MiB total output. It uses the handler's normal extraction path, however, so a sequential or solid format may still need to decompress preceding data or the whole entry. It is not guaranteed to be constant-time random access.

### `archive.createReadStream()`

Create a standard Node.js `Readable` for a large entry:

```ts
for await (const chunk of archive.createReadStream(entry.path, {
	highWaterMark: 256 * 1024,
	signal: abortController.signal,
}))
{
	// Consume each Buffer chunk before requesting more data.
}
```

`createReadStream()` accepts these options:

- `highWaterMark`: Readable buffer threshold in bytes. Default: Node.js's `Readable` default; accepts integers from 1 byte to 16 MiB.
- `maxBytes`: Maximum number of output bytes. Default: `4 GiB`; accepts a non-negative `number` or `bigint`, or `null` to disable the limit.
- `signal`: Optional `AbortSignal` that cancels extraction; omitted by default.

The native engine emits bounded 64 KiB chunks and waits for stream demand, preserving backpressure. Destroying the stream or aborting its signal cancels extraction at the next output boundary.

### `archive.extractToStream()`

Pipe directly to a Node.js `Writable`:

```ts
import {createWriteStream} from 'node:fs';

await archive.extractToStream(entry.path, createWriteStream('./page.jpg'), {
	signal: abortController.signal,
});
```

`extractToStream()` accepts the same `highWaterMark`, `maxBytes`, and `signal` options as `createReadStream()`. It respects backpressure and ends the destination when extraction succeeds. A destination error, early close, or abort rejects the Promise.

### `Archive.create()`

```ts
await Archive.create('./archive.zip', [
	{sourcePath: './image.jpg', path: 'image.jpg'},
	{sourcePath: './file.txt', path: 'file.txt'},
]);
```

`Archive.create()` accepts regular source files and their desired archive-internal paths:

- `sourcePath`: Filesystem path of the regular file to add.
- `path`: Desired path inside the archive, using `/` separators.

The source file's modification time is stored in the archive.

It also accepts these options:

- `format`: Archive format. Default: inferred as ZIP from `.zip`, 7z from `.7z`, TAR from `.tar`, or WIM from `.wim`. Set to `'zip'`, `'7z'`, `'tar'`, or `'wim'` to use another output extension.
- `compressionLevel`: Default: `5`; accepts integers from `0` to `9` and applies only to ZIP and 7z. TAR is uncompressed; WIM uses the upstream handler's default settings.
- `overwrite`: Default: `false`. When `true`, an existing output file is replaced after the new archive has been written.

Duplicate, absolute, or traversal paths are rejected, but platform-supported filename characters such as trailing spaces are preserved in the archive-internal path. The output is first written to a temporary file beside the destination, then installed atomically, so an existing file is preserved if archive creation fails. Archive creation runs in the bounded native worker pool and does not launch a 7-Zip executable.

### `Archive.concurrency()`

```ts
const current = Archive.concurrency();
Archive.concurrency(8);
Archive.concurrency(0); // reset to the default
```

`Archive.concurrency(value?)` controls the process-wide native worker pool used by extraction, streams, and range reads:

- `value`: Omit to read the current setting. Set to an integer from 1 to 128 to configure the worker count, or `0` to restore the default.

The default is the lesser of 4 and the parallelism available to Node.js.

Concurrent operations on one archive use independent decoder contexts rather than calling one 7-Zip archive object simultaneously. This is safe for handlers that support independent contexts, but it does not guarantee a speedup. Solid archives may decompress shared data more than once; batching related entries may be faster.

### `archive.close()`

Call `close()` when finished. It rejects future API calls; operations already submitted keep the native state alive until they finish.

```ts
await archive.close();
```

## Errors and limits

Invalid argument types and values throw standard `TypeError` or `RangeError`. Archive and extraction failures use `ArchiveError`, which has a stable `code` property:

| Code | Meaning |
| --- | --- |
| `ERR_ARCHIVE_CLOSED` | Operation attempted after `close()` |
| `ERR_INVALID_ENTRY` | Entry ID is invalid or out of range |
| `ERR_INVALID_RANGE` | Byte range is invalid or exceeds the native offset limit |
| `ERR_RESOURCE_LIMIT` | Configured or default output limit was exceeded |
| `ERR_ARCHIVE_OPEN` | Archive could not be opened or indexed |
| `ERR_ARCHIVE_PASSWORD` | Password is missing or incorrect when requested by the handler |
| `ERR_ARCHIVE_PATH` | Unsafe or colliding path during folder extraction |
| `ERR_ARCHIVE_EXTRACT` | Entry extraction failed |
| `ERR_ARCHIVE_CREATE` | Archive creation failed or the output already exists |

Buffered `extract()` and `read()` do not currently support cancellation. Streams and folder extraction accept an `AbortSignal`.

## Supported formats

The package uses the handlers registered in the pinned upstream `Format7zF` bundle, including 7z, ZIP, RAR, TAR, GZIP, BZIP2, XZ, WIM, ISO/UDF, CAB, ARJ, LZH, CPIO, Zstandard, and additional formats enabled by that upstream revision. Whether a particular archive can be extracted depends on its handler and compression method; unsupported methods, corrupt data, and integrity failures reject the operation. Standalone compression codecs are not necessarily archive formats.

### Format-specific notes

- **RAR:** extraction uses upstream code subject to its LGPL terms and the unRAR restriction. This package does not create RAR archives or implement the proprietary RAR compression algorithm. Review the upstream notices before redistribution.
- **Creation:** ZIP, 7z, TAR, and WIM archives can be created from filesystem files. Streams and directory trees are not accepted as sources.
- **ACE:** not supported by this 7-Zip revision.
- **Encryption:** password callbacks are connected to archive opening and extraction. AES-256 encrypted ZIP extraction and range reads are tested on Linux x64; encrypted-header behavior and password variants in other formats are not yet verified.
- **Partial reads:** memory use is limited to the requested range, but the decoder may still process more data internally, especially for solid or sequential formats.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for third-party redistribution terms.

## Platform support

Published npm releases include prebuilt binaries for:

| Platform | Architectures |
| --- | --- |
| Linux | x64, x86 (ia32), ARM32, ARM64 |
| macOS | x64, ARM64 |
| Windows | x64, ARM64 |

The release workflow runs the test suite on Linux x64 and ARM64, macOS x64 and ARM64, and Windows x64 and ARM64. Linux x86 (ia32) and ARM32 builds are cross-compiled and binary-checked, but are not runtime-tested by that workflow. Windows x86 (ia32) prebuilds are not published.

## Electron

The addon uses Node-API, but the addon and 7-Zip engine still need to match the Electron application's operating system and architecture. Use a matching package prebuild when available, or rebuild for the Electron version and target architecture using your Electron build tooling. The engine is loaded at runtime rather than linked into the addon, so ensure the matching engine library is included alongside the addon.

When packaging with ASAR, ensure both `7zip_native.node` and the matching engine library (`7z.dll`, `7z.so`, or `lib7z.dylib`) are physically unpacked and that the runtime paths resolve to those unpacked files. For `electron-builder`, an `asarUnpack` configuration can include:

```json
{
	"build": {
		"asarUnpack": [
			"node_modules/7zip-native/prebuilds/**/*.node",
			"node_modules/7zip-native/prebuilds/**/*.dll",
			"node_modules/7zip-native/prebuilds/**/*.so",
			"node_modules/7zip-native/prebuilds/**/*.dylib"
		]
	}
}
```

If an application bundler relocates this package's JavaScript (for example, into a `www` directory), keep `7zip-native` resolvable as an installed dependency so the loader can locate the package's prebuilt binaries. Test the packaged application on each target; ASAR unpacking does not replace checking that the addon and engine can both be loaded from the packaged runtime.

## Build from source

```sh
git clone --recurse-submodules https://github.com/ollm/7zip-native.git
cd 7zip-native
npm ci --ignore-scripts
npm run build
npm test
```

Source builds require a C++17 toolchain, Python 3, Node.js headers (downloaded by `node-gyp`), and the upstream submodule. Linux and macOS use GNU make; Windows requires Visual C++ build tools and `nmake`. `npm run build:native` compiles the upstream `Format7zF` bundle and Node-API addon, then stages them under `prebuilds/<platform>-<arch>/`.

To update the upstream submodule deliberately:

```sh
git submodule update --remote vendor/7zip
git -C vendor/7zip rev-parse HEAD
git add .gitmodules vendor/7zip
```

Review the upstream changes and commit the new submodule revision. The current submodule is pinned to 7-Zip 26.06 (`d3296e39e1f1f92c7b41c0c3848e65640428d42d`).

## Benchmarks

The benchmark scripts that use `--experimental-strip-types` require Node.js 22.6.0 or newer; this is separate from the package's Node.js runtime requirement.

Run the native benchmark against a representative archive:

```sh
BENCH_ITERATIONS=20 npm run benchmark -- "./archive.zip"
```

It measures native open/list, prefix reads, full extraction, and reads across independent archive handles. `BENCH_ITERATIONS` defaults to 15 and must be at least 3.

Compare the native API with the `7zzc` command-line baseline from `7zip-bin-full`:

```sh
npm run benchmark:compare -- \
	--archive "./archive.zip" \
	--entry "chapter/page.jpg" \
	--iterations 20 \
	--read-bytes 65536 \
	--concurrency 4
```

The comparison validates entry listings and output data before reporting median and p95 latency. CLI timings include process startup. Prefix reads use `-slb`; non-solid archives abort decoding per item once the byte limit is reached. For a range, the CLI emits through `offset + length` and slices stdout because it has no ranged-read API; this still needs to decode the preceding bytes. Captured output is capped at 256 MiB, and full-archive comparison is skipped if an entry exceeds that limit.

Compare extraction concurrency:

```sh
npm run benchmark:concurrency -- \
	--archive "./archive.7z" \
	--iterations 20 \
	--concurrencies 1,2,3,4,5,8,16 \
	--max-files 20
```

The report includes median and p95 latency, throughput, speedup, and the number of entries that can overlap. `--max-files` selects evenly spaced entries, which is useful when sampling solid archives. Benchmarks report measurements only; results depend on the archive, machine, and workload and do not guarantee a speedup.

Compare parallel extraction of every file in the archive, divided among promises:

```sh
npm run benchmark:multiprocess -- \
	--archive "./archive.zip" \
	--parallel-counts 1,2,4 \
	--iterations 3

ELECTRON_RUN_AS_NODE=1 electron bench/multiprocess-extract.cjs \
	--archive "./archive.zip" \
	--parallel-counts 1,2,4 \
	--iterations 3 \
	--deflate-buffer-size 262144
```

For each parallel count, the benchmark uses `Promise.all()`: every `7zip-native` promise opens its own handle to the same archive, and every `7zip-bin-full` promise spawns one `7zzc` command. All non-directory files in the archive are divided as evenly as possible among the concurrent operations. The native extraction pool is sized to the maximum requested parallel count so native promises can run concurrently. Outputs go to separate temporary directories and are verified by file size before cleanup. The report includes `Archive.open()` and CLI startup time. Native operations stay in the benchmark's Node/Electron process; only the CLI baseline spawns child processes.

Compare `extractToFolder()` concurrency (1 through 16) across one or more archives:

```sh
npm run benchmark:folder-concurrency -- \
	--archive "./samples/sample.zip" \
	--archive "./archive.7z" \
	--concurrencies 1,2,3,4,5,8,16 \
	--iterations 1
```

By default, the benchmark tests all concurrencies from 1 to 16. Use `--concurrencies` to select a comma-separated subset, or `--concurrency` for one value; concurrency 1 is always included as the speedup baseline. Each run extracts one archive into a temporary directory, verifies the completed file and byte counts, and removes the output before continuing. The default is one iteration per concurrency; increase `--iterations` for more stable measurements. The global worker pool is set to 16 for the benchmark and restored afterward.

## License

This package is MIT-licensed. The integrated 7-Zip code and other bundled dependencies have their own licensing terms; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) before redistribution.
