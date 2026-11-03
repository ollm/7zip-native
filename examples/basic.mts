import {Archive} from '../dist/index.mjs';

const archive = await Archive.open(process.argv[2] ?? './file.zip');
try
{
	const entries = await archive.entries();
	const firstImage = entries.find(entry => !entry.isDirectory);
	if(!firstImage)
	{
		throw new Error('The archive contains no files');
	}

	const header = await archive.read(firstImage.id, {offset: 0, length: 64 * 1024});
	console.log(`${firstImage.path}: ${header.byteLength} prefix bytes from ${firstImage.size} bytes`);
}
finally
{
	await archive.close();
}
