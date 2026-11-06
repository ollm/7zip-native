import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {stat as statFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import { Archive, type ArchiveEntry } from '../dist/index.mjs';
import {parseBenchmarkArguments} from './args.mts';

const args = parseBenchmarkArguments(
	process.argv.slice(2),
	['entry', 'iterations', 'read-bytes', 'concurrency'],
	'npm run benchmark:compare -- --archive <archive-path> [--entry <entry-path>] [--iterations <count>] [--read-bytes <bytes>] [--concurrency <workers>]',
);

const archivePath = resolve(args.archivePath);
const requestedEntryPath = args.options.get('entry');
const iterations = Number(args.options.get('iterations') ?? 15);
const readBytes = Number(args.options.get('read-bytes') ?? 64 * 1024);
const maxNativeReadBytes = 64 * 1024 * 1024;
const maxCapturedBytes = 256 * 1024 * 1024;
const originalConcurrency = Archive.concurrency();
const parallelConcurrency = Number(args.options.get('concurrency') ?? originalConcurrency);

if(!Number.isSafeInteger(iterations) || iterations < 3)
{
	throw new RangeError('--iterations must be an integer of at least 3');
}
if(!Number.isSafeInteger(readBytes) || readBytes < 1 || readBytes > maxNativeReadBytes)
{
	throw new RangeError(`--read-bytes must be an integer between 1 and ${maxNativeReadBytes}`);
}
if(!Number.isSafeInteger(parallelConcurrency) || parallelConcurrency < 1 || parallelConcurrency > 128)
{
	throw new RangeError('--concurrency must be an integer between 1 and 128');
}

const require = createRequire(import.meta.url);
const binaryPackage = require('7zip-bin-full') as {path7zc?: unknown};
if(typeof binaryPackage.path7zc !== 'string')
{
	throw new TypeError('7zip-bin-full does not provide a path7zc binary for this platform');
}
const binaryPath = binaryPackage.path7zc;

function runCli(args: readonly string[], outputLimit = maxCapturedBytes): Promise<Buffer>
{
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(binaryPath, [...args], {stdio: ['ignore', 'pipe', 'pipe']});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutLength = 0;
		let stderrLength = 0;
		let outputExceeded = false;

		child.stdout.on('data', (chunk: Buffer) => {
			stdoutLength += chunk.length;
			if(stdoutLength > outputLimit)
			{
				outputExceeded = true;
				child.kill();
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if(stderrLength < 64 * 1024)
			{
				const remaining = 64 * 1024 - stderrLength;
				const kept = chunk.subarray(0, remaining);
				stderr.push(kept);
				stderrLength += kept.length;
			}
		});
		child.once('error', rejectPromise);
		child.once('close', (code, signal) => {
			if(outputExceeded)
			{
				rejectPromise(new RangeError(`7zip-bin-full output exceeded ${outputLimit} bytes`));
			}
			else if(code !== 0)
			{
				const detail = Buffer.concat(stderr).toString('utf8').trim();
				rejectPromise(new Error(
					`7zip-bin-full exited with ${signal ?? code}${detail ? `: ${detail}` : ''}`,
				));
			}
			else
			{
				resolvePromise(Buffer.concat(stdout));
			}
		});
	});
}

interface CliEntry {
	readonly path: string;
	readonly directory: boolean;
}

interface ExtractionGroup {
	readonly entries: readonly ArchiveEntry[];
	readonly bytes: number;
}

interface GroupedExtractionResult {
	readonly groupDigests: readonly string[];
	readonly bytes: number;
}

type BenchmarkResult = Buffer | readonly Buffer[] | number | GroupedExtractionResult;

function parseCliEntries(output: Buffer): CliEntry[]
{
	const sections = output.toString('utf8').split(/\r?\n\r?\n/);
	const entries: CliEntry[] = [];
	for(const section of sections.slice(1))
	{
		const fields = new Map<string, string>();
		for(const line of section.split(/\r?\n/))
		{
			const delimiter = line.indexOf(' = ');
			if(delimiter !== -1)
			{
				fields.set(line.slice(0, delimiter), line.slice(delimiter + 3));
			}
		}
		const entryPath = fields.get('Path');
		if(entryPath !== undefined && (fields.has('Size') || fields.has('Folder')))
		{
			const attributes = fields.get('Attributes') ?? '';
			const directory = fields.get('Folder') === '+'
				|| attributes === 'D'
				|| attributes.startsWith('D ');
			entries.push({path: entryPath, directory});
		}
	}
	return entries;
}

function cliList(): Promise<CliEntry[]>
{
	return runCli(['l', '-slt', '-sccUTF-8', archivePath]).then(parseCliEntries);
}

function cliExtract(
	paths: readonly string[],
	outputLimit = maxCapturedBytes,
	byteLimit?: number,
): Promise<Buffer>
{
	const args = ['x'];
	if(byteLimit !== undefined)
	{
		args.push(`-slb${byteLimit}`);
	}
	args.push(
		archivePath,
		...paths,
		'-so',
		'-y',
		'-bd',
		'-bb0',
		'-spd',
		'-sccUTF-8',
	);
	return runCli(args, outputLimit);
}

function isGroupedExtractionResult(value: BenchmarkResult): value is GroupedExtractionResult
{
	return typeof value === 'object'
		&& value !== null
		&& !Buffer.isBuffer(value)
		&& 'groupDigests' in value;
}

function digest(value: BenchmarkResult): string
{
	if(typeof value === 'number')
	{
		return `count:${value}`;
	}
	if(isGroupedExtractionResult(value))
	{
		return `groups:${value.groupDigests.join(':')}`;
	}
	const hash = createHash('sha256');
	if(Buffer.isBuffer(value))
	{
		hash.update(value);
	}
	else
	{
		for(const buffer of value)
		{
			hash.update(buffer);
		}
	}
	return `sha256:${hash.digest('hex')}`;
}

function resultBytes(value: BenchmarkResult): number | undefined
{
	if(Buffer.isBuffer(value))
	{
		return value.length;
	}
	if(isGroupedExtractionResult(value))
	{
		return value.bytes;
	}
	if(typeof value !== 'number')
	{
		return value.reduce((sum, buffer) => sum + buffer.length, 0);
	}
}

function summarize(values: readonly number[])
{
	const sorted = [...values].sort((a, b) => a - b);
	const percentile = (fraction: number) => sorted[Math.min(
		sorted.length - 1,
		Math.ceil(sorted.length * fraction) - 1,
	)]!;
	return {
		iterations: sorted.length,
		median_ms: percentile(0.5),
		p95_ms: percentile(0.95),
	};
}

async function measurePair(
	name: string,
	nativeRun: () => Promise<BenchmarkResult>,
	cliRun: () => Promise<BenchmarkResult>,
): Promise<{
	name: string;
	result_sha256?: string;
	result_bytes?: number;
	native: ReturnType<typeof summarize>;
	cli: ReturnType<typeof summarize>;
	cli_over_native_median: number;
}>
{
	const nativeFirstResult = await nativeRun();
	const cliFirstResult = await cliRun();
	const nativeExpected = digest(nativeFirstResult);
	const cliExpected = digest(cliFirstResult);
	if(nativeExpected !== cliExpected)
	{
		throw new Error(`${name} produced different native and CLI results`);
	}

	const nativeDurations: number[] = [];
	const cliDurations: number[] = [];
	for(let index = 0; index < iterations; index++)
	{
		const first = index % 2 === 0 ? nativeRun : cliRun;
		const second = index % 2 === 0 ? cliRun : nativeRun;
		const firstStart = process.hrtime.bigint();
		const firstResult = await first();
		const firstDuration = Number(process.hrtime.bigint() - firstStart) / 1e6;
		if(digest(firstResult) !== nativeExpected)
		{
			throw new Error(`${name} result changed during measurement`);
		}

		const secondStart = process.hrtime.bigint();
		const secondResult = await second();
		const secondDuration = Number(process.hrtime.bigint() - secondStart) / 1e6;
		if(digest(secondResult) !== nativeExpected)
		{
			throw new Error(`${name} result changed during measurement`);
		}

		if(index % 2 === 0)
		{
			nativeDurations.push(firstDuration);
			cliDurations.push(secondDuration);
		}
		else
		{
			cliDurations.push(firstDuration);
			nativeDurations.push(secondDuration);
		}
	}

	const native = summarize(nativeDurations);
	const cli = summarize(cliDurations);
	return {
		name,
		...(nativeExpected.startsWith('sha256:') ? {result_sha256: nativeExpected.slice(7)} : {}),
		...(resultBytes(nativeFirstResult) === undefined
			? {}
			: {result_bytes: resultBytes(nativeFirstResult)}),
		native,
		cli,
		cli_over_native_median: cli.median_ms / native.median_ms,
	};
}

function selectEntry(entries: readonly ArchiveEntry[]): ArchiveEntry
{
	const entry = requestedEntryPath === undefined
		? entries.find(candidate => !candidate.isDirectory)
		: entries.find(candidate => candidate.path === requestedEntryPath);
	if(!entry || entry.isDirectory)
	{
		throw new Error(requestedEntryPath
			? `No file entry named ${requestedEntryPath}`
			: 'The archive contains no files');
	}
	return entry;
}

function groupEntries(
	entries: readonly ArchiveEntry[],
	concurrency: number,
): ExtractionGroup[]
{
	const totalBytes = entries.reduce((total, entry) => total + entry.size, 0n);
	const targetBytes = (totalBytes + BigInt(concurrency) - 1n) / BigInt(concurrency);
	const groups: ExtractionGroup[] = [];
	let current: ArchiveEntry[] = [];
	let currentBytes = 0n;
	for(const entry of entries)
	{
		if(entry.size > BigInt(maxCapturedBytes))
		{
			throw new RangeError(`Entry ${entry.id} exceeds the 256 MiB extraction limit`);
		}
		const reachedTarget = groups.length < concurrency - 1 && currentBytes >= targetBytes;
		if(current.length > 0
			&& (currentBytes + entry.size > BigInt(maxCapturedBytes) || reachedTarget))
		{
			groups.push({entries: current, bytes: Number(currentBytes)});
			current = [];
			currentBytes = 0n;
		}
		current.push(entry);
		currentBytes += entry.size;
	}
	if(current.length > 0)
	{
		groups.push({entries: current, bytes: Number(currentBytes)});
	}
	return groups;
}

function getExtractionWaves(
	groups: readonly ExtractionGroup[],
	concurrency: number,
): Array<Array<{index: number; group: ExtractionGroup}>>
{
	const waves: Array<Array<{index: number; group: ExtractionGroup}>> = [];
	let nextGroup = 0;
	while(nextGroup < groups.length)
	{
		const wave: Array<{index: number; group: ExtractionGroup}> = [];
		let waveBytes = 0;
		while(nextGroup < groups.length && wave.length < concurrency)
		{
			const group = groups[nextGroup]!;
			if(wave.length > 0 && waveBytes + group.bytes > maxCapturedBytes)
			{
				break;
			}
			wave.push({index: nextGroup, group});
			waveBytes += group.bytes;
			nextGroup++;
		}
		waves.push(wave);
	}
	return waves;
}

async function extractAll(
	groups: readonly ExtractionGroup[],
	concurrency: number,
	extractGroup: (group: ExtractionGroup) => Promise<Buffer | readonly Buffer[]>,
): Promise<GroupedExtractionResult>
{
	const groupDigests = new Array<string>(groups.length);
	let bytes = 0;
	for(const wave of getExtractionWaves(groups, concurrency))
	{
		const outputs = await Promise.all(wave.map(({group}) => extractGroup(group)));
		for(let index = 0; index < outputs.length; index++)
		{
			const output = outputs[index]!;
			const outputBytes = resultBytes(output) ?? 0;
			const group = wave[index]!.group;
			if(outputBytes !== group.bytes)
			{
				throw new Error(
					`Extraction returned ${outputBytes} bytes for a ${group.bytes}-byte batch`,
				);
			}
			groupDigests[wave[index]!.index] = digest(output);
			bytes += outputBytes;
		}
	}
	return {groupDigests, bytes};
}

const archive = await Archive.open(archivePath);
try
{
	Archive.concurrency(parallelConcurrency);
	const entries = await archive.entries();
	const cliEntries = await cliList();
	const file = selectEntry(entries);
	const nativeListing = entries
		.map(entry => `${entry.isDirectory ? 'D' : 'F'}\0${entry.path}`)
		.sort();
	const cliListing = cliEntries
		.map(entry => `${entry.directory ? 'D' : 'F'}\0${entry.path}`)
		.sort();
	if(nativeListing.length !== cliListing.length
		|| nativeListing.some((entry, index) => entry !== cliListing[index]))
	{
		throw new Error(
			`Archive listings differ: native=${entries.length} entries, 7zip-bin-full=${cliEntries.length} entries`,
		);
	}
	const cliPaths = new Set(cliEntries.filter(entry => !entry.directory).map(entry => entry.path));
	if(!cliPaths.has(file.path))
	{
		throw new Error(`7zip-bin-full did not list the selected entry: ${file.path}`);
	}

	const readLength = BigInt(readBytes);
	const prefixLength = file.size < readLength ? file.size : readLength;
	const rangeOffset = file.size > 0n ? file.size / 3n : 0n;
	const rangeLength = file.size - rangeOffset < readLength
		? file.size - rangeOffset
		: readLength;
	const selectedFiles = entries.filter(entry => !entry.isDirectory).slice(0, 3);
	const batchSize = selectedFiles.reduce((sum, entry) => sum + entry.size, 0n);
	const results: Array<Awaited<ReturnType<typeof measurePair>>> = [];

	results.push(await measurePair(
		'open_and_list',
		async () => {
			const opened = await Archive.open(archivePath);
			try
			{
				return (await opened.entries()).length;
			}
			finally
			{
				await opened.close();
			}
		},
		async () => (await cliList()).length,
	));

	if(file.size > BigInt(maxCapturedBytes))
	{
		console.warn(`Skipping full extraction: selected entry exceeds ${maxCapturedBytes} bytes`);
	}
	else
	{
		results.push(await measurePair(
			'full_extract',
			() => archive.extract(file.id),
			() => cliExtract([file.path], Number(file.size)),
		));
	}

	if(selectedFiles.length > 1 && batchSize <= BigInt(maxCapturedBytes))
	{
		results.push(await measurePair(
			'batch_extract_first_three_files',
			() => archive.extract(selectedFiles.map(entry => entry.id)),
			() => cliExtract(selectedFiles.map(entry => entry.path), Number(batchSize)),
		));
	}

	const allFiles = entries.filter(entry => !entry.isDirectory);
	let fullExtractionBatches = 0;
	let fullExtractionMaxParallelBatches = 0;
	if(allFiles.some(entry => entry.size > BigInt(maxCapturedBytes)))
	{
		console.warn('Skipping full-archive extraction comparison: an entry exceeds 256 MiB');
	}
	else
	{
		const groups = groupEntries(allFiles, parallelConcurrency);
		fullExtractionBatches = groups.length;
		fullExtractionMaxParallelBatches = Math.max(
			0,
			...getExtractionWaves(groups, parallelConcurrency).map(wave => wave.length),
		);
		const nativeGroup = (group: ExtractionGroup) => archive.extract(
			group.entries.map(entry => entry.id),
		);
		const cliGroup = (group: ExtractionGroup) => cliExtract(
			group.entries.map(entry => entry.path),
			group.bytes,
		);
		results.push(await measurePair(
			'extract_all_sequential',
			() => extractAll(groups, 1, nativeGroup),
			() => extractAll(groups, 1, cliGroup),
		));
		results.push(await measurePair(
			'extract_all_concurrent',
			() => extractAll(groups, parallelConcurrency, nativeGroup),
			() => extractAll(groups, parallelConcurrency, cliGroup),
		));
	}

	const rangeNote = '7zzc uses -slb; non-solid archives abort per item, while ranges emit through offset + length and slice stdout';
	for(const [name, offset, length] of [
		['read_prefix', 0n, prefixLength],
		['read_range_at_one_third', rangeOffset, rangeLength],
	] as const)
	{
		if(file.size > BigInt(maxCapturedBytes))
		{
			console.warn(`Skipping ${name}: CLI baseline would exceed ${maxCapturedBytes} bytes`);
			continue;
		}
		const nativeRead = () => archive.read(file.id, {offset, length});
		const cliRead = async () => {
			if(length === 0n)
			{
				return Buffer.alloc(0);
			}
			const limit = Number(offset + length);
			const output = await cliExtract([file.path], limit, limit);
			return output.subarray(Number(offset), limit);
		};
		results.push(await measurePair(name, nativeRead, cliRead));
	}

	console.log(JSON.stringify({
		archive: archivePath,
		archive_size_bytes: (await statFile(archivePath)).size,
		entry_count: entries.length,
		entry: file.path,
		entry_size_bytes: file.size.toString(),
		iterations,
		available_concurrency: originalConcurrency,
		parallel_concurrency: parallelConcurrency,
		full_extraction_batches: fullExtractionBatches,
		full_extraction_max_parallel_batches: fullExtractionMaxParallelBatches,
		read_bytes_requested: readBytes,
		cli_binary: binaryPath,
		cli_version: await runCli(['-h']).then(buffer => buffer.toString('utf8').trim().split(/\r?\n/, 1)[0]),
		cli_read_method: rangeNote,
		results,
	}, null, 2));
}
finally
{
	await archive.close();
	Archive.concurrency(originalConcurrency);
}
