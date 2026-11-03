import typescript from '@rollup/plugin-typescript';
import dts from 'rollup-plugin-dts';

export default [
	{
		input: 'src/index.mts',
		output: [
			{
				file: 'dist/index.cjs',
				format: 'cjs',
			},
			{
				file: 'dist/index.mjs',
				format: 'es',
			},
		],
		plugins: [
			typescript({
				tsconfig: './tsconfig.json',
				declaration: false,
			}),
		],
		external: ['node:module', 'node:path'],
	},
	{
		input: 'src/index.mts',
		output: [
			{file: 'dist/index.d.ts', format: 'es'},
			{file: 'dist/index.d.mts', format: 'es'},
			{file: 'dist/index.d.cts', format: 'es'},
		],
		plugins: [dts()],
	},
];