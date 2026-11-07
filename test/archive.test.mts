import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {after, before, test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {Archive, ArchiveError, type ArchiveEntry} from '../dist/index.mjs';

const execFileAsync = promisify(execFile);
const sevenZip = createRequire(import.meta.url)('7zip-bin-full') as {path7zc: string};
const testPassword = 'correct-horse';
const sampleDirectory = fileURLToPath(new URL('../samples/', import.meta.url));
const sourcePackageDirectory = fileURLToPath(new URL('../', import.meta.url));
const sampleArchives = ['sample.7z', 'sample.rar', 'sample.tar', 'sample.wim', 'sample.zip'] as const;
const truncatedSampleArchives = [
	'sample-truncated.rar',
	'sample-truncated.tar',
	'sample-truncated.zip',
] as const;
const sampleAssetPaths = [
	'sample/noise.avif',
	'sample/noise.jpg',
	'sample/noise.jxl',
	'sample/noise.png',
	'sample/noise.webp',
];

const crcTable = Uint32Array.from({length: 256}, (_, index) => {
	let crc = index;
	for(let bit = 0; bit < 8; bit++)
	{
		crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

function crc32(data: Buffer): number
{
	let crc = 0xffffffff;
	for(const byte of data)
	{
		crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(files: ReadonlyArray<{name: string; data: string}>): Buffer
{
	const localParts: Buffer[] = [];
	const directoryParts: Buffer[] = [];
	let localOffset = 0;
	for(const file of files)
	{
		const name = Buffer.from(file.name);
		const data = Buffer.from(file.data);
		const crc = crc32(data);
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x0800, 6);
		localHeader.writeUInt32LE(crc, 14);
		localHeader.writeUInt32LE(data.length, 18);
		localHeader.writeUInt32LE(data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localParts.push(localHeader, name, data);

		const directoryHeader = Buffer.alloc(46);
		directoryHeader.writeUInt32LE(0x02014b50, 0);
		directoryHeader.writeUInt16LE(20, 4);
		directoryHeader.writeUInt16LE(20, 6);
		directoryHeader.writeUInt16LE(0x0800, 8);
		directoryHeader.writeUInt32LE(crc, 16);
		directoryHeader.writeUInt32LE(data.length, 20);
		directoryHeader.writeUInt32LE(data.length, 24);
		directoryHeader.writeUInt16LE(name.length, 28);
		directoryHeader.writeUInt32LE(localOffset, 42);
		directoryParts.push(directoryHeader, name);
		localOffset += localHeader.length + name.length + data.length;
	}

	const centralDirectory = Buffer.concat(directoryParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(localOffset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

async function withPlatform(platform: string, operation: () => Promise<void>): Promise<void>
{
	const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
	assert.ok(descriptor?.configurable);
	Object.defineProperty(process, 'platform', {...descriptor, value: platform});
	try
	{
		await operation();
	}
	finally
	{
		Object.defineProperty(process, 'platform', descriptor);
	}
}

function stubNativeFileBatchExtraction(
	archive: Archive,
	extract: (
		outputs: readonly {id: number; path: string}[],
		signal: AbortSignal,
		onFileCompleted?: (id: number) => void,
	) => Promise<void>,
): void
{
	assert.equal(Reflect.set(archive, 'extractEntriesToFiles', extract), true);
}

let directory = '';
let archivePath = '';
let gzipPath = '';
let sevenZipArchivePath = '';
let encryptedZipPath = '';

test('resolves native binaries from the installed package when the entry point is relocated', async (context) => {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), '7zip-native-relocated-'));
	const bundleDirectory = join(fixtureDirectory, 'app/www/dist');
	const nodeModulesDirectory = join(fixtureDirectory, 'app/node_modules');
	const relocatedEntryPath = join(bundleDirectory, 'index.mjs');
	await mkdir(bundleDirectory, {recursive: true});
	await mkdir(nodeModulesDirectory, {recursive: true});
	try
	{
		await symlink(sourcePackageDirectory, join(nodeModulesDirectory, '7zip-native'), 'dir');
		await copyFile(fileURLToPath(new URL('../dist/index.mjs', import.meta.url)), relocatedEntryPath);
		const relocatedModule = await import(pathToFileURL(relocatedEntryPath).href);
		assert.equal(typeof relocatedModule.Archive, 'function');
	}
	catch(error)
	{
		if(error instanceof Error && 'code' in error && error.code === 'EPERM')
		{
			context.skip(`Package symlinks are unavailable: ${error.message}`);
			return;
		}
		throw error;
	}
	finally
	{
		await rm(fixtureDirectory, {recursive: true, force: true});
	}
});

before(async () => {
	directory = await mkdtemp(join(tmpdir(), '7zip-native-'));
	archivePath = join(directory, 'fixture.zip');
	gzipPath = join(directory, 'fixture.txt.gz');
	sevenZipArchivePath = join(directory, 'fixture.7z');
	const protectedFilePath = join(directory, 'protected.txt');
	encryptedZipPath = join(directory, 'protected.zip');
	await writeFile(archivePath, makeStoredZip([
		{name: 'chapter/cover.jpg', data: 'native 7-Zip reads this image'},
		{name: 'empty.txt', data: ''},
		{name: '読書/page.txt', data: 'Unicode path'},
	]));
	await writeFile(gzipPath, gzipSync('native gzip handler'));
	await writeFile(protectedFilePath, 'password-protected archive data');
	await execFileAsync(sevenZip.path7zc, [
		'a', '-t7z', '-y', '-bd', '-bb0', sevenZipArchivePath, protectedFilePath,
	]);
	await execFileAsync(sevenZip.path7zc, [
		'a', '-tzip', `-p${testPassword}`, '-mem=AES256', '-y', '-bd', '-bb0',
		encryptedZipPath, protectedFilePath,
	]);
});

after(async () => {
	await rm(directory, {recursive: true, force: true});
});

for(const format of ['zip', '7z', 'tar', 'wim'] as const)
{
	test(`creates and verifies a native ${format} archive from sample images`, async () => {
		const outputPath = join(directory, `created.${format}`);
		const sourceEntries = sampleAssetPaths.map(path => ({
			sourcePath: join(sampleDirectory, path),
			path,
		}));
		await Archive.create(outputPath, sourceEntries);
		const archive = await Archive.open(outputPath);
		try
		{
			const entries = await archive.entries();
			const files = entries.filter(entry => !entry.isDirectory);
			assert.deepEqual(files.map(entry => entry.path).sort(), sampleAssetPaths);
			for(const entry of files)
			{
				assert.deepEqual(
					await archive.extract(entry.id),
					await readFile(join(sampleDirectory, entry.path)),
					`${format}: ${entry.path}`,
				);
			}
		}
		finally
		{
			await archive.close();
		}
	});
}

test('creates archives atomically, enforces overwrite, and validates entry paths', async () => {
	const outputPath = join(directory, 'created-overwrite.zip');
	const [path] = sampleAssetPaths;
	assert.ok(path);
	const entry = {sourcePath: join(sampleDirectory, path), path};
	await Archive.create(outputPath, [entry]);
	await assert.rejects(Archive.create(outputPath, [entry]), {
		code: 'ERR_ARCHIVE_CREATE',
	});
	await Archive.create(outputPath, [entry], {overwrite: true, compressionLevel: 1});
	await assert.rejects(
		Archive.create(join(directory, 'unsafe.zip'), [{
			sourcePath: entry.sourcePath,
			path: '../outside.png',
		}]),
		(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
	);
	await assert.rejects(
		Archive.create(join(directory, 'duplicate.zip'), [entry, entry]),
		(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
	);
	await assert.rejects(
		Archive.create(join(directory, 'missing-source.zip'), [{
			sourcePath: join(directory, 'missing-source'),
			path: 'missing-source',
		}]),
		(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_CREATE',
	);
	await assert.rejects(
		Archive.create(join(directory, 'compressed.tar'), [entry], {compressionLevel: 1}),
		TypeError,
	);
});

test('creates archive entries with trailing spaces in their names', async () => {
	const sourcePath = join(directory, 'trailing-space-source.txt');
	const outputPath = join(directory, 'trailing-space-entry.zip');
	const entryPath = 'chapter/page:name.txt ';
	await writeFile(sourcePath, 'trailing space');
	await Archive.create(outputPath, [{sourcePath, path: entryPath}]);
	const archive = await Archive.open(outputPath);
	try
	{
		const entries = await archive.entries();
		assert.deepEqual(entries.map(entry => entry.path), [entryPath]);
	}
	finally
	{
		await archive.close();
	}
});

test('preserves source modification times in 7z archives', async () => {
	const sourcePath = join(directory, 'timestamp-source.txt');
	const outputPath = join(directory, 'timestamp-preserved.7z');
	const modified = new Date('2020-04-05T06:07:08.000Z');
	await writeFile(sourcePath, 'timestamp test');
	await utimes(sourcePath, modified, modified);
	await Archive.create(outputPath, [{sourcePath, path: 'timestamp-source.txt'}], {
		format: '7z',
	});

	const {stdout} = await execFileAsync(sevenZip.path7zc, ['l', '-slt', outputPath]);
	const displayOffset = new Date().getTimezoneOffset();
	const expectedModified = new Date(modified.getTime() - displayOffset * 60_000)
		.toISOString()
		.slice(0, 19)
		.replace('T', ' ');
	assert.match(stdout, new RegExp(`Modified = ${expectedModified}`));
});

test('opens, indexes, partially reads, and extracts ZIP entries', async () => {
	const archive = await Archive.open(archivePath);
	try
	{
		const entries = await archive.entries();
		assert.equal(entries.length, 3);
		const cover = await archive.getEntry('chapter/cover.jpg');
		assert.ok(cover);
		assert.equal(cover.size, 29n);
		assert.equal(typeof cover.compressedSize, 'bigint');
		assert.equal(typeof cover.crc, 'number');
		assert.equal((await archive.read(cover.id, {offset: 0, length: 6})).toString(), 'native');
		assert.equal((await archive.read('chapter/cover.jpg', {offset: 0, length: 6})).toString(), 'native');
		assert.equal((await archive.read(cover.id, {offset: 7, length: 4})).toString(), '7-Zi');
		const batch = await archive.read(
			[cover.id, 'empty.txt', cover.id, '読書/page.txt'],
			{offset: 2, length: 5},
		);
		assert.deepEqual(batch.map(buffer => buffer.toString()), [
			'tive ',
			'',
			'tive ',
			'icode',
		]);
		const variedBatch = await archive.read([
			{entry: cover.id, offset: 2, length: 5},
			{entry: 'empty.txt', length: 4},
			{entry: '読書/page.txt', offset: 0, length: 7},
		]);
		assert.deepEqual(variedBatch.map(buffer => buffer.toString()), ['tive ', '', 'Unicode']);
		assert.deepEqual(await archive.read([], {length: 5}), []);
		assert.deepEqual(await archive.read([]), []);
		assert.equal((await archive.read(cover.id, {offset: cover.size, length: 12})).length, 0);
		assert.equal((await archive.read(cover.id, {offset: 2, length: 0})).length, 0);
		assert.equal((await archive.extract(cover.id)).toString(), 'native 7-Zip reads this image');
		assert.equal((await archive.extract('chapter/cover.jpg')).toString(), 'native 7-Zip reads this image');
		const result = await archive.extract([entries[0]!.id, 'empty.txt', '読書/page.txt']);
		assert.equal(result[1]!.length, 0);
		assert.equal((await archive.getEntry('読書/page.txt'))?.path, '読書/page.txt');
		await assert.rejects(
			archive.extract('missing.txt'),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_INVALID_ENTRY',
		);
	}
	finally
	{
		await archive.close();
	}
});

test('indexes getEntry lookups by path and ID while preserving exact-match behavior', async () => {
	const indexArchivePath = join(directory, 'entry-index.zip');
	await writeFile(indexArchivePath, makeStoredZip([
		{name: '__proto__', data: 'prototype path'},
		{name: 'constructor', data: 'constructor path'},
		{name: 'duplicate.txt', data: 'first'},
		{name: 'duplicate.txt', data: 'second'},
	]));
	const archive = await Archive.open(indexArchivePath);
	try
	{
		const entries = await archive.entries();
		assert.equal((await archive.getEntry('__proto__'))?.id, entries[0]!.id);
		assert.equal((await archive.getEntry('constructor'))?.id, entries[1]!.id);
		assert.equal((await archive.getEntry('duplicate.txt'))?.id, entries[2]!.id);
		assert.equal((await archive.getEntry(entries[3]!.id))?.id, entries[3]!.id);
		assert.equal(await archive.getEntry('missing.txt'), undefined);
	}
	finally
	{
		await archive.close();
	}
});

test('configures the Deflate input buffer per archive and validates its range', async () => {
	const archivePath = join(sampleDirectory, 'sample.zip');
	const archive = await Archive.open(archivePath);
	const entry = (await archive.entries()).find(item => !item.isDirectory);
	assert.ok(entry);
	await archive.close();

	const expected = await readFile(join(sampleDirectory, entry.path));
	const sizes = [4 * 1024, 32 * 1024, 32 * 1024 + 1, 2 * 1024 * 1024];
	const archives = await Promise.all(sizes.map(deflateBufferSize =>
		Archive.open(archivePath, {deflateBufferSize})));
	try
	{
		const outputs = await Promise.all(archives.map(item => item.extract(entry.id)));
		for(const output of outputs)
		{
			assert.deepEqual(output, expected);
		}
	}
	finally
	{
		await Promise.all(archives.map(item => item.close()));
	}

	for(const deflateBufferSize of [4095, 2 * 1024 * 1024 + 1, 1.5, Number.NaN])
	{
		await assert.rejects(
			Archive.open(archivePath, {deflateBufferSize}),
			RangeError,
		);
	}
});

test('streams entry data with backpressure and supports early destruction', async () => {
	const archive = await Archive.open(join(sampleDirectory, 'sample.zip'));
	try
	{
		const entry = (await archive.entries()).find(item => !item.isDirectory);
		assert.ok(entry);
		const expected = await readFile(join(sampleDirectory, entry.path));
		const streamed: Buffer[] = [];
		for await (const chunk of archive.createReadStream(entry.path, {highWaterMark: 1}))
		{
			streamed.push(Buffer.from(chunk));
		}
		assert.deepEqual(Buffer.concat(streamed), expected);
		assert.ok(streamed.length > 1);
		assert.ok(streamed.every(chunk => chunk.length <= 64 * 1024));
		await assert.rejects(
			(async () => {
				for await (const _chunk of archive.createReadStream(entry.path, {maxBytes: 1})) {}
			})(),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_RESOURCE_LIMIT',
		);

		const backpressured: Buffer[] = [];
		const destination = new Writable({
			highWaterMark: 1,
			write(chunk, _encoding, callback) {
				backpressured.push(Buffer.from(chunk));
				setTimeout(callback, 1);
			},
		});
		await archive.extractToStream(entry.path, destination);
		assert.deepEqual(Buffer.concat(backpressured), expected);

		const earlyDestination = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
				this.destroy();
			},
		});
		await assert.rejects(		archive.extractToStream(entry.path, earlyDestination));

		const partialStream = archive.createReadStream(entry.id, {highWaterMark: 1});
		let chunksBeforeClose = 0;
		await new Promise<void>((resolvePromise, rejectPromise) => {
			partialStream.once('error', rejectPromise);
			partialStream.once('close', resolvePromise);
			partialStream.on('data', () => {
				chunksBeforeClose++;
				partialStream.destroy();
			});
		});
		assert.equal(chunksBeforeClose, 1);
	}
	finally
	{
		await archive.close();
	}
});

test('extracts archive entries to a folder without overwriting existing files', async () => {
	const archive = await Archive.open(archivePath);
	const destination = join(directory, 'extracted');
	try
	{
		const limitedDestination = join(directory, 'extracted-limited');
		await assert.rejects(
			archive.extractToFolder(limitedDestination, {maxBytes: 1}),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_RESOURCE_LIMIT',
		);
		await assert.rejects(readFile(limitedDestination), {code: 'ENOENT'});
		await archive.extractToFolder(destination);
		const entries = await archive.entries();
		const expectedFiles = new Map([
			['chapter/cover.jpg', Buffer.from('native 7-Zip reads this image')],
			['empty.txt', Buffer.alloc(0)],
			['読書/page.txt', Buffer.from('Unicode path')],
		]);
		for(const entry of entries.filter(item => !item.isDirectory))
		{
			assert.deepEqual(await readFile(join(destination, entry.path)), expectedFiles.get(entry.path));
		}
		const selectedDestination = join(directory, 'extracted-selected');
		await archive.extractToFolder(selectedDestination, {paths: ['chapter/cover.jpg']});
		assert.equal(
			(await readFile(join(selectedDestination, 'chapter/cover.jpg'))).toString(),
			'native 7-Zip reads this image',
		);
		await assert.rejects(
			archive.extractToFolder(join(directory, 'extracted-invalid'), {
				ids: [entries[0]!.id],
				paths: ['chapter/cover.jpg'],
			}),
			TypeError,
		);
		await assert.rejects(
			archive.extractToFolder(join(directory, 'extracted-missing'), {paths: ['missing.txt']}),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_INVALID_ENTRY',
		);
		await assert.rejects(
			archive.extractToFolder(destination),
			(error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST',
		);
		const coverPath = join(destination, 'chapter/cover.jpg');
		await writeFile(coverPath, 'old content');
		await archive.extractToFolder(destination, {
			paths: ['chapter/cover.jpg'],
			overwrite: true,
		});
		assert.equal((await readFile(coverPath)).toString(), 'native 7-Zip reads this image');
	}
	finally
	{
		await archive.close();
	}
});

test('calls onExtract once per file after final output is ready', async () => {
	const archive = await Archive.open(archivePath);
	const destination = join(directory, 'extracted-callback');
	const coverPath = join(destination, 'chapter/cover.jpg');
	const emptyPath = join(destination, 'empty.txt');
	await mkdir(join(destination, 'chapter'), {recursive: true});
	await writeFile(coverPath, 'old cover');
	await writeFile(emptyPath, 'old empty');
	const expected = new Map([
		['chapter/cover.jpg', Buffer.from('native 7-Zip reads this image')],
		['empty.txt', Buffer.alloc(0)],
	]);
	const extracted: Array<{entry: ArchiveEntry; outputPath: string; percent: number}> = [];
	try
	{
		await archive.extractToFolder(destination, {
			paths: ['chapter/cover.jpg', 'empty.txt'],
			overwrite: true,
			onExtract: (result) => {
				extracted.push(result);
				assert.deepEqual(readFileSync(result.outputPath), expected.get(result.entry.path));
			},
		});
		assert.deepEqual(extracted.map(result => ({
			path: result.entry.path,
			outputPath: result.outputPath,
		})).sort((left, right) => left.path.localeCompare(right.path)), [
			{path: 'empty.txt', outputPath: emptyPath},
			{path: 'chapter/cover.jpg', outputPath: coverPath},
		].sort((left, right) => left.path.localeCompare(right.path)));
		assert.deepEqual(extracted.map(result => result.percent), [50, 100]);
	}
	finally
	{
		await archive.close();
	}
});

test('waits for all file completion callbacks across concurrent archive instances', async () => {
	const paths = Array.from({length: 48}, (_, index) => ({
		name: `files/${index}.txt`,
		data: `file ${index}`,
	}));
	const localArchivePath = join(directory, 'concurrent-folder-callbacks.zip');
	await writeFile(localArchivePath, makeStoredZip(paths));
	const previousConcurrency = Archive.concurrency();
	const archives = await Promise.all(Array.from({length: 4}, () => Archive.open(localArchivePath)));
	const entries = await archives[0]!.entries();
	const expectedIds = entries.filter(entry => !entry.isDirectory).map(entry => entry.id).sort((a, b) => a - b);
	try
	{
		Archive.concurrency(4);
		for(let iteration = 0; iteration < 4; iteration++)
		{
			await Promise.all(archives.map(async (archive, index) => {
				const completedIds: number[] = [];
				await archive.extractToFolder(join(directory, `concurrent-callbacks-${iteration}-${index}`), {
					concurrency: 1,
					onExtract: ({entry}) => completedIds.push(entry.id),
				});
				assert.deepEqual(completedIds.sort((a, b) => a - b), expectedIds);
			}));
		}
	}
	finally
	{
		Archive.concurrency(previousConcurrency);
		await Promise.all(archives.map(archive => archive.close()));
	}
});

test('sanitizes Windows output paths without changing path selectors or entry metadata', async () => {
	const archivePath = join(directory, 'windows-output-paths.zip');
	const internalPath = 'folder. /bad<>\t:|?*". ';
	await writeFile(archivePath, makeStoredZip([
		{name: internalPath, data: 'sanitized'},
		{name: 'CON.txt', data: 'reserved'},
	]));
	const archive = await Archive.open(archivePath);
	const [entry, reservedEntry] = await archive.entries();
	assert.ok(entry);
	assert.ok(reservedEntry);
	assert.equal(
		entry.extractedPath,
		process.platform === 'win32'
			? join('folder__', 'bad__________')
			: join('folder. ', 'bad<>\t:|?*". '),
	);
	assert.equal(reservedEntry.extractedPath, process.platform === 'win32' ? '_CON.txt' : 'CON.txt');
	const byPathDestination = join(directory, 'windows-output-by-path');
	const byIdDestination = join(directory, 'windows-output-by-id');
	const reservedDestination = join(directory, 'windows-output-reserved');
	const sanitizedPath = join(byPathDestination, 'folder__', 'bad__________');
	try
	{
		await withPlatform('win32', async () => {
			const events: Array<{entry: ArchiveEntry; outputPath: string; percent: number}> = [];
			await archive.extractToFolder(byPathDestination, {
				paths: [internalPath],
				onExtract: (result) => events.push(result),
			});
			assert.deepEqual(events, [{entry, outputPath: sanitizedPath, percent: 100}]);
			await archive.extractToFolder(byIdDestination, {ids: [entry.id]});
			await archive.extractToFolder(reservedDestination, {ids: [reservedEntry.id]});
		});
		assert.equal((await readFile(sanitizedPath)).toString(), 'sanitized');
		assert.equal(
			(await readFile(join(byIdDestination, 'folder__', 'bad__________'))).toString(),
			'sanitized',
		);
		assert.equal((await readFile(join(reservedDestination, '_CON.txt'))).toString(), 'reserved');
		assert.equal(entry.path, internalPath);
		assert.equal(reservedEntry.path, 'CON.txt');
	}
	finally
	{
		await archive.close();
	}
});

test('preserves platform-supported output path characters outside Windows', {
	skip: process.platform === 'win32',
}, async () => {
	const archivePath = join(directory, 'platform-supported-output-paths.zip');
	const internalPath = 'folder. /bad:name. ';
	await writeFile(archivePath, makeStoredZip([{name: internalPath, data: 'preserved'}]));
	const archive = await Archive.open(archivePath);
	try
	{
		for(const platform of ['linux', 'darwin'])
		{
			const destination = join(directory, `${platform}-output-paths`);
			await withPlatform(platform, () => archive.extractToFolder(destination));
			assert.equal(
				(await readFile(join(destination, 'folder. ', 'bad:name. '))).toString(),
				'preserved',
			);
		}
	}
	finally
	{
		await archive.close();
	}
});

test('rejects Windows-sanitized traversal and path collisions', async () => {
	const traversalArchivePath = join(directory, 'windows-traversal.zip');
	const collisionArchivePath = join(directory, 'windows-collision.zip');
	await writeFile(traversalArchivePath, makeStoredZip([{name: '../escape.txt', data: 'outside'}]));
	await writeFile(collisionArchivePath, makeStoredZip([
		{name: 'same<.txt', data: 'first'},
		{name: 'same>.txt', data: 'second'},
	]));
	const traversalArchive = await Archive.open(traversalArchivePath);
	const collisionArchive = await Archive.open(collisionArchivePath);
	const traversalDestination = join(directory, 'windows-traversal-output');
	const collisionDestination = join(directory, 'windows-collision-output');
	try
	{
		await withPlatform('win32', async () => {
			await assert.rejects(
				traversalArchive.extractToFolder(traversalDestination),
				(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
			);
			await assert.rejects(
				collisionArchive.extractToFolder(collisionDestination),
				(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
			);
		});
		await assert.rejects(readFile(traversalDestination), {code: 'ENOENT'});
		await assert.rejects(readFile(collisionDestination), {code: 'ENOENT'});
		await assert.rejects(readFile(join(directory, 'escape.txt')), {code: 'ENOENT'});
	}
	finally
	{
		await Promise.all([traversalArchive.close(), collisionArchive.close()]);
	}
});

test('rejects symlinked Windows-sanitized output parents', async (context) => {
	const archivePath = join(directory, 'windows-symlink.zip');
	const destination = join(directory, 'windows-symlink-output');
	const outside = join(directory, 'windows-symlink-target');
	await writeFile(archivePath, makeStoredZip([{name: 'dir. /file?.txt', data: 'outside'}]));
	await mkdir(destination, {recursive: true});
	await mkdir(outside);
	try
	{
		await symlink(outside, join(destination, 'dir__'), 'dir');
	}
	catch(error)
	{
		context.skip(`Directory symlinks are unavailable: ${String(error)}`);
		return;
	}

	const archive = await Archive.open(archivePath);
	try
	{
		await withPlatform('win32', async () => {
			await assert.rejects(
				archive.extractToFolder(destination),
				(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
			);
		});
		await assert.rejects(readFile(join(outside, 'file_.txt')), {code: 'ENOENT'});
	}
	finally
	{
		await archive.close();
	}
});

test('does not follow a symlink when overwriting an extracted file', async (context) => {
	const destination = join(directory, 'overwrite-symlink-output');
	const outsideFile = join(directory, 'overwrite-symlink-target.txt');
	await mkdir(join(destination, 'chapter'), {recursive: true});
	await writeFile(outsideFile, 'keep this file');
	try
	{
		await symlink(outsideFile, join(destination, 'chapter/cover.jpg'));
	}
	catch(error)
	{
		context.skip(`File symlinks are unavailable: ${String(error)}`);
		return;
	}

	const archive = await Archive.open(archivePath);
	try
	{
		await assert.rejects(
			archive.extractToFolder(destination, {
				paths: ['chapter/cover.jpg'],
				overwrite: true,
			}),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
		);
		assert.equal((await readFile(outsideFile)).toString(), 'keep this file');
	}
	finally
	{
		await archive.close();
	}
});

test('reports completion percentage with each extracted file', async () => {
	const archive = await Archive.open(archivePath);
	const extracted: Array<{path: string; percent: number}> = [];
	try
	{
		await archive.extractToFolder(join(directory, 'extracted-progress'), {
			paths: ['chapter/cover.jpg', 'empty.txt'],
			onExtract: ({entry, percent}) => extracted.push({path: entry.path, percent}),
		});
		assert.deepEqual(extracted.map(file => file.percent), [50, 100]);
		assert.deepEqual(extracted.map(file => file.path).sort(), ['chapter/cover.jpg', 'empty.txt']);
	}
	finally
	{
		await archive.close();
	}
});

test('bounds folder extraction concurrency and reports completion out of order', async () => {
	const localArchivePath = join(directory, 'concurrent-folder.zip');
	const destination = join(directory, 'concurrent-folder-output');
	const defaultDestination = join(directory, 'default-concurrent-folder-output');
	const cappedDestination = join(directory, 'concurrent-folder-capped-output');
	await writeFile(localArchivePath, makeStoredZip([
		{name: 'slow.txt', data: 'abcdef'},
		{name: 'fast.txt', data: 'wxyz'},
		{name: 'middle.txt', data: '123'},
	]));
	const archive = await Archive.open(localArchivePath);
	const entries = await archive.entries();
	const entriesById = new Map(entries.map(entry => [entry.id, entry]));
	const previousConcurrency = Archive.concurrency();
	let active = 0;
	let maximumActive = 0;
	const completions: string[] = [];
	try
	{
		Archive.concurrency(4);
		let slowCompletedBeforeGroupFinished = false;
		stubNativeFileBatchExtraction(archive, async (
			outputs,
			signal,
			onFileCompleted,
		) => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			try
			{
				for(const output of outputs)
				{
					const entry = entriesById.get(output.id);
					assert.ok(entry);
					let contents: Buffer;
					if(entry.path === 'slow.txt')
					{
						await delay(5, undefined, {signal});
						contents = Buffer.from('abc');
						await delay(40, undefined, {signal});
						contents = Buffer.concat([contents, Buffer.from('def')]);
					}
					else if(entry.path === 'fast.txt')
					{
						await delay(10, undefined, {signal});
						contents = Buffer.from('wxyz');
					}
					else
					{
						await delay(5, undefined, {signal});
						contents = Buffer.from('123');
					}
					await writeFile(output.path, contents);
					onFileCompleted?.(output.id);
					if(entry.path === 'slow.txt')
					{
						await delay(20, undefined, {signal});
						slowCompletedBeforeGroupFinished = completions.includes('slow.txt');
					}
				}
			}
			finally
			{
				active--;
			}
		});

		await archive.extractToFolder(destination, {
			concurrency: 2,
			onExtract: ({entry, percent}) => {
				completions.push(entry.path);
				assert.equal(percent, completions.length * 100 / 3);
			},
		});
		assert.equal(maximumActive, 2);
		assert.equal(active, 0);
		assert.deepEqual(completions, ['fast.txt', 'slow.txt', 'middle.txt']);
		assert.equal(slowCompletedBeforeGroupFinished, true);
		assert.equal(Archive.concurrency(), 4);
		assert.deepEqual(await readFile(join(destination, 'slow.txt')), Buffer.from('abcdef'));
		assert.deepEqual(await readFile(join(destination, 'fast.txt')), Buffer.from('wxyz'));
		assert.deepEqual(await readFile(join(destination, 'middle.txt')), Buffer.from('123'));

		active = 0;
		maximumActive = 0;
		await archive.extractToFolder(defaultDestination);
		assert.equal(maximumActive, 1);
		assert.equal(Archive.concurrency(), 4);

		active = 0;
		maximumActive = 0;
		Archive.concurrency(1);
		await archive.extractToFolder(cappedDestination, {concurrency: 8});
		assert.equal(maximumActive, 1);
		assert.equal(Archive.concurrency(), 1);

		for(const concurrency of [0, 1.5, 129])
		{
			await assert.rejects(
				archive.extractToFolder(join(directory, `invalid-concurrency-${concurrency}`), {concurrency}),
				RangeError,
			);
		}
	}
	finally
	{
		Archive.concurrency(previousConcurrency);
		await archive.close();
	}
});

test('stops scheduling on extraction failure', async () => {
	const localArchivePath = join(directory, 'failed-concurrent-folder.zip');
	const destination = join(directory, 'failed-concurrent-folder-output');
	await writeFile(localArchivePath, makeStoredZip([
		{name: 'fail.txt', data: 'fail'},
		{name: 'active.txt', data: 'active'},
		{name: 'queued.txt', data: 'queued'},
	]));
	await mkdir(destination);
	for(const name of ['fail.txt', 'active.txt', 'queued.txt'])
	{
		await writeFile(join(destination, name), `old ${name}`);
	}
	const archive = await Archive.open(localArchivePath);
	const entriesById = new Map((await archive.entries()).map(entry => [entry.id, entry]));
	const previousConcurrency = Archive.concurrency();
	let active = 0;
	let started = 0;
	try
	{
		Archive.concurrency(4);
		stubNativeFileBatchExtraction(archive, async (outputs, signal) => {
			active++;
			started++;
			try
			{
				const entries = outputs.map(output => {
					const entry = entriesById.get(output.id);
					assert.ok(entry);
					return {output, entry};
				});
				if(entries.some(({entry}) => entry.path === 'fail.txt'))
				{
					await delay(10, undefined, {signal});
					throw new Error('injected extraction failure');
				}
				await delay(1000, undefined, {signal});
				for(const {output, entry} of entries)
				{
					const contents = Buffer.from(entry.path);
					await writeFile(output.path, contents);
				}
			}
			finally
			{
				active--;
			}
		});

		await assert.rejects(
			archive.extractToFolder(destination, {concurrency: 2, overwrite: true}),
			/injected extraction failure/,
		);
		assert.equal(started, 2);
		assert.equal(active, 0);
		assert.deepEqual((await readdir(destination)).sort(), ['active.txt', 'fail.txt', 'queued.txt']);
		for(const name of ['fail.txt', 'active.txt', 'queued.txt'])
		{
			assert.equal((await readFile(join(destination, name))).toString(), `old ${name}`);
		}
	}
	finally
	{
		Archive.concurrency(previousConcurrency);
		await archive.close();
	}
});

test('cancels active folder extractions before rejecting', async () => {
	const localArchivePath = join(directory, 'cancelled-concurrent-folder.zip');
	const destination = join(directory, 'cancelled-concurrent-folder-output');
	await writeFile(localArchivePath, makeStoredZip([
		{name: 'first.txt', data: 'first'},
		{name: 'second.txt', data: 'second'},
		{name: 'queued.txt', data: 'queued'},
	]));
	await mkdir(destination);
	for(const name of ['first.txt', 'second.txt', 'queued.txt'])
	{
		await writeFile(join(destination, name), `old ${name}`);
	}
	const archive = await Archive.open(localArchivePath);
	const entriesById = new Map((await archive.entries()).map(entry => [entry.id, entry]));
	const previousConcurrency = Archive.concurrency();
	const controller = new AbortController();
	let active = 0;
	let started = 0;
	let resolveTwoStarted!: () => void;
	const twoStarted = new Promise<void>((resolve) => {
		resolveTwoStarted = resolve;
	});
	try
	{
		Archive.concurrency(4);
		stubNativeFileBatchExtraction(archive, async (outputs, signal) => {
			active++;
			started++;
			if(started === 2)
			{
				resolveTwoStarted();
			}
			try
			{
				await delay(1000, undefined, {signal});
				for(const output of outputs)
				{
					const entry = entriesById.get(output.id);
					assert.ok(entry);
					const contents = Buffer.from(entry.path);
					await writeFile(output.path, contents);
				}
			}
			finally
			{
				active--;
			}
		});

		const extraction = archive.extractToFolder(destination, {
			concurrency: 2,
			overwrite: true,
			signal: controller.signal,
		});
		await Promise.race([
			twoStarted,
			delay(1000).then(() => {
				throw new Error('Timed out waiting for concurrent extractions to start');
			}),
		]);
		controller.abort();
		await assert.rejects(extraction);
		assert.equal(started, 2);
		assert.equal(active, 0);
		assert.deepEqual((await readdir(destination)).sort(), ['first.txt', 'queued.txt', 'second.txt']);
		for(const name of ['first.txt', 'second.txt', 'queued.txt'])
		{
			assert.equal((await readFile(join(destination, name))).toString(), `old ${name}`);
		}
	}
	finally
	{
		Archive.concurrency(previousConcurrency);
		await archive.close();
	}
});

test('cancels native file writes and removes incomplete overwritten outputs', async () => {
	const localArchivePath = join(directory, 'cancelled-native-folder.zip');
	const destination = join(directory, 'cancelled-native-folder-output');
	const largeOutputPath = join(destination, 'large.bin');
	await writeFile(localArchivePath, makeStoredZip([
		{name: 'first.txt', data: 'first'},
		{name: 'large.bin', data: 'x'.repeat(64 * 1024 * 1024)},
	]));
	await mkdir(destination);
	await writeFile(join(destination, 'first.txt'), 'old first');
	await writeFile(largeOutputPath, 'old large');
	const archive = await Archive.open(localArchivePath);
	const controller = new AbortController();
	try
	{
		const abortReason = new Error('cancelled native file write');
		await assert.rejects(archive.extractToFolder(destination, {
			overwrite: true,
			signal: controller.signal,
			onExtract: ({entry}) => {
				if(entry.path === 'first.txt')
				{
					controller.abort(abortReason);
				}
			},
		}), error => error === abortReason);
		assert.equal((await readFile(join(destination, 'first.txt'))).toString(), 'first');
		await assert.rejects(readFile(largeOutputPath), {code: 'ENOENT'});
		assert.deepEqual(await readdir(destination), ['first.txt']);
	}
	finally
	{
		await archive.close();
	}
});

test('rejects archive path traversal before creating extraction output', async () => {
	const maliciousArchive = join(directory, 'traversal.zip');
	const destination = join(directory, 'traversal-output');
	const escapedFile = join(directory, 'escape.txt');
	await writeFile(maliciousArchive, makeStoredZip([{name: '../escape.txt', data: 'outside'}]));
	const archive = await Archive.open(maliciousArchive);
	try
	{
		await assert.rejects(
			archive.extractToFolder(destination),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
		);
		await assert.rejects(readFile(escapedFile), {code: 'ENOENT'});
		await assert.rejects(readFile(destination), {code: 'ENOENT'});
	}
	finally
	{
		await archive.close();
	}
});

test('rejects symlinked destination parents during folder extraction', async (context) => {
	const destination = join(directory, 'symlink-output');
	const outside = join(directory, 'symlink-target');
	await mkdir(destination);
	await mkdir(outside);
	try
	{
		await symlink(outside, join(destination, 'chapter'), 'dir');
	}
	catch(error)
	{
		context.skip(`Directory symlinks are unavailable: ${String(error)}`);
		return;
	}

	const archive = await Archive.open(archivePath);
	try
	{
		await assert.rejects(
			archive.extractToFolder(destination),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PATH',
		);
		await assert.rejects(readFile(join(outside, 'cover.jpg')), {code: 'ENOENT'});
	}
	finally
	{
		await archive.close();
	}
});

test('configures and resets the process-wide native extraction concurrency', () => {
	const defaultConcurrency = Archive.concurrency();
	assert.ok(defaultConcurrency >= 1 && defaultConcurrency <= 4);
	try
	{
		assert.equal(Archive.concurrency(1), 1);
		assert.equal(Archive.concurrency(), 1);
		assert.equal(Archive.concurrency(0), defaultConcurrency);
		assert.throws(() => Archive.concurrency(1.5), RangeError);
	}
	finally
	{
		Archive.concurrency(defaultConcurrency);
	}
});

for(const archiveName of sampleArchives)
{
	test(`extracts entries concurrently from one ${archiveName} handle`, async () => {
		const previousConcurrency = Archive.concurrency();
		Archive.concurrency(4);
		let archive: Archive | undefined;
		try
		{
			const opened = await Archive.open(join(sampleDirectory, archiveName));
			archive = opened;
			const entries = await opened.entries();
			const files = entries.filter(entry => !entry.isDirectory);
			Archive.concurrency(1);
			const first = files[0];
			assert.ok(first);
			assert.deepEqual(
				await opened.extract(first.id),
				await readFile(join(sampleDirectory, first.path)),
			);
			Archive.concurrency(4);
			const [extracted, prefixes] = await Promise.all([
				Promise.all(files.map(entry => opened.extract(entry.id))),
				Promise.all(files.map(entry => opened.read(entry.id, {offset: 0, length: 32}))),
			]);

			assert.equal(Archive.concurrency(), 4);
			assert.deepEqual(files.map(entry => entry.path).sort(), sampleAssetPaths);
			for(let i = 0; i < files.length; i++)
			{
				const expected = await readFile(join(sampleDirectory, files[i]!.path));
				assert.deepEqual(extracted[i], expected, `${archiveName}: ${files[i]!.path}`);
				assert.deepEqual(prefixes[i], expected.subarray(0, 32), `${archiveName}: ${files[i]!.path} prefix`);
			}
			assert.throws(() => Archive.concurrency(1.5), RangeError);
		}
		finally
		{
			await archive?.close();
			Archive.concurrency(previousConcurrency);
		}
	});
}

test('opens and extracts a standalone GZIP stream through the native handler', async () => {
	const archive = await Archive.open(gzipPath);
	try
	{
		const [entry] = await archive.entries();
		assert.ok(entry);
		assert.equal((await archive.extract(entry.id)).toString(), 'native gzip handler');
	}
	finally
	{
		await archive.close();
	}
});

test('opens and extracts entries from 7z archives', async () => {
	const archive = await Archive.open(sevenZipArchivePath);
	try
	{
		const entries = await archive.entries();
		const file = entries.find(entry => !entry.isDirectory);
		assert.ok(file);
		assert.equal((await archive.extract(file.id)).toString(), 'password-protected archive data');
	}
	finally
	{
		await archive.close();
	}
});

for(const archiveName of sampleArchives)
{
	test(`opens and extracts the sample ${archiveName}`, async () => {
		const archive = await Archive.open(join(sampleDirectory, archiveName));
		try
		{
			const entries = await archive.entries();
			const files = entries.filter(entry => !entry.isDirectory);
			assert.deepEqual(files.map(entry => entry.path).sort(), sampleAssetPaths);

			const extracted = await archive.extract(files.map(entry => entry.id));
			assert.equal(extracted.length, files.length);
			for(let i = 0; i < files.length; i++)
			{
				const entry = files[i]!;
				const expected = await readFile(join(sampleDirectory, entry.path));
				assert.equal(entry.size, BigInt(expected.length), `${archiveName}: ${entry.path} size`);
				assert.deepEqual(extracted[i], expected, `${archiveName}: ${entry.path} contents`);
			}
			const first = files[0]!;
			const streamed: Buffer[] = [];
			for await (const chunk of archive.createReadStream(first.id))
			{
				streamed.push(Buffer.from(chunk));
			}
			assert.deepEqual(
				Buffer.concat(streamed),
				await readFile(join(sampleDirectory, first.path)),
				`${archiveName}: streamed ${first.path}`,
			);
		}
		finally
		{
			await archive.close();
		}
	});
}

for(const archiveName of truncatedSampleArchives)
{
	test(`lists and extracts the first file from ${archiveName}`, async () => {
		const archive = await Archive.open(join(sampleDirectory, archiveName));
		try
		{
			const entries = await archive.entries();
			assert.ok(entries.length > 0, `${archiveName}: expected at least one entry`);
			const first = entries.find(entry => !entry.isDirectory);
			assert.ok(first, `${archiveName}: expected at least one file`);
			assert.deepEqual(
				await archive.extract(first.id),
				await readFile(join(sampleDirectory, first.path)),
				`${archiveName}: ${first.path}`,
			);
		}
		finally
		{
			await archive.close();
		}
	});
}

test('opens encrypted ZIP entries and reads them with a password', async () => {
	const zip = await Archive.open(encryptedZipPath, {password: testPassword});
	try
	{
		const [entry] = await zip.entries();
		assert.ok(entry);
		assert.equal(entry.encrypted, true);
		assert.equal((await zip.extract(entry.id)).toString(), 'password-protected archive data');
		const streamed: Buffer[] = [];
		for await (const chunk of zip.createReadStream(entry.id))
		{
			streamed.push(Buffer.from(chunk));
		}
		assert.equal(Buffer.concat(streamed).toString(), 'password-protected archive data');
		assert.equal(
			(await zip.read(entry.id, {offset: 9, length: 10})).toString(),
			'protected ',
		);
	}
	finally
	{
		await zip.close();
	}
});

test('reports missing and incorrect archive passwords', async () => {
	const unencryptedHeaders = await Archive.open(encryptedZipPath);
	try
	{
		const [entry] = await unencryptedHeaders.entries();
		assert.ok(entry);
		await assert.rejects(
			unencryptedHeaders.extract(entry.id),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PASSWORD',
		);
	}
	finally
	{
		await unencryptedHeaders.close();
	}

	const wrongPassword = await Archive.open(encryptedZipPath, {password: 'incorrect'});
	try
	{
		const [entry] = await wrongPassword.entries();
		assert.ok(entry);
		await assert.rejects(
			wrongPassword.extract(entry.id),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PASSWORD',
		);
		const destination = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		await assert.rejects(
			wrongPassword.extractToStream(entry.id, destination),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_PASSWORD',
		);
	}
	finally
	{
		await wrongPassword.close();
	}

});

test('allows independent archive handles to use the native worker pool concurrently', async () => {
	const [left, right] = await Promise.all([
		Archive.open(archivePath),
		Archive.open(archivePath),
	]);
	try
	{
		const [[leftEntry], [rightEntry]] = await Promise.all([left.entries(), right.entries()]);
		assert.ok(leftEntry);
		assert.ok(rightEntry);
		const [leftData, rightData] = await Promise.all([
			left.read(leftEntry.id, {offset: 0, length: 6}),
			right.read(rightEntry.id, {offset: 0, length: 6}),
		]);
		assert.equal(leftData.toString(), 'native');
		assert.equal(rightData.toString(), 'native');
	}
	finally
	{
		await Promise.all([left.close(), right.close()]);
	}
});

test('retains submitted work while closing and rejects subsequent operations', async () => {
	const archive = await Archive.open(archivePath);
	const [entry] = await archive.entries();
	assert.ok(entry);
	const pending = archive.extract(entry.id);
	await archive.close();
	assert.equal((await pending).toString(), 'native 7-Zip reads this image');
	await assert.rejects(archive.entries(), ArchiveError);
});

test('reports invalid entry IDs and rejects invalid archives', async () => {
	const archive = await Archive.open(archivePath);
	try
	{
		await assert.rejects(
			archive.extract(999),
			(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_INVALID_ENTRY',
		);
	}
	finally
	{
		await archive.close();
	}
	const badPath = join(directory, 'broken.zip');
	await writeFile(badPath, 'not an archive');
	await assert.rejects(
		Archive.open(badPath),
		(error: unknown) => error instanceof ArchiveError && error.code === 'ERR_ARCHIVE_OPEN',
	);
});
