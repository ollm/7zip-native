import {spawn} from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import {createRequire} from 'node:module';
import {availableParallelism} from 'node:os';
import { join, resolve } from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const bundleDirectory = join(root, 'vendor', '7zip', 'CPP', '7zip', 'Bundles', 'Format7zF');
const releaseDirectory = join(root, 'build', 'Release');
const target = `${process.platform}-${process.arch}`;
const engineName = process.platform === 'win32'
	? '7z.dll'
	: process.platform === 'darwin' ? 'lib7z.dylib' : '7z.so';
const require = createRequire(import.meta.url);

function run(command, args, cwd, env = process.env)
{
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {cwd, env, stdio: 'inherit'});
		child.once('error', rejectPromise);
		child.once('close', (code, signal) => {
			if(code === 0)
			{
				resolvePromise();
			}
			else
			{
				rejectPromise(new Error(`${command} exited with ${signal ?? code}`));
			}
		});
	});
}

if(process.platform === 'win32')
{
	await run('nmake', ['/f', 'makefile', `PLATFORM=${process.arch}`], bundleDirectory);
}
else
{
	const args = [
		'-C',
		bundleDirectory,
		'-f',
		'makefile.gcc',
		`-j${process.env.BUILD_JOBS ?? Math.min(availableParallelism(), 2)}`,
	];
	if(process.platform === 'darwin')
	{
		args.push(
			'LIB2=-lpthread',
			'PROG=lib7z',
			'SHARED_EXT=.dylib',
			'LDFLAGS=-shared -fPIC -Wl,-install_name,@rpath/lib7z.dylib',
		);
	}
	await run('make', args, root);
}

const upstreamEnginePath = process.platform === 'win32'
	? join(bundleDirectory, process.arch, engineName)
	: join(bundleDirectory, '_o', engineName);
await run(process.execPath, [
	require.resolve('node-gyp/bin/node-gyp.js'),
	'rebuild',
], root);

await mkdir(releaseDirectory, {recursive: true});
const releaseEnginePath = join(releaseDirectory, engineName);
await copyFile(upstreamEnginePath, releaseEnginePath);
const prebuildDirectory = join(root, 'prebuilds', target);
await rm(prebuildDirectory, {recursive: true, force: true});
await mkdir(prebuildDirectory, {recursive: true});
await Promise.all([
	copyFile(join(releaseDirectory, '7zip_native.node'), join(prebuildDirectory, '7zip_native.node')),
	copyFile(releaseEnginePath, join(prebuildDirectory, engineName)),
]);
