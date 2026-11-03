import {Archive} from '../dist/index.mjs';

const archivePath = process.argv[2];
if(!archivePath)
{
	throw new TypeError('Usage: npm run benchmark -- <archive-path>');
}

const iterations = Number(process.env.BENCH_ITERATIONS ?? 15);
if(!Number.isSafeInteger(iterations) || iterations < 3)
{
	throw new RangeError('BENCH_ITERATIONS must be an integer of at least 3');
}

function summarize(label: string, values: readonly number[])
{
	const sorted = [...values].sort((a, b) => a - b);
	const percentile = (fraction: number) => sorted[Math.min(
		sorted.length - 1,
		Math.ceil(sorted.length * fraction) - 1,
	)]!;
	return {
		label,
		iterations: sorted.length,
		median_ms: percentile(0.5),
		p95_ms: percentile(0.95),
	};
}

async function sample(label: string, run: () => Promise<unknown>)
{
	const durations: number[] = [];
	for(let i = 0; i < iterations; i++)
	{
		const start = process.hrtime.bigint();
		await run();
		durations.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	return summarize(label, durations);
}

const archive = await Archive.open(archivePath);
const entries = await archive.entries();
const file = entries.find(entry => !entry.isDirectory);
if(!file)
{
	await archive.close();
	throw new Error('The benchmark archive contains no files');
}

const before = process.memoryUsage().rss;
const results = [];
try
{
	results.push(await sample('open_and_list', async () => {
		const opened = await Archive.open(archivePath);
		await opened.entries();
		await opened.close();
	}));
	results.push(await sample('first_64KiB', async () => {
		await archive.read(file.id, {offset: 0, length: 64 * 1024});
	}));
	results.push(await sample('full_extract', async () => {
		await archive.extract(file.id);
	}));

	for(const workers of [1, 2, 4, 8])
	{
		const handles = await Promise.all(
			Array.from({length: workers}, () => Archive.open(archivePath)),
		);
		try
		{
			results.push(await sample(`parallel_reads_${workers}`, async () => {
				await Promise.all(handles.map(async handle => {
					const [entry] = await handle.entries();
					if(entry)
					{
						await handle.read(entry.id, {offset: 0, length: 64 * 1024});
					}
				}));
			}));
		}
		finally
		{
			await Promise.all(handles.map(handle => handle.close()));
		}
	}
}
finally
{
	await archive.close();
}

console.log(JSON.stringify({
	archive: archivePath,
	entry: file.path,
	entry_size_bytes: file.size.toString(),
	rss_before_bytes: before,
	rss_after_bytes: process.memoryUsage().rss,
	results,
}, null, 2));
