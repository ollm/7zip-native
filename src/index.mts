import {existsSync} from 'node:fs';
import {link, lstat, mkdir, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {availableParallelism} from 'node:os';
import {dirname, extname, join, relative as relativePath, resolve, sep} from 'node:path';
import {Readable, type Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
	ArchiveError,
	type ArchiveEntry,
	type ArchiveCreateEntry,
	type ArchiveFormat,
	type EntryId,
	type EntrySelector,
	type CreateArchiveOptions,
	type ExtractToFolderOptions,
	type OpenOptions,
	type ReadOptions,
	type ReadRequest,
	type ReadStreamOptions,
} from './types.mjs';

export {ArchiveError} from './types.mjs';
export type {
	ArchiveEntry,
	ArchiveCreateEntry,
	ArchiveFormat,
	ArchiveErrorCode,
	CreateArchiveOptions,
	EntryId,
	EntrySelector,
	ExtractedArchiveFile,
	ExtractToFolderProgress,
	ExtractToFolderOptions,
	OpenOptions,
	ReadOptions,
	ReadRequest,
	ReadStreamOptions,
} from './types.mjs';

type NativeStreamCallback = (
	chunk: Buffer | undefined,
	error: Error | undefined,
	done: boolean,
) => void;

type NativeFileProgressCallback = (bytesWritten: bigint) => void;

interface NativeFileTask {
	readonly taskId: bigint;
	readonly promise: Promise<bigint[]>;
}

interface NativeFileOutput {
	readonly id: EntryId;
	readonly path: string;
}

const defaultMaxOutputBytes = 4n * 1024n * 1024n * 1024n;
const defaultDeflateBufferSize = 32 * 1024;
const minDeflateBufferSize = 4 * 1024;
const maxDeflateBufferSize = 2 * 1024 * 1024;

function normalizeMaxBytes(
	value: number | bigint | null | undefined,
	label: string,
): bigint | null
{
	if(value === undefined)
	{
		return defaultMaxOutputBytes;
	}
	if(value === null)
	{
		return null;
	}
	if(typeof value === 'bigint')
	{
		if(value < 0n)
		{
			throw new RangeError(`${label} must be non-negative`);
		}
		return value;
	}
	if(!Number.isSafeInteger(value) || value < 0)
	{
		throw new RangeError(`${label} must be a non-negative safe integer or bigint`);
	}
	return BigInt(value);
}

interface NativeBinding {
	open(
		path: string,
		password: string | undefined,
		enginePath: string,
		deflateBufferSize: number,
	): Promise<bigint>;
	entries(handle: bigint): Promise<NativeEntry[]>;
	extract(handle: bigint, ids: readonly number[]): Promise<Buffer[]>;
	readMany(
		handle: bigint,
		requests: readonly {id: number; offset: bigint; length: bigint}[],
	): Promise<Buffer[]>;
	startStream(handle: bigint, id: number, callback: NativeStreamCallback): bigint;
	startExtractToFiles(
		handle: bigint,
		outputs: readonly NativeFileOutput[],
		progressCallback?: NativeFileProgressCallback,
	): NativeFileTask;
	cancelExtractToFiles(taskId: bigint): void;
	resumeStream(streamId: bigint): void;
	cancelStream(streamId: bigint): void;
	read(handle: bigint, id: number, offset: bigint, length: bigint): Promise<Buffer>;
	concurrency(value?: number): number;
	close(handle: bigint): void;
	create(
		outputPath: string,
		format: ArchiveFormat,
		entries: readonly NativeCreateEntry[],
		compressionLevel: number,
		enginePath: string,
	): Promise<void>;
}

type NativeEntry = ArchiveEntry;

interface NativeCreateEntry extends ArchiveCreateEntry {
	readonly mtimeMs: number;
}

const require = createRequire(import.meta.url);
let engineName = '7z.so';
if(process.platform === 'win32')
{
	engineName = '7z.dll';
}
else if(process.platform === 'darwin')
{
	engineName = 'lib7z.dylib';
}
const packageDirectory = dirname(require.resolve('7zip-native'));
const runtimeDirectory = [
	resolve(packageDirectory, `../prebuilds/${process.platform}-${process.arch}`),
	resolve(packageDirectory, '../build/Release'),
].find(directory =>
	existsSync(join(directory, '7zip_native.node')) && existsSync(join(directory, engineName)));

if(!runtimeDirectory)
{
	throw new Error(
		`Native binaries for ${process.platform}-${process.arch} were not found; build 7zip-native from source`,
	);
}

const enginePath = join(runtimeDirectory, engineName);
const native = require(join(runtimeDirectory, '7zip_native.node')) as NativeBinding;
const defaultConcurrency = Math.max(1, Math.min(availableParallelism(), 4));
native.concurrency(defaultConcurrency);

interface OutputPlan {
	readonly entry: ArchiveEntry;
	readonly segments: readonly string[];
	readonly targetPath: string;
	readonly isDirectory: boolean;
}

function safeEntrySegments(entryPath: string): string[]
{
	if(entryPath.includes('\0'))
	{
		throw new ArchiveError('ERR_ARCHIVE_PATH', 'Archive entry path contains a null byte');
	}
	const normalized = entryPath.replace(/\\/g, '/');
	if(normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized))
	{
		throw new ArchiveError('ERR_ARCHIVE_PATH', `Archive entry path is absolute: ${entryPath}`);
	}
	const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.');
	if(segments.length === 0 || segments.some(segment =>
		segment === '..'
		|| segment.includes(':')
		|| /[. ]$/.test(segment)
		|| /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))
	{
		throw new ArchiveError('ERR_ARCHIVE_PATH', `Unsafe archive entry path: ${entryPath}`);
	}
	return segments;
}

function sanitizeOutputPath(entryPath: string): string
{
	if(process.platform !== 'win32')
	{
		return entryPath;
	}
	return entryPath
		.replace(/([. ]+)([\\/]|$)/g, (_match, unsupported: string, separator: string) =>
			'_'.repeat(unsupported.length) + separator)
		.replace(/[<>:|?*"]/g, '_');
}

function assertSafeRelativeArchivePath(entryPath: string): void
{
	const normalized = entryPath.replace(/\\/g, '/');
	const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.');
	if(entryPath.includes('\0')
		|| normalized.startsWith('/')
		|| /^[a-zA-Z]:/.test(normalized)
		|| segments.length === 0
		|| segments.some(segment => segment === '..'))
	{
		throw new ArchiveError('ERR_ARCHIVE_PATH', `Unsafe archive entry path: ${entryPath}`);
	}
}

function makeOutputPlans(root: string, entries: readonly ArchiveEntry[]): OutputPlan[]
{
	const caseInsensitivePaths = process.platform === 'win32' || process.platform === 'darwin';
	const plans = entries.map((entry) => {
		if(process.platform === 'win32')
		{
			assertSafeRelativeArchivePath(entry.path);
		}
		const segments = safeEntrySegments(sanitizeOutputPath(entry.path));
		const targetPath = resolve(root, ...segments);
		const relative = relativePath(root, targetPath);
		if(relative === ''
			|| relative === '..'
			|| relative.startsWith(`..${sep}`)
			|| resolve(root, relative) !== targetPath)
		{
			throw new ArchiveError('ERR_ARCHIVE_PATH', `Archive entry escapes the destination: ${entry.path}`);
		}
		return {entry, segments, targetPath, isDirectory: entry.isDirectory};
	});

	const pathKinds = new Map<string, boolean>();
	for(const plan of plans)
	{
		const relative = relativePath(root, plan.targetPath).split(sep).join('/');
		const key = caseInsensitivePaths ? relative.toLowerCase() : relative;
		if(pathKinds.has(key))
		{
			throw new ArchiveError('ERR_ARCHIVE_PATH', `Archive contains colliding paths: ${plan.entry.path}`);
		}
		pathKinds.set(key, plan.isDirectory);
	}
	for(const plan of plans)
	{
		let parent = '';
		for(const segment of plan.segments.slice(0, -1))
		{
			parent = parent ? `${parent}/${segment}` : segment;
			const key = caseInsensitivePaths ? parent.toLowerCase() : parent;
			if(pathKinds.get(key) === false)
			{
				throw new ArchiveError(
					'ERR_ARCHIVE_PATH',
					`Archive path traverses a non-directory entry: ${plan.entry.path}`,
				);
			}
		}
	}
	return plans;
}

async function ensureDirectory(directoryPath: string): Promise<void>
{
	try
	{
		await mkdir(directoryPath, {mode: 0o700});
	}
	catch (error)
	{
		if((error as NodeJS.ErrnoException).code !== 'EEXIST')
		{
			throw error;
		}
	}
	const details = await lstat(directoryPath);
	if(details.isSymbolicLink() || !details.isDirectory())
	{
		throw new ArchiveError('ERR_ARCHIVE_PATH', `Destination path is not a real directory: ${directoryPath}`);
	}
}

async function assertReplaceableOutput(filePath: string): Promise<void>
{
	try
	{
		const details = await lstat(filePath);
		if(!details.isFile())
		{
			throw new ArchiveError(
				'ERR_ARCHIVE_PATH',
				`Cannot replace a non-file extraction target: ${filePath}`,
			);
		}
	}
	catch (error)
	{
		if(error instanceof ArchiveError || (error as NodeJS.ErrnoException).code !== 'ENOENT')
		{
			throw error;
		}
	}
}

async function assertFolderOutputDoesNotExist(filePath: string): Promise<void>
{
	try
	{
		await lstat(filePath);
		const error = new Error(`Output file already exists: ${filePath}`);
		Object.assign(error, {code: 'EEXIST'});
		throw error;
	}
	catch (error)
	{
		if((error as NodeJS.ErrnoException).code !== 'ENOENT')
		{
			throw error;
		}
	}
}

async function assertOutputDoesNotExist(filePath: string): Promise<void>
{
	try
	{
		await lstat(filePath);
		throw new ArchiveError('ERR_ARCHIVE_CREATE', `Output archive already exists: ${filePath}`);
	}
	catch (error)
	{
		if(error instanceof ArchiveError || (error as NodeJS.ErrnoException).code !== 'ENOENT')
		{
			throw error;
		}
	}
}

async function normalizeCreateEntry(entry: ArchiveCreateEntry): Promise<NativeCreateEntry>
{
	if(entry === null || typeof entry !== 'object'
		|| typeof entry.sourcePath !== 'string' || entry.sourcePath.length === 0
		|| typeof entry.path !== 'string' || entry.path.length === 0)
	{
		throw new TypeError('Each archive creation entry must have non-empty sourcePath and path strings');
	}
	const internalPath = safeEntrySegments(entry.path).join('/');
	const sourcePath = resolve(entry.sourcePath);
	let details: Awaited<ReturnType<typeof lstat>>;
	try
	{
		details = await lstat(sourcePath);
	}
	catch (cause)
	{
		throw new ArchiveError(
			'ERR_ARCHIVE_CREATE',
			`Unable to access archive creation source: ${sourcePath}`,
			{cause},
		);
	}
	if(details.isSymbolicLink() || !details.isFile())
	{
		throw new ArchiveError(
			'ERR_ARCHIVE_CREATE',
			`Archive creation source is not a regular file: ${sourcePath}`,
		);
	}
	return {sourcePath, path: internalPath, mtimeMs: details.mtimeMs};
}

async function ensureExtractionRoot(root: string): Promise<void>
{
	try
	{
		const details = await lstat(root);
		if(details.isSymbolicLink() || !details.isDirectory())
		{
			throw new ArchiveError('ERR_ARCHIVE_PATH', `Destination is not a real directory: ${root}`);
		}
		return;
	}
	catch (error)
	{
		if(error instanceof ArchiveError || (error as NodeJS.ErrnoException).code !== 'ENOENT')
		{
			throw error;
		}
	}
	await mkdir(root, {recursive: true, mode: 0o700});
	const details = await lstat(root);
	if(details.isSymbolicLink() || !details.isDirectory())
	{
		throw new ArchiveError('ERR_ARCHIVE_PATH', `Destination is not a real directory: ${root}`);
	}
}

async function ensureOutputParents(root: string, targetPath: string): Promise<void>
{
	const parent = relativePath(root, targetPath);
	const segments = parent ? parent.split(sep).slice(0, -1) : [];
	let current = root;
	for(const segment of segments)
	{
		current = join(current, segment);
		await ensureDirectory(current);
	}
}

async function ensureOutputDirectoryTree(root: string, directoryPath: string): Promise<void>
{
	const relative = relativePath(root, directoryPath);
	let current = root;
	for(const segment of relative.split(sep))
	{
		current = join(current, segment);
		await ensureDirectory(current);
	}
}

class NativeArchiveReadable extends Readable {
	private streamId?: bigint;
	private outputBytes = 0n;
	private starting = false;

	constructor(
		private readonly start: (callback: NativeStreamCallback) => bigint | Promise<bigint>,
		private readonly resumeNative: (streamId: bigint) => void,
		private readonly cancel: (streamId: bigint) => void,
		options: ReadStreamOptions,
		private readonly maxBytes: bigint | null,
	) {
		super({highWaterMark: options.highWaterMark, signal: options.signal});
	}

	override _read(): void {
		if(this.streamId !== undefined)
		{
			try
			{
				this.resumeNative(this.streamId);
			}
			catch (cause)
			{
				this.destroy(extractionError(cause));
			}
			return;
		}
		if(this.starting)
		{
			return;
		}

		this.starting = true;
		try
		{
			Promise.resolve(this.start((chunk, error, done) => {
				if(this.destroyed)
				{
					return;
				}
				if(error)
				{
					this.destroy(extractionError(error));
				}
				else if(done)
				{
					this.push(null);
				}
				else if(chunk)
				{
					if(this.maxBytes !== null
						&& this.outputBytes + BigInt(chunk.length) > this.maxBytes)
					{
						this.destroy(new ArchiveError(
							'ERR_RESOURCE_LIMIT',
							`Stream output exceeds the ${this.maxBytes}-byte limit`,
						));
						return;
					}
					this.outputBytes += BigInt(chunk.length);
					this.push(chunk);
				}
				else
				{
					this.destroy(new ArchiveError(
						'ERR_ARCHIVE_EXTRACT',
						'Native stream returned an empty chunk notification',
					));
				}
			})).then((streamId) => {
				this.streamId = streamId;
				this.starting = false;
				try
				{
					if(this.destroyed)
					{
						this.cancel(streamId);
					}
					else
					{
						this.resumeNative(streamId);
					}
				}
				catch (cause)
				{
					this.destroy(extractionError(cause));
				}
			}, (cause: unknown) => {
				this.starting = false;
				this.destroy(extractionError(cause));
			});
		}
		catch (cause)
		{
			this.starting = false;
			this.destroy(extractionError(cause));
		}
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		try
		{
			if(this.streamId !== undefined)
			{
				this.cancel(this.streamId);
			}
			callback(error);
		}
		catch (cause)
		{
			callback(error ?? extractionError(cause));
		}
	}
}

export class Archive {
	private closed = false;
	private entriesPromise?: Promise<readonly ArchiveEntry[]>;
	private entryIndexes?: {
		readonly pathEntries: Readonly<Record<string, ArchiveEntry>>;
		readonly idEntries: Readonly<Record<number, ArchiveEntry>>;
	};

	private constructor(private readonly handle: bigint) {}

	static concurrency(value?: number): number {
		if(value === undefined)
		{
			return native.concurrency();
		}
		if(!Number.isSafeInteger(value) || value < 0 || value > 128)
		{
			throw new RangeError('Concurrency must be 0 (default) or an integer between 1 and 128');
		}
		return native.concurrency(value === 0 ? defaultConcurrency : value);
	}

	static async open(path: string, options: OpenOptions = {}): Promise<Archive> {
		if(typeof path !== 'string' || path.length === 0)
		{
			throw new TypeError('Archive path must be a non-empty string');
		}
		if(options.password !== undefined)
		{
			if(typeof options.password !== 'string')
			{
				throw new TypeError('Archive password must be a string');
			}
			if(Buffer.byteLength(options.password, 'utf8') > 1024 * 1024)
			{
				throw new RangeError('Password exceeds the 1 MiB native password limit');
			}
		}
		const deflateBufferSize = options.deflateBufferSize ?? defaultDeflateBufferSize;
		if(!Number.isSafeInteger(deflateBufferSize)
			|| deflateBufferSize < minDeflateBufferSize
			|| deflateBufferSize > maxDeflateBufferSize)
		{
			throw new RangeError(
				`Deflate buffer size must be an integer between ${minDeflateBufferSize} and ${maxDeflateBufferSize} bytes`,
			);
		}
		try
		{
			const handle = await native.open(
				resolve(path),
				options.password,
				enginePath,
				deflateBufferSize,
			);
			return new Archive(handle);
		}
		catch (cause)
		{
			const message = errorMessage(cause);
			throw new ArchiveError(
				/password/i.test(message) ? 'ERR_ARCHIVE_PASSWORD' : 'ERR_ARCHIVE_OPEN',
				message,
				{cause},
			);
		}
	}

	static async create(
		outputPath: string,
		entries: readonly ArchiveCreateEntry[],
		options: CreateArchiveOptions = {},
	): Promise<void> {
		if(typeof outputPath !== 'string' || outputPath.length === 0)
		{
			throw new TypeError('Output archive path must be a non-empty string');
		}
		if(!Array.isArray(entries))
		{
			throw new TypeError('Archive creation entries must be an array');
		}
		if(entries.length > 1_000_000)
		{
			throw new RangeError('Archive creation exceeds the 1,000,000-entry limit');
		}
		if(options === null || typeof options !== 'object')
		{
			throw new TypeError('Archive creation options must be an object');
		}
		if(options.overwrite !== undefined && typeof options.overwrite !== 'boolean')
		{
			throw new TypeError('Archive creation overwrite option must be a boolean');
		}
		const compressionLevel = options.compressionLevel ?? 5;
		if(!Number.isSafeInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9)
		{
			throw new RangeError('Compression level must be an integer between 0 and 9');
		}
		const targetPath = resolve(outputPath);
		let format: ArchiveFormat;
		if(options.format !== undefined)
		{
			if(options.format !== '7z' && options.format !== 'zip'
				&& options.format !== 'tar' && options.format !== 'wim')
			{
				throw new TypeError('Archive format must be "7z", "zip", "tar", or "wim"');
			}
			format = options.format;
		}
		else
		{
			const extension = extname(targetPath).toLowerCase();
			if(extension === '.7z')
			{
				format = '7z';
			}
			else if(extension === '.zip')
			{
				format = 'zip';
			}
			else if(extension === '.tar')
			{
				format = 'tar';
			}
			else if(extension === '.wim')
			{
				format = 'wim';
			}
			else
			{
				throw new TypeError('Specify format as "7z", "zip", "tar", or "wim" for an unrecognized output extension');
			}
		}
		if(options.compressionLevel !== undefined && format !== '7z' && format !== 'zip')
		{
			throw new TypeError('compressionLevel is only supported for ZIP and 7z archives');
		}

		const normalizedEntries = await Promise.all(entries.map(normalizeCreateEntry));
		const caseInsensitivePaths = process.platform === 'win32' || process.platform === 'darwin';
		const pathKeys = normalizedEntries.map(entry =>
			caseInsensitivePaths ? entry.path.toLowerCase() : entry.path);
		const archivePaths = new Set(pathKeys);
		if(archivePaths.size !== normalizedEntries.length)
		{
			throw new ArchiveError('ERR_ARCHIVE_PATH', 'Archive creation paths must be unique');
		}
		for(const entry of normalizedEntries)
		{
			const segments = entry.path.split('/');
			for(let index = 1; index < segments.length; index++)
			{
				const parent = segments.slice(0, index).join('/');
				const parentKey = caseInsensitivePaths ? parent.toLowerCase() : parent;
				if(archivePaths.has(parentKey))
				{
					throw new ArchiveError(
						'ERR_ARCHIVE_PATH',
						`Archive creation file path is a parent of another entry: ${parent}`,
					);
				}
			}
		}
		if(options.overwrite)
		{
			await assertReplaceableOutput(targetPath);
		}
		else
		{
			await assertOutputDoesNotExist(targetPath);
		}

		const temporaryPath = join(dirname(targetPath), `.7zip-native-${randomUUID()}.tmp`);
		try
		{
			await native.create(temporaryPath, format, normalizedEntries, compressionLevel, enginePath);
			if(options.overwrite)
			{
				await assertReplaceableOutput(targetPath);
				await rename(temporaryPath, targetPath);
			}
			else
			{
				await link(temporaryPath, targetPath);
				await rm(temporaryPath);
			}
		}
		catch (cause)
		{
			await rm(temporaryPath, {force: true});
			if(cause instanceof ArchiveError)
			{
				throw cause;
			}
			throw new ArchiveError('ERR_ARCHIVE_CREATE', errorMessage(cause), {cause});
		}
	}

	async entries(): Promise<readonly ArchiveEntry[]> {
		this.assertOpen();
		this.entriesPromise ??= native.entries(this.handle).catch((cause) => {
			throw new ArchiveError('ERR_ARCHIVE_OPEN', errorMessage(cause), {cause});
		});
		return this.entriesPromise;
	}

	async getEntry(idOrPath: EntrySelector): Promise<ArchiveEntry | undefined> {
		if(typeof idOrPath === 'number' && (!Number.isSafeInteger(idOrPath) || idOrPath < 0))
		{
			throw new RangeError('Entry ID must be a non-negative safe integer');
		}
		const entries = await this.entries();
		if(!this.entryIndexes)
		{
			const pathEntries = Object.create(null) as Record<string, ArchiveEntry>;
			const idEntries = Object.create(null) as Record<number, ArchiveEntry>;
			for(const entry of entries)
			{
				pathEntries[entry.path] ??= entry;
				idEntries[entry.id] ??= entry;
			}
			this.entryIndexes = {pathEntries, idEntries};
		}
		if(typeof idOrPath === 'number')
		{
			return this.entryIndexes.idEntries[idOrPath];
		}
		if(typeof idOrPath === 'string')
		{
			return this.entryIndexes.pathEntries[idOrPath];
		}
		return undefined;
	}

	async extract(idOrPath: EntrySelector): Promise<Buffer>;
	async extract(idsOrPaths: readonly EntrySelector[]): Promise<Buffer[]>;
	async extract(idOrPathOrPaths: EntrySelector | readonly EntrySelector[]): Promise<Buffer | Buffer[]> {
		this.assertOpen();
		const isBatch = Array.isArray(idOrPathOrPaths);
		let selectors: readonly EntrySelector[];
		if(isBatch)
		{
			selectors = idOrPathOrPaths as readonly EntrySelector[];
		}
		else
		{
			selectors = [idOrPathOrPaths as EntrySelector];
		}
		const numericIds = selectors.filter((selector): selector is EntryId => typeof selector === 'number');
		let ids: EntryId[];
		if(numericIds.length === selectors.length)
		{
			this.validateIds(numericIds);
			ids = numericIds;
		}
		else
		{
			ids = await this.resolveEntryIds(selectors);
		}
		try
		{
			const buffers = await native.extract(this.handle, ids);
			return isBatch ? buffers : buffers[0];
		}
		catch (cause)
		{
			throw extractionError(cause);
		}
	}

	createReadStream(idOrPath: EntrySelector, options: ReadStreamOptions = {}): Readable {
		this.assertOpen();
		if(typeof idOrPath === 'number')
		{
			this.validateIds([idOrPath]);
		}
		else if(typeof idOrPath !== 'string')
		{
			throw new TypeError('Entry selector must be an ID or archive path');
		}
		if(!options || typeof options !== 'object')
		{
			throw new TypeError('Stream options must be an object');
		}
		if(options.highWaterMark !== undefined
			&& (!Number.isSafeInteger(options.highWaterMark)
				|| options.highWaterMark < 1
				|| options.highWaterMark > 16 * 1024 * 1024))
		{
			throw new RangeError('highWaterMark must be an integer between 1 byte and 16 MiB');
		}
		options.signal?.throwIfAborted();
		const maxBytes = normalizeMaxBytes(options.maxBytes, 'maxBytes');
		return new NativeArchiveReadable(
			(callback) => {
				if(typeof idOrPath === 'number')
				{
					return native.startStream(this.handle, idOrPath, callback);
				}
				return this.resolveEntryId(idOrPath).then(id => native.startStream(this.handle, id, callback));
			},
			streamId => native.resumeStream(streamId),
			streamId => native.cancelStream(streamId),
			options,
			maxBytes,
		);
	}

	async extractToStream(
		idOrPath: EntrySelector,
		destination: Writable,
		options: ReadStreamOptions = {},
	): Promise<void> {
		if(!destination || typeof destination.write !== 'function')
		{
			throw new TypeError('Destination must be a writable stream');
		}
		await pipeline(this.createReadStream(idOrPath, options), destination, {signal: options.signal});
	}

	async extractToFolder(
		destination: string,
		options: ExtractToFolderOptions = {},
	): Promise<void> {
		this.assertOpen();
		if(typeof destination !== 'string' || destination.length === 0)
		{
			throw new TypeError('Destination folder must be a non-empty path');
		}
		if(!options || typeof options !== 'object')
		{
			throw new TypeError('Folder extraction options must be an object');
		}
		if(options.overwrite !== undefined && typeof options.overwrite !== 'boolean')
		{
			throw new TypeError('Folder extraction overwrite option must be a boolean');
		}
		if(options.concurrency !== undefined
			&& (!Number.isSafeInteger(options.concurrency)
				|| options.concurrency < 1
				|| options.concurrency > 128))
		{
			throw new RangeError('Folder extraction concurrency must be an integer between 1 and 128');
		}
		if(options.onProgress !== undefined && typeof options.onProgress !== 'function')
		{
			throw new TypeError('Folder extraction onProgress option must be a function');
		}
		if(options.onExtract !== undefined && typeof options.onExtract !== 'function')
		{
			throw new TypeError('Folder extraction onExtract option must be a function');
		}
		const concurrency = Math.min(options.concurrency ?? 1, Archive.concurrency());
		options.signal?.throwIfAborted();
		const maxBytes = normalizeMaxBytes(options.maxBytes, 'maxBytes');
		const entries = await this.entries();
		let selectedEntries: readonly ArchiveEntry[] = entries;
		if(options.ids !== undefined && options.paths !== undefined)
		{
			throw new TypeError('Specify either folder extraction IDs or paths, not both');
		}
		if(options.ids !== undefined)
		{
			if(!Array.isArray(options.ids))
			{
				throw new TypeError('Folder extraction IDs must be an array');
			}
			this.validateIds(options.ids);
			const entriesById = new Map(entries.map(entry => [entry.id, entry]));
			selectedEntries = options.ids.map((id) => {
				const entry = entriesById.get(id);
				if(!entry)
				{
					throw new ArchiveError('ERR_INVALID_ENTRY', `Entry ID ${id} is out of range`);
				}
				return entry;
			});
		}
		else if(options.paths !== undefined)
		{
			if(!Array.isArray(options.paths)
				|| options.paths.some(entryPath => typeof entryPath !== 'string'))
			{
				throw new TypeError('Folder extraction paths must be an array of strings');
			}
			const ids = await this.resolveEntryIds(options.paths);
			const entriesById = new Map(entries.map(entry => [entry.id, entry]));
			selectedEntries = ids.map((id) => {
				const entry = entriesById.get(id);
				if(!entry)
				{
					throw new ArchiveError('ERR_INVALID_ENTRY', `Entry ID ${id} is out of range`);
				}
				return entry;
			});
		}

		const root = resolve(destination);
		const plans = makeOutputPlans(root, selectedEntries);
		const expectedBytes = selectedEntries.reduce(
			(total, entry) => total + (entry.isDirectory ? 0n : entry.size),
			0n,
		);
		if(maxBytes !== null && expectedBytes > maxBytes)
		{
			throw new ArchiveError(
				'ERR_RESOURCE_LIMIT',
				`Folder output exceeds the ${maxBytes}-byte limit`,
			);
		}
		options.signal?.throwIfAborted();
		await ensureExtractionRoot(root);

		let extractedBytes = 0n;
		let filesExtracted = 0;
		const totalFiles = plans.filter(plan => !plan.isDirectory).length;
		const reportProgress = (): void => {
			let percent = 0;
			if(expectedBytes > 0n)
			{
				const scaledPercent = extractedBytes * 10000n / expectedBytes;
				percent = Number(scaledPercent > 9900n ? 9900n : scaledPercent) / 100;
			}
			if(filesExtracted === totalFiles)
			{
				percent = 100;
			}
			options.onProgress?.({
				filesExtracted,
				totalFiles,
				bytesProcessed: extractedBytes,
				totalBytes: expectedBytes,
				percent,
			});
		};
		reportProgress();
		for(const plan of plans)
		{
			options.signal?.throwIfAborted();
			if(plan.isDirectory)
			{
				await ensureOutputDirectoryTree(root, plan.targetPath);
			}
		}

		const filePlans = plans.filter(plan => !plan.isDirectory);
		const controller = new AbortController();
		const extractionSignal = controller.signal;
		let hasFailure = false;
		let failure: unknown;
		const stop = (error: unknown): void => {
			if(!hasFailure)
			{
				hasFailure = true;
				failure = error;
			}
			if(!extractionSignal.aborted)
			{
				controller.abort(error);
			}
		};
		const abortFromCaller = (): void => {
			stop(options.signal?.reason);
		};
		options.signal?.addEventListener('abort', abortFromCaller, {once: true});

		let reportBytesWritten: NativeFileProgressCallback | undefined;
		if(options.onProgress)
		{
			reportBytesWritten = (bytesWritten) => {
				if(hasFailure)
				{
					return;
				}
				extractedBytes += bytesWritten;
				try
				{
					reportProgress();
				}
				catch (error)
				{
					stop(error);
				}
			};
		}

		const groupCount = Math.min(concurrency, filePlans.length);
		const fileGroups = Array.from({length: groupCount}, () => [] as OutputPlan[]);
		filePlans.forEach((plan, index) => {
			fileGroups[index % groupCount]!.push(plan);
		});
		const extractGroup = async(group: readonly OutputPlan[]): Promise<void> => {
			const outputs: NativeFileOutput[] = [];
			const temporaryPaths: Array<string | undefined> = [];
			try
			{
				for(const plan of group)
				{
					await ensureOutputParents(root, plan.targetPath);
					extractionSignal.throwIfAborted();
					if(options.overwrite)
					{
						await assertReplaceableOutput(plan.targetPath);
						const temporaryPath = join(
							dirname(plan.targetPath),
							`.7zip-native-${randomUUID()}.tmp`,
						);
						temporaryPaths.push(temporaryPath);
						outputs.push({id: plan.entry.id, path: temporaryPath});
					}
					else
					{
						await assertFolderOutputDoesNotExist(plan.targetPath);
						temporaryPaths.push(undefined);
						outputs.push({id: plan.entry.id, path: plan.targetPath});
					}
				}

				const bytesWritten = await this.extractEntriesToFiles(
					outputs,
					extractionSignal,
					reportBytesWritten,
				);
				if(bytesWritten.length !== group.length)
				{
					throw new ArchiveError(
						'ERR_ARCHIVE_EXTRACT',
						'Native folder extraction returned an incomplete result',
					);
				}
				for(let index = 0; index < group.length; index++)
				{
					const plan = group[index]!;
					const temporaryPath = temporaryPaths[index];
					if(reportBytesWritten === undefined)
					{
						extractedBytes += bytesWritten[index]!;
					}
					extractionSignal.throwIfAborted();
					if(temporaryPath)
					{
						await assertReplaceableOutput(plan.targetPath);
						extractionSignal.throwIfAborted();
						await rename(temporaryPath, plan.targetPath);
						temporaryPaths[index] = undefined;
					}
					filesExtracted++;
					reportProgress();
					options.onExtract?.({entry: plan.entry, outputPath: plan.targetPath});
				}
			}
			catch (error)
			{
				await Promise.all(temporaryPaths
					.filter((temporaryPath): temporaryPath is string => temporaryPath !== undefined)
					.map(temporaryPath => rm(temporaryPath, {force: true})));
				throw error;
			}
		};

		try
		{
			options.signal?.throwIfAborted();
			const workers = fileGroups.map(group => extractGroup(group));
			try
			{
				await Promise.all(workers);
			}
			catch (error)
			{
				stop(error);
				await Promise.allSettled(workers);
				throw failure;
			}
		}
		finally
		{
			options.signal?.removeEventListener('abort', abortFromCaller);
		}
	}

	async read(idOrPath: EntrySelector, options: ReadOptions): Promise<Buffer>;
	async read(idsOrPaths: readonly EntrySelector[], options: ReadOptions): Promise<Buffer[]>;
	async read(requests: readonly ReadRequest[]): Promise<Buffer[]>;
	async read(
		idOrPathOrPaths: EntrySelector | readonly EntrySelector[] | readonly ReadRequest[],
		options?: ReadOptions,
	): Promise<Buffer | Buffer[]> {
		this.assertOpen();
		const maxUInt64 = (1n << 64n) - 1n;
		const normalizeRange = (range: ReadOptions): {offset: bigint; length: bigint} => {
			const offset = this.toUnsignedBigInt(range.offset ?? 0, 'offset');
			const length = this.toUnsignedBigInt(range.length, 'length');
			if(offset > maxUInt64 || length > maxUInt64 - offset)
			{
				throw new ArchiveError('ERR_INVALID_RANGE', 'Read range exceeds the native 64-bit offset limit');
			}
			return {offset, length};
		};

		if(options === undefined)
		{
			if(!Array.isArray(idOrPathOrPaths))
			{
				throw new TypeError('Read options are required for an entry selector');
			}
			const requests = idOrPathOrPaths as readonly ReadRequest[];
			const normalized = await Promise.all(requests.map(async(request) => {
				if(!request || typeof request !== 'object' || !('entry' in request))
				{
					throw new TypeError('Batch read requests must include an entry selector');
				}
				const range = normalizeRange(request);
				return {
					id: await this.resolveEntryId(request.entry),
					...range,
				};
			}));
			if(!normalized.length)
			{
				return [];
			}
			try
			{
				return await native.readMany(this.handle, normalized);
			}
			catch (cause)
			{
				throw extractionError(cause);
			}
		}

		const isBatch = Array.isArray(idOrPathOrPaths);
		let selectors: readonly EntrySelector[];
		if(isBatch)
		{
			selectors = idOrPathOrPaths as readonly EntrySelector[];
		}
		else
		{
			selectors = [idOrPathOrPaths as EntrySelector];
		}
		const {offset, length} = normalizeRange(options);

		if(isBatch)
		{
			const ids = await Promise.all(selectors.map(selector => this.resolveEntryId(selector)));
			const uniqueIds = [...new Set(ids)];
			if(!uniqueIds.length)
			{
				return [];
			}
			try
			{
				const buffers = await native.readMany(
					this.handle,
					uniqueIds.map(id => ({id, offset, length})),
				);
				const buffersById = new Map(uniqueIds.map((id, index) => [id, buffers[index]!]));
				return ids.map(id => buffersById.get(id)!);
			}
			catch (cause)
			{
				throw extractionError(cause);
			}
		}

		const idOrPath = selectors[0]!;
		let id: EntryId;
		if(typeof idOrPath === 'number')
		{
			this.validateIds([idOrPath]);
			id = idOrPath;
		}
		else
		{
			id = await this.resolveEntryId(idOrPath);
		}
		try
		{
			return await native.read(this.handle, id, offset, length);
		}
		catch (cause)
		{
			throw extractionError(cause);
		}
	}

	private async extractEntriesToFiles(
		outputs: readonly NativeFileOutput[],
		signal: AbortSignal,
		onBytesWritten?: NativeFileProgressCallback,
	): Promise<bigint[]> {
		let task: NativeFileTask | undefined;
		const cancelTask = (): void => {
			if(task)
			{
				native.cancelExtractToFiles(task.taskId);
			}
		};
		try
		{
			signal.throwIfAborted();
			task = native.startExtractToFiles(
				this.handle,
				outputs,
				onBytesWritten,
			);
			signal.addEventListener('abort', cancelTask, {once: true});
			if(signal.aborted)
			{
				cancelTask();
			}
			return await task.promise;
		}
		catch (cause)
		{
			if(signal.aborted)
			{
				throw signal.reason ?? cause;
			}
			throw extractionError(cause);
		}
		finally
		{
			signal.removeEventListener('abort', cancelTask);
		}
	}

	async close(): Promise<void> {
		if(this.closed)
		{
			return;
		}
		this.closed = true;
		native.close(this.handle);
	}

	private assertOpen(): void {
		if(this.closed)
		{
			throw new ArchiveError('ERR_ARCHIVE_CLOSED', 'Archive is closed');
		}
	}

	private validateIds(ids: readonly number[]): void {
		if(ids.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(ids).size !== ids.length)
		{
			throw new ArchiveError('ERR_INVALID_ENTRY', 'Entry IDs must be unique non-negative safe integers');
		}
	}

	private async resolveEntryId(selector: EntrySelector): Promise<EntryId> {
		if(typeof selector === 'number')
		{
			this.validateIds([selector]);
			return selector;
		}
		if(typeof selector !== 'string')
		{
			throw new TypeError('Entry selector must be an ID or archive path');
		}
		const entry = await this.getEntry(selector);
		if(!entry)
		{
			throw new ArchiveError('ERR_INVALID_ENTRY', `Archive entry "${selector}" was not found`);
		}
		return entry.id;
	}

	private async resolveEntryIds(selectors: readonly EntrySelector[]): Promise<EntryId[]> {
		const ids = await Promise.all(selectors.map(selector => this.resolveEntryId(selector)));
		this.validateIds(ids);
		return ids;
	}

	private toUnsignedBigInt(value: number | bigint, label: string): bigint {
		if(typeof value === 'bigint')
		{
			if(value < 0n)
			{
				throw new RangeError(`${label} must be non-negative`);
			}
			return value;
		}
		if(!Number.isSafeInteger(value) || value < 0)
		{
			throw new RangeError(`${label} must be a non-negative safe integer or bigint`);
		}
		return BigInt(value);
	}
}

function errorMessage(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}

function extractionError(cause: unknown): ArchiveError
{
	const message = errorMessage(cause);
	if(/password/i.test(message))
	{
		return new ArchiveError('ERR_ARCHIVE_PASSWORD', message, {cause});
	}
	if(/Entry ID is out of range|Cannot read a directory|Duplicate entry IDs/i.test(message))
	{
		return new ArchiveError('ERR_INVALID_ENTRY', message, {cause});
	}
	if(/in-memory output limit|queue is full/i.test(message))
	{
		return new ArchiveError('ERR_RESOURCE_LIMIT', message, {cause});
	}
	return new ArchiveError('ERR_ARCHIVE_EXTRACT', message, {cause});
}
