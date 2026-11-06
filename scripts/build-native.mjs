import {spawn} from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import {createRequire} from 'node:module';
import {availableParallelism} from 'node:os';
import { join, resolve } from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const upstreamDirectory = join(root, 'vendor', '7zip');
const bundleDirectory = join(root, 'vendor', '7zip', 'CPP', '7zip', 'Bundles', 'Format7zF');
const releaseDirectory = join(root, 'build', 'Release');
const targetArch = process.env.BUILD_ARCH || process.arch;
const target = `${process.platform}-${targetArch}`;
const engineName = process.platform === 'win32'
	? '7z.dll'
	: process.platform === 'darwin' ? 'lib7z.dylib' : '7z.so';
const require = createRequire(import.meta.url);
const patchPath = join(root, 'patches', 'deflate-input-buffer-size.patch');
const deflateSourcePath = join(upstreamDirectory, 'CPP', '7zip', 'Compress', 'DeflateDecoder.cpp');
const archiveExportsPath = join(upstreamDirectory, 'CPP', '7zip', 'Archive', 'Archive2.def');

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

const deflateSource = await readFile(deflateSourcePath, 'utf8');
const archiveExports = await readFile(archiveExportsPath, 'utf8');
if(deflateSource.includes('SetDeflateInputBufferSize'))
{
	if(!archiveExports.includes('SetDeflateInputBufferSize'))
	{
		throw new Error('The Deflate buffer patch is only partially applied; restore vendor/7zip and rebuild');
	}
}
else
{
	await run('git', ['-C', upstreamDirectory, 'apply', '--check', patchPath], root);
	await run('git', ['-C', upstreamDirectory, 'apply', patchPath], root);
}

if(process.platform === 'win32')
{
	const upstreamArch = targetArch === 'ia32' ? 'x86' : targetArch;
	await run('nmake', ['/f', 'makefile', `PLATFORM=${upstreamArch}`], bundleDirectory);
}
else
{
	const args = [
		'-C',
		bundleDirectory,
		'-f',
		'makefile.gcc',
		`-j${process.env.BUILD_JOBS ?? Math.min(availableParallelism(), 2)}`,
		// Avoid 2 MiB aligned allocations that Electron's allocator traps on.
		'CFLAGS_BASE2=-DZ7_NO_MADVISE',
	];
	const buildEnv = {...process.env};
	if(targetArch === 'ia32')
	{
		args.push('MY_ARCH=-m32', 'CC=gcc', 'CXX=g++');
		buildEnv.CXXFLAGS = `${buildEnv.CXXFLAGS ?? ''} -m32`.trim();
		buildEnv.LDFLAGS = `${buildEnv.LDFLAGS ?? ''} -m32`.trim();
	}
	else if(targetArch === 'arm')
	{
		const compilerPrefix = 'arm-linux-gnueabihf-';
		args.push(
			`CC=${compilerPrefix}gcc`,
			`CXX=${compilerPrefix}g++`,
			'MY_ARCH=-march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard',
		);
		buildEnv.CC = `${compilerPrefix}gcc`;
		buildEnv.CXX = `${compilerPrefix}g++`;
		buildEnv.CXXFLAGS = `${buildEnv.CXXFLAGS ?? ''} -march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard`.trim();
		buildEnv.LDFLAGS = `${buildEnv.LDFLAGS ?? ''} -march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard`.trim();
	}
	if(process.platform === 'darwin')
	{
		args.push(
			'LIB2=-lpthread',
			'PROG=lib7z',
			'SHARED_EXT=.dylib',
			'LDFLAGS=-shared -fPIC -Wl,-install_name,@rpath/lib7z.dylib',
		);
	}
	await run('make', args, root, buildEnv);
}

const upstreamEnginePath = process.platform === 'win32'
	? join(bundleDirectory, targetArch === 'ia32' ? 'x86' : targetArch, engineName)
	: join(bundleDirectory, '_o', engineName);
const nodeGypArgs = [
	require.resolve('node-gyp/bin/node-gyp.js'),
	'rebuild',
];
const nodeGypEnv = {...process.env};
if(targetArch !== process.arch)
{
	nodeGypArgs.push(`--arch=${targetArch}`);
	if(targetArch === 'ia32')
	{
		nodeGypEnv.CC = 'gcc';
		nodeGypEnv.CXX = 'g++';
		nodeGypEnv.CXXFLAGS = `${nodeGypEnv.CXXFLAGS ?? ''} -m32`.trim();
		nodeGypEnv.LDFLAGS = `${nodeGypEnv.LDFLAGS ?? ''} -m32`.trim();
	}
	else if(targetArch === 'arm')
	{
		nodeGypEnv.CC = 'arm-linux-gnueabihf-gcc';
		nodeGypEnv.CXX = 'arm-linux-gnueabihf-g++';
		nodeGypEnv.CXXFLAGS = `${nodeGypEnv.CXXFLAGS ?? ''} -march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard`.trim();
		nodeGypEnv.LDFLAGS = `${nodeGypEnv.LDFLAGS ?? ''} -march=armv7-a -mfpu=vfpv3-d16 -mfloat-abi=hard`.trim();
	}
}
await run(process.execPath, nodeGypArgs, root, nodeGypEnv);

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
