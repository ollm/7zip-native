import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {after, before, test} from 'node:test';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {Archive, ArchiveError} from '../dist/index.mjs';

const execFileAsync = promisify(execFile);
const sevenZip = createRequire(import.meta.url)('7zip-bin-full') as {path7z: string};
const testPassword = 'correct-horse';
const sampleDirectory = fileURLToPath(new URL('../samples/', import.meta.url));
const sampleArchives = ['sample.7z', 'sample.rar', 'sample.tar', 'sample.wim', 'sample.zip'] as const;
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

let directory = '';
let archivePath = '';
let gzipPath = '';
let sevenZipArchivePath = '';
let encryptedZipPath = '';

before(async () => {
	directory = await mkdtemp(join(tmpdir(), '7zip-native-'));
	archivePath = join(directory, 'fixture.cbz');
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
	await execFileAsync(sevenZip.path7z, [
		'a', '-t7z', '-y', '-bd', '-bb0', sevenZipArchivePath, protectedFilePath,
	]);
	await execFileAsync(sevenZip.path7z, [
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

test('reports folder extraction progress by bytes and files', async () => {
	const archive = await Archive.open(archivePath);
	const progress: Array<{
		filesExtracted: number;
		totalFiles: number;
		bytesProcessed: bigint;
		totalBytes: bigint;
		percent: number;
	}> = [];
	try
	{
		await archive.extractToFolder(join(directory, 'extracted-progress'), {
			paths: ['chapter/cover.jpg', 'empty.txt'],
			onProgress: (update) => {
				progress.push(update);
			},
		});
		assert.deepEqual(progress[0], {
			filesExtracted: 0,
			totalFiles: 2,
			bytesProcessed: 0n,
			totalBytes: 29n,
			percent: 0,
		});
		assert.deepEqual(progress.find(update =>
			update.bytesProcessed === 29n && update.filesExtracted === 0), {
			filesExtracted: 0,
			totalFiles: 2,
			bytesProcessed: 29n,
			totalBytes: 29n,
			percent: 99,
		});
		assert.deepEqual(progress.at(-1), {
			filesExtracted: 2,
			totalFiles: 2,
			bytesProcessed: 29n,
			totalBytes: 29n,
			percent: 100,
		});
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
