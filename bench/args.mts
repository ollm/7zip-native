export interface BenchmarkArguments {
	readonly archivePath: string;
	readonly options: ReadonlyMap<string, string>;
}

export function parseBenchmarkArguments(
	args: readonly string[],
	availableOptions: readonly string[],
	usage: string,
): BenchmarkArguments
{
	const options = new Map<string, string>();
	const supportedOptions = new Set(availableOptions);
	let archivePath: string | undefined;

	for(let index = 0; index < args.length; index++)
	{
		const argument = args[index]!;
		if(argument === '--archive' || argument.startsWith('--archive='))
		{
			if(archivePath !== undefined)
			{
				throw new TypeError('The archive path may only be specified once');
			}
			const equalsIndex = argument.indexOf('=');
			const value = equalsIndex === -1 ? args[++index] : argument.slice(equalsIndex + 1);
			if(!value || value.startsWith('--'))
			{
				throw new TypeError('Missing value for --archive');
			}
			archivePath = value;
			continue;
		}

		if(argument.startsWith('--'))
		{
			const equalsIndex = argument.indexOf('=');
			const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
			if(!supportedOptions.has(name))
			{
				throw new TypeError(`Unknown option --${name}\nUsage: ${usage}`);
			}
			if(options.has(name))
			{
				throw new TypeError(`Option --${name} may only be specified once`);
			}
			const value = equalsIndex === -1 ? args[++index] : argument.slice(equalsIndex + 1);
			if(!value || value.startsWith('--'))
			{
				throw new TypeError(`Missing value for --${name}`);
			}
			options.set(name, value);
			continue;
		}

		if(archivePath !== undefined)
		{
			throw new TypeError(`Unexpected argument ${argument}\nUsage: ${usage}`);
		}
		archivePath = argument;
	}

	if(!archivePath)
	{
		throw new TypeError(`Usage: ${usage}`);
	}

	return {archivePath, options};
}
