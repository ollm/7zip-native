import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const target = `${process.platform}-${process.arch}`;
const engineName = process.platform === 'win32'
	? '7z.dll'
	: process.platform === 'darwin' ? 'lib7z.dylib' : '7z.so';
const runtimeDirectories = [
	join(packageDirectory, `../prebuilds/${target}`),
	join(packageDirectory, '../build/Release'),
];

if(runtimeDirectories.some(directory =>
	existsSync(join(directory, '7zip_native.node')) && existsSync(join(directory, engineName))))
{
	process.exit(0);
}

if(existsSync(join(packageDirectory, '../.git')))
{
	process.exit(0);
}

throw new Error(
	`No prebuilt 7zip-native binaries are available for ${target}. `
	+ 'Check the supported platforms in the package README.',
);
