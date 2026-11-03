import {rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const upstreamBuildDirectory = new URL(
	'../vendor/7zip/CPP/7zip/Bundles/Format7zF/_o/',
	import.meta.url,
);

await rm(fileURLToPath(upstreamBuildDirectory), {recursive: true, force: true});
