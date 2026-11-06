'use strict';

const {spawn} = require('node:child_process');
const {mkdtemp, rm, stat} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');

function elapsedMs(start)
{
	return Number(process.hrtime.bigint() - start) / 1e6;
}

function errorText(chunks)
{
	return Buffer.concat(chunks).toString('utf8').trim();
}

async function extractNative(Archive, archivePath, outputPath, files, deflateBufferSize)
{
	const started = process.hrtime.bigint();
	let archive;
	try
	{
		archive = await Archive.open(archivePath, {deflateBufferSize});
		await archive.extractToFolder(outputPath, {
			paths: files.map(file => file.path),
			concurrency: 1,
		});
	}
	finally
	{
		await archive?.close();
	}
	return elapsedMs(started);
}

function extractWithCli(binaryPath, archivePath, outputPath, files)
{
	return new Promise((resolve, reject) => {
		const started = process.hrtime.bigint();
		const args = [
			'x',
			archivePath,
			...files.map(file => file.path),
			`-o${outputPath}`,
			'-y',
			'-bd',
			'-bb0',
			'-mmt=1',
			'-sccUTF-8',
			'-spd',
		];
		const child = spawn(binaryPath, args, {stdio: ['ignore', 'ignore', 'pipe']});
		const stderr = [];
		let stderrLength = 0;
		child.stderr.on('data', chunk => {
			if(stderrLength < 64 * 1024)
			{
				const kept = chunk.subarray(0, 64 * 1024 - stderrLength);
				stderr.push(kept);
				stderrLength += kept.length;
			}
		});
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if(code !== 0)
			{
				const detail = errorText(stderr);
				reject(new Error(
					`7zip-bin-full exited with ${signal ?? code}${detail ? `: ${detail}` : ''}`,
				));
				return;
			}
			resolve(elapsedMs(started));
		});
	});
}

function safeOutputPath(root, entryPath)
{
	const normalized = entryPath.replace(/\\/g, '/');
	const parts = normalized.split('/').filter(part => part !== '' && part !== '.');
	if(normalized.startsWith('/') || parts.length === 0 || parts.some(part => part === '..'))
	{
		throw new Error(`Unsafe archive path in benchmark input: ${entryPath}`);
	}
	return path.resolve(root, ...parts);
}

async function verifyOutput(outputPath, files)
{
	let totalBytes = 0n;
	for(const file of files)
	{
		const outputFile = safeOutputPath(outputPath, file.path);
		const outputStat = await stat(outputFile);
		if(!outputStat.isFile() || BigInt(outputStat.size) !== file.size)
		{
			throw new Error(
				`Extraction mismatch for ${file.path}: expected ${file.size} bytes, got ${outputStat.size}`,
			);
		}
		totalBytes += file.size;
	}
	return totalBytes;
}

async function runWave(
	backend,
	Archive,
	binaryPath,
	archivePath,
	groups,
	expectedFileCount,
	parallelOperations,
	deflateBufferSize,
)
{
	if(groups.length !== parallelOperations
		|| groups.some(files => files.length === 0)
		|| groups.reduce((sum, files) => sum + files.length, 0) !== expectedFileCount)
	{
		throw new Error(`The concurrent operations must partition exactly ${expectedFileCount} files`);
	}

	const temporaryRoot = await mkdtemp(path.join(tmpdir(), '7zip-native-parallel-extract-'));
	const started = process.hrtime.bigint();
	try
	{
		const operations = groups.map((files, index) => {
			const outputPath = path.join(temporaryRoot, `operation-${index + 1}`);
			return backend === 'native'
				? extractNative(Archive, archivePath, outputPath, files, deflateBufferSize)
				: extractWithCli(binaryPath, archivePath, outputPath, files);
		});
		let operationTimes;
		try
		{
			operationTimes = await Promise.all(operations);
		}
		catch(error)
		{
			await Promise.allSettled(operations);
			throw error;
		}
		const wallMs = elapsedMs(started);
		let totalBytes = 0n;
		for(let index = 0; index < parallelOperations; index++)
		{
			const files = groups[index];
			totalBytes += await verifyOutput(
				path.join(temporaryRoot, `operation-${index + 1}`),
				files,
			);
		}
		return {wallMs, operationTimes, totalBytes};
	}
	finally
	{
		await rm(temporaryRoot, {recursive: true, force: true});
	}
}

function summarize(values)
{
	const sorted = [...values].sort((left, right) => left - right);
	const median = sorted.length % 2 === 0
		? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
		: sorted[Math.floor(sorted.length / 2)];
	const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
	return {median_ms: median, p95_ms: p95, samples_ms: values};
}

function partitionFiles(files, partitionCount)
{
	const groups = [];
	const baseSize = Math.floor(files.length / partitionCount);
	const remainder = files.length % partitionCount;
	let offset = 0;
	for(let index = 0; index < partitionCount; index++)
	{
		const groupSize = baseSize + (index < remainder ? 1 : 0);
		groups.push(files.slice(offset, offset + groupSize));
		offset += groupSize;
	}
	return groups;
}

function parseArguments(args)
{
	const values = new Map();
	for(let index = 0; index < args.length; index++)
	{
		const argument = args[index];
		if(!argument.startsWith('--'))
		{
			throw new TypeError(`Unexpected argument ${argument}`);
		}
		const equals = argument.indexOf('=');
		const key = argument.slice(2, equals === -1 ? undefined : equals);
		const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
		if(!value || value.startsWith('--') || values.has(key))
		{
			throw new TypeError(`Invalid or repeated option --${key}`);
		}
		if(!['archive', 'parallel-counts', 'iterations', 'deflate-buffer-size'].includes(key))
		{
			throw new TypeError(`Unknown option --${key}`);
		}
		values.set(key, value);
	}
	const archivePath = values.get('archive');
	if(!archivePath)
	{
		throw new TypeError(
			'Usage: node bench/multiprocess-extract.cjs --archive <zip> [--parallel-counts 1,2,4] [--iterations 3] [--deflate-buffer-size 262144]',
		);
	}
	const parallelCounts = [...new Set((values.get('parallel-counts') ?? '1,2,4')
		.split(',')
		.map(value => Number(value)))];
	if(parallelCounts.length === 0
		|| parallelCounts.some(value => !Number.isSafeInteger(value) || value < 1 || value > 4))
	{
		throw new RangeError('--parallel-counts must contain integers between 1 and 4');
	}
	const iterations = Number(values.get('iterations') ?? 3);
	if(!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20)
	{
		throw new RangeError('--iterations must be an integer between 1 and 20');
	}
	const deflateBufferSize = Number(values.get('deflate-buffer-size') ?? 256 * 1024);
	if(!Number.isSafeInteger(deflateBufferSize)
		|| deflateBufferSize < 4 * 1024
		|| deflateBufferSize > 2 * 1024 * 1024)
	{
		throw new RangeError('--deflate-buffer-size must be between 4096 and 2097152 bytes');
	}
	return {archivePath: path.resolve(archivePath), parallelCounts, iterations, deflateBufferSize};
}

async function main()
{
	const {Archive} = require('7zip-native');
	const {path7zc} = require('7zip-bin-full');
	const options = parseArguments(process.argv.slice(2));
	Archive.concurrency(Math.max(...options.parallelCounts));
	const listingArchive = await Archive.open(options.archivePath);
	let files;
	try
	{
		files = (await listingArchive.entries())
			.filter(entry => !entry.isDirectory)
			.map(entry => ({path: entry.path, size: entry.size}));
	}
	finally
	{
		await listingArchive.close();
	}
	if(files.length === 0)
	{
		throw new RangeError('The archive contains no files to extract');
	}
	if(options.parallelCounts.some(count => count > files.length))
	{
		throw new RangeError('The parallel count cannot exceed the number of files in the archive');
	}
	const runtime = process.versions.electron ? 'electron-as-node' : 'node';
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0n);
	const results = [];
	for(const parallelOperations of options.parallelCounts)
	{
		const groups = partitionFiles(files, parallelOperations);
		const samples = {native: [], cli: []};
		await runWave(
			'native', Archive, path7zc, options.archivePath, groups, files.length,
			parallelOperations, options.deflateBufferSize,
		);
		await runWave(
			'cli', Archive, path7zc, options.archivePath, groups, files.length,
			parallelOperations, options.deflateBufferSize,
		);
		for(let iteration = 0; iteration < options.iterations; iteration++)
		{
			const backends = iteration % 2 === 0 ? ['native', 'cli'] : ['cli', 'native'];
			for(const backend of backends)
			{
				samples[backend].push(await runWave(
					backend, Archive, path7zc, options.archivePath, groups, files.length,
					parallelOperations, options.deflateBufferSize,
				));
			}
		}
		for(const backend of ['native', 'cli'])
		{
			const waves = samples[backend];
			const wall = summarize(waves.map(wave => wave.wallMs));
			const operationTimes = summarize(waves.flatMap(wave => wave.operationTimes));
			const medianWall = wall.median_ms;
			results.push({
				backend: backend === 'native' ? '7zip-native' : '7zip-bin-full (7zzc)',
				parallel_promises: parallelOperations,
				files_per_promise: groups.map(group => group.length),
				total_file_extractions: files.length,
				unique_files: files.length,
				total_output_bytes: totalBytes.toString(),
				median_wall_ms: medianWall,
				p95_wall_ms: wall.p95_ms,
				median_operation_ms: operationTimes.median_ms,
				throughput_mib_per_second: Number(totalBytes) / (medianWall / 1000) / 1024 / 1024,
				samples_ms: wall.samples_ms,
			});
		}
	}
	console.log(JSON.stringify({
		runtime,
		archive: options.archivePath,
		archive_file_count: files.length,
		iterations: options.iterations,
		deflate_buffer_size: options.deflateBufferSize,
		total_files_per_run: files.length,
		files_partitioned_across_promises: true,
		includes_archive_open: true,
		includes_cli_process_startup: true,
		native_extraction_runs_in_benchmark_process: true,
		cli_binary: path7zc,
		results,
	}, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
