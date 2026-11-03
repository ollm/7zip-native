import {Archive} from '../dist/index.mjs';
import {parseBenchmarkArguments} from './args.mts';

const args = parseBenchmarkArguments(
	process.argv.slice(2),
	['iterations', 'concurrency', 'concurrencies', 'max-files'],
	'npm run benchmark:concurrency -- --archive <archive-path> [--iterations <count>] [--concurrency <workers> | --concurrencies <workers,...>] [--max-files <count>]',
);
const archivePath = args.archivePath;

const iterations = Number(args.options.get('iterations') ?? 5);
const maxFilesOption = args.options.get('max-files');
const maxFiles = maxFilesOption === undefined ? undefined : Number(maxFilesOption);
if(!Number.isSafeInteger(iterations) || iterations < 3)
{
	throw new RangeError('--iterations must be an integer of at least 3');
}
if(maxFiles !== undefined && (!Number.isSafeInteger(maxFiles) || maxFiles < 1))
{
	throw new RangeError('--max-files must be a positive integer');
}

const defaultConcurrency = Archive.concurrency();
const concurrencyOption = args.options.get('concurrency');
const concurrenciesOption = args.options.get('concurrencies');
if(concurrencyOption !== undefined && concurrenciesOption !== undefined)
{
	throw new TypeError('Use either --concurrency or --concurrencies, not both');
}

function parseConcurrency(value: string): number
{
	const concurrency = Number(value);
	if(!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128)
	{
		throw new RangeError('Concurrency values must be integers between 1 and 128');
	}
	return concurrency;
}

const parallelConcurrency = parseConcurrency(concurrencyOption ?? String(defaultConcurrency));
const selectedConcurrencies = concurrenciesOption === undefined
	? [1, parallelConcurrency]
	: concurrenciesOption.split(',').map(value => parseConcurrency(value.trim()));
const concurrencies = [...new Set([1, ...selectedConcurrencies])];

if(concurrenciesOption !== undefined && concurrenciesOption.trim() === '')
{
	throw new TypeError('--concurrencies must contain at least one worker count');
}

function summarize(label: string, values: readonly number[], bytes: bigint)
{
	const sorted = [...values].sort((a, b) => a - b);
	const percentile = (fraction: number) => sorted[Math.min(
		sorted.length - 1,
		Math.ceil(sorted.length * fraction) - 1,
	)]!;
	const median = percentile(0.5);
	return {
		label,
		iterations: sorted.length,
		total_bytes: bytes.toString(),
		median_ms: median,
		p95_ms: percentile(0.95),
		throughput_mib_per_second: median === 0 ? 0 : Number(bytes) / (median / 1000) / 1024 / 1024,
	};
}

function groupFiles(
	files: readonly {id: number; size: bigint}[],
): Array<Array<{id: number; size: bigint}>>
{
	const maxBatchBytes = 256n * 1024n * 1024n;
	const maxBatchFiles = 128;
	const groups: Array<Array<{id: number; size: bigint}>> = [];
	let current: Array<{id: number; size: bigint}> = [];
	let currentBytes = 0n;
	for(const file of files)
	{
		if(file.size > maxBatchBytes)
		{
			throw new RangeError(`Entry ${file.id} exceeds the 256 MiB extraction limit`);
		}
		if(current.length > 0
			&& (current.length >= maxBatchFiles || currentBytes + file.size > maxBatchBytes))
		{
			groups.push(current);
			current = [];
			currentBytes = 0n;
		}
		current.push(file);
		currentBytes += file.size;
	}
	if(current.length > 0)
	{
		groups.push(current);
	}
	return groups;
}

async function extractAll(
	archive: Archive,
	groups: readonly (readonly {id: number; size: bigint}[])[],
): Promise<bigint>
{
	let extractedBytes = 0n;
	for(const group of groups)
	{
		const outputs = await Promise.all(
			group.map(file => archive.extract(file.id)),
		);
		for(const buffer of outputs)
		{
			extractedBytes += BigInt(buffer.length);
		}
	}
	return extractedBytes;
}

const archive = await Archive.open(archivePath);
const originalConcurrency = Archive.concurrency();
const results = [];
try
{
	const entries = await archive.entries();
	const archiveFiles = entries
		.filter(entry => !entry.isDirectory)
		.map(entry => ({id: entry.id, size: entry.size}));
	if(archiveFiles.length === 0)
	{
		throw new Error('The benchmark archive contains no files');
	}
	if(maxFiles !== undefined && maxFiles > archiveFiles.length)
	{
		throw new RangeError(`--max-files cannot exceed the archive's ${archiveFiles.length} files`);
	}
	const files = maxFiles === undefined || maxFiles === archiveFiles.length
		? archiveFiles
		: Array.from({length: maxFiles}, (_, index) => {
			const selectedIndex = maxFiles === 1
				? Math.floor((archiveFiles.length - 1) / 2)
				: Math.round(index * (archiveFiles.length - 1) / (maxFiles - 1));
			return archiveFiles[selectedIndex]!;
		});
	const expectedBytes = files.reduce((total, file) => total + file.size, 0n);
	const groups = groupFiles(files);
	const resultsByConcurrency = new Map<number, ReturnType<typeof summarize>>();
	for(const concurrency of concurrencies)
	{
		Archive.concurrency(concurrency);
		const warmupBytes = await extractAll(archive, groups);
		if(warmupBytes !== expectedBytes)
		{
			throw new Error('Warm-up extraction returned an unexpected number of bytes');
		}
		const durations: number[] = [];
		for(let iteration = 0; iteration < iterations; iteration++)
		{
			const start = process.hrtime.bigint();
			const extractedBytes = await extractAll(archive, groups);
			durations.push(Number(process.hrtime.bigint() - start) / 1e6);
			if(extractedBytes !== expectedBytes)
			{
				throw new Error('Extraction returned an unexpected number of bytes');
			}
		}
		resultsByConcurrency.set(concurrency, summarize(
			`workers_${concurrency}`,
			durations,
			expectedBytes,
		));
	}
	const serialMedian = resultsByConcurrency.get(1)?.median_ms;
	const results = [...resultsByConcurrency.values()];
	console.log(JSON.stringify({
		archive: archivePath,
		archive_files: archiveFiles.length,
		files: files.length,
		batches: groups.length,
		max_parallel_entries: Math.min(Math.max(...groups.map(group => group.length)), Math.max(...concurrencies)),
		iterations,
		available_concurrency: defaultConcurrency,
		concurrencies,
		speedups: Object.fromEntries(results.map(result => [
				result.label,
				serialMedian && result.median_ms ? serialMedian / result.median_ms : null,
		])),
		results,
	}, null, 2));
}
finally
{
	await archive.close();
	Archive.concurrency(originalConcurrency);
}
