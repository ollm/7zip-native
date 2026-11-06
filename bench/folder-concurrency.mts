import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Archive} from '../dist/index.mjs';

const usage = 'npm run benchmark:folder-concurrency -- --archive <path> [--archive <path> ...] [--iterations <count>] [--concurrency <workers> | --concurrencies <workers,...>]';
const archivePaths: string[] = [];
let iterations = 1;
let concurrencyOption: string | undefined;
let concurrenciesOption: string | undefined;
const args = process.argv.slice(2);
for(let index = 0; index < args.length; index++)
{
	const argument = args[index]!;
	if(argument === '--archive' || argument.startsWith('--archive='))
	{
		const equalsIndex = argument.indexOf('=');
		const path = equalsIndex === -1 ? args[++index] : argument.slice(equalsIndex + 1);
		if(!path || path.startsWith('--'))
		{
			throw new TypeError(`Missing value for --archive\nUsage: ${usage}`);
		}
		archivePaths.push(resolve(path));
		continue;
	}
	if(argument === '--iterations' || argument.startsWith('--iterations='))
	{
		const equalsIndex = argument.indexOf('=');
		const value = equalsIndex === -1 ? args[++index] : argument.slice(equalsIndex + 1);
		if(!value || value.startsWith('--'))
		{
			throw new TypeError(`Missing value for --iterations\nUsage: ${usage}`);
		}
		iterations = Number(value);
		continue;
	}
	if(argument === '--concurrency' || argument.startsWith('--concurrency='))
	{
		if(concurrencyOption !== undefined)
		{
			throw new TypeError('Option --concurrency may only be specified once');
		}
		const equalsIndex = argument.indexOf('=');
		concurrencyOption = equalsIndex === -1 ? args[++index] : argument.slice(equalsIndex + 1);
		if(!concurrencyOption || concurrencyOption.startsWith('--'))
		{
			throw new TypeError(`Missing value for --concurrency\nUsage: ${usage}`);
		}
		continue;
	}
	if(argument === '--concurrencies' || argument.startsWith('--concurrencies='))
	{
		if(concurrenciesOption !== undefined)
		{
			throw new TypeError('Option --concurrencies may only be specified once');
		}
		const equalsIndex = argument.indexOf('=');
		concurrenciesOption = equalsIndex === -1 ? args[++index] : argument.slice(equalsIndex + 1);
		if(!concurrenciesOption || concurrenciesOption.startsWith('--'))
		{
			throw new TypeError(`Missing value for --concurrencies\nUsage: ${usage}`);
		}
		continue;
	}
	throw new TypeError(`Unknown argument ${argument}\nUsage: ${usage}`);
}

if(archivePaths.length === 0)
{
	throw new TypeError(`Specify at least one --archive\nUsage: ${usage}`);
}
if(!Number.isSafeInteger(iterations) || iterations < 1)
{
	throw new RangeError('--iterations must be a positive integer');
}
if(concurrencyOption !== undefined && concurrenciesOption !== undefined)
{
	throw new TypeError('Use either --concurrency or --concurrencies, not both');
}

function parseConcurrency(value: string): number
{
	const concurrency = Number(value);
	if(!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16)
	{
		throw new RangeError('Concurrency values must be integers between 1 and 16');
	}
	return concurrency;
}

const selectedConcurrencies = concurrencyOption === undefined
	? concurrenciesOption === undefined
		? Array.from({length: 16}, (_, index) => index + 1)
		: concurrenciesOption.split(',').map(value => parseConcurrency(value.trim()))
	: [parseConcurrency(concurrencyOption)];
const concurrencies = [...new Set([1, ...selectedConcurrencies])];
const originalConcurrency = Archive.concurrency();
const archiveResults = [];
try
{
	Archive.concurrency(16);
	for(const archivePath of archivePaths)
	{
		const archive = await Archive.open(archivePath);
		try
		{
			const archiveSize = (await stat(archivePath)).size;
			const files = (await archive.entries()).filter(entry => !entry.isDirectory);
			if(files.length === 0)
			{
				throw new Error(`Archive contains no regular files: ${archivePath}`);
			}
			const expectedBytes = files.reduce((total, file) => total + file.size, 0n);
			const measurements = [];
			let serialMedian = 0;
			for(const concurrency of concurrencies)
			{
				const durations: number[] = [];
				for(let iteration = 0; iteration < iterations; iteration++)
				{
					const temporaryDirectory = await mkdtemp(join(tmpdir(), '7zip-native-folder-bench-'));
					let finalPercent = 0;
					let completedFiles = 0;
					try
					{
						const start = process.hrtime.bigint();
						await archive.extractToFolder(join(temporaryDirectory, 'output'), {
							concurrency,
							onExtract: ({percent}) => {
								completedFiles++;
								finalPercent = percent;
							},
						});
						durations.push(Number(process.hrtime.bigint() - start) / 1e6);
						if(completedFiles !== files.length || finalPercent !== 100)
						{
							throw new Error(`Extraction verification failed for ${archivePath} at concurrency ${concurrency}`);
						}
					}
					finally
					{
						await rm(temporaryDirectory, {recursive: true, force: true});
					}
				}
				const sorted = [...durations].sort((a, b) => a - b);
				const median = sorted[Math.floor(sorted.length / 2)]!;
				const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
				if(concurrency === 1)
				{
					serialMedian = median;
				}
				measurements.push({
					concurrency,
					iterations,
					median_ms: median,
					p95_ms: p95,
					throughput_mib_per_second: Number(expectedBytes) / (median / 1000) / 1024 / 1024,
					speedup_vs_1: serialMedian / median,
					runs_ms: durations,
				});
			}
			archiveResults.push({
				archive: archivePath,
				archive_bytes: archiveSize,
				files: files.length,
				uncompressed_bytes: expectedBytes.toString(),
				measurements,
			});
		}
		finally
		{
			await archive.close();
		}
	}
	console.log(JSON.stringify({
		global_pool_concurrency: 16,
		concurrencies,
		iterations,
		archives: archiveResults,
	}, null, 2));
}
finally
{
	Archive.concurrency(originalConcurrency);
}
