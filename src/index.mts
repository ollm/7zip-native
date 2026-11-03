import {createWriteStream, existsSync} from 'node:fs';
import {lstat, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {availableParallelism} from 'node:os';
import {dirname, join, relative as relativePath, resolve, sep} from 'node:path';
import {Readable, Transform, type Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {
	ArchiveError,
	type ArchiveEntry,
	type EntryId,
	type ExtractToFolderOptions,
	type OpenOptions,
	type ReadOptions,
	type ReadStreamOptions,
} from './types.mjs';

export {ArchiveError} from './types.mjs';
export type {
	ArchiveEntry,
	ArchiveErrorCode,
	EntryId,
	ExtractToFolderOptions,
	OpenOptions,
	ReadOptions,
	ReadStreamOptions,
} from './types.mjs';

type NativeStreamCallback = (
	chunk: Buffer | undefined,
	error: Error | undefined,
	done: boolean,
) => void;

const defaultMaxOutputBytes = 4n * 1024n * 1024n * 1024n;

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
	open(path: string, password: string | undefined, enginePath: string): Promise<bigint>;
	entries(handle: bigint): Promise<NativeEntry[]>;
	extract(handle: bigint, ids: readonly number[]): Promise<Buffer[]>;
	startStream(handle: bigint, id: number, callback: NativeStreamCallback): bigint;
	resumeStream(streamId: bigint): void;
	cancelStream(streamId: bigint): void;
	read(handle: bigint, id: number, offset: bigint, length: bigint): Promise<Buffer>;
	concurrency(value?: number): number;
	close(handle: bigint): void;
}

type NativeEntry = ArchiveEntry;

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
const packageDirectory = dirname(fileURLToPath(import.meta.url));
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

function makeOutputPlans(root: string, entries: readonly ArchiveEntry[]): OutputPlan[]
{
	const caseInsensitivePaths = process.platform === 'win32' || process.platform === 'darwin';
	const plans = entries.map((entry) => {
		const segments = safeEntrySegments(entry.path);
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

	constructor(
		private readonly start: (callback: NativeStreamCallback) => bigint,
		private readonly resumeNative: (streamId: bigint) => void,
		private readonly cancel: (streamId: bigint) => void,
		options: ReadStreamOptions,
		private readonly maxBytes: bigint | null,
	) {
		super({highWaterMark: options.highWaterMark, signal: options.signal});
	}

	override _read(): void {
		try
		{
			if(this.streamId === undefined)
			{
				this.streamId = this.start((chunk, error, done) => {
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
				});
				this.resumeNative(this.streamId);
			}
			else
			{
				this.resumeNative(this.streamId);
			}
		}
		catch (cause)
		{
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
		try
		{
			const handle = await native.open(resolve(path), options.password, enginePath);
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

	async entries(): Promise<readonly ArchiveEntry[]> {
		this.assertOpen();
		this.entriesPromise ??= native.entries(this.handle).catch((cause) => {
			throw new ArchiveError('ERR_ARCHIVE_OPEN', errorMessage(cause), {cause});
		});
		return this.entriesPromise;
	}

	async getEntry(idOrPath: EntryId | string): Promise<ArchiveEntry | undefined> {
		if(typeof idOrPath === 'number' && (!Number.isSafeInteger(idOrPath) || idOrPath < 0))
		{
			throw new RangeError('Entry ID must be a non-negative safe integer');
		}
		return (await this.entries()).find(entry =>
			typeof idOrPath === 'number' ? entry.id === idOrPath : entry.path === idOrPath);
	}

	async extract(id: EntryId): Promise<Buffer>;
	async extract(ids: readonly EntryId[]): Promise<Buffer[]>;
	async extract(idOrIds: EntryId | readonly EntryId[]): Promise<Buffer | Buffer[]> {
		this.assertOpen();
		const ids = Array.isArray(idOrIds) ? [...idOrIds] : [idOrIds as number];
		this.validateIds(ids);
		try
		{
			const buffers = await native.extract(this.handle, ids);
			return Array.isArray(idOrIds) ? buffers : buffers[0];
		}
		catch (cause)
		{
			throw extractionError(cause);
		}
	}

	createReadStream(id: EntryId, options: ReadStreamOptions = {}): Readable {
		this.assertOpen();
		this.validateIds([id]);
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
			callback => native.startStream(this.handle, id, callback),
			streamId => native.resumeStream(streamId),
			streamId => native.cancelStream(streamId),
			options,
			maxBytes,
		);
	}

	async extractToStream(
		id: EntryId,
		destination: Writable,
		options: ReadStreamOptions = {},
	): Promise<void> {
		if(!destination || typeof destination.write !== 'function')
		{
			throw new TypeError('Destination must be a writable stream');
		}
		await pipeline(this.createReadStream(id, options), destination, {signal: options.signal});
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
		options.signal?.throwIfAborted();
		const maxBytes = normalizeMaxBytes(options.maxBytes, 'maxBytes');
		const entries = await this.entries();
		let selectedEntries: readonly ArchiveEntry[] = entries;
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
		for(const plan of plans)
		{
			options.signal?.throwIfAborted();
			if(plan.isDirectory)
			{
				await ensureOutputDirectoryTree(root, plan.targetPath);
				continue;
			}
			await ensureOutputParents(root, plan.targetPath);
			const output = createWriteStream(plan.targetPath, {flags: 'wx', mode: 0o600});
			const limit = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					const size = BigInt(chunk.length);
					if(maxBytes !== null && extractedBytes + size > maxBytes)
					{
						callback(new ArchiveError(
							'ERR_RESOURCE_LIMIT',
							`Folder output exceeds the ${maxBytes}-byte limit`,
						));
						return;
					}
					extractedBytes += size;
					callback(null, chunk);
				},
			});
			await pipeline(
				this.createReadStream(plan.entry.id, {
					signal: options.signal,
					maxBytes: null,
				}),
				limit,
				output,
				{signal: options.signal},
			);
		}
	}

	async read(id: EntryId, options: ReadOptions): Promise<Buffer> {
		this.assertOpen();
		this.validateIds([id]);
		const offset = this.toUnsignedBigInt(options.offset ?? 0, 'offset');
		const length = this.toUnsignedBigInt(options.length, 'length');
		const maxUInt64 = (1n << 64n) - 1n;
		if(offset > maxUInt64 || length > maxUInt64 - offset)
		{
			throw new ArchiveError('ERR_INVALID_RANGE', 'Read range exceeds the native 64-bit offset limit');
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
