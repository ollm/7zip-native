export type EntryId = number;
export type EntrySelector = EntryId | string;

export interface ArchiveEntry {
	readonly id: EntryId;
	readonly path: string;
	readonly extractedPath: string;
	readonly size: bigint;
	readonly compressedSize: bigint;
	readonly isDirectory: boolean;
	readonly encrypted: boolean;
	readonly attributes: number;
	readonly crc?: number;
}

export interface ReadOptions {
	readonly offset?: number | bigint;
	readonly length: number | bigint;
}

export interface ReadRequest extends ReadOptions {
	readonly entry: EntrySelector;
}

export interface OpenOptions {
	readonly password?: string;
	readonly deflateBufferSize?: number;
}

export type ArchiveFormat = '7z' | 'zip' | 'tar' | 'wim';

export interface ArchiveCreateEntry {
	readonly sourcePath: string;
	readonly path: string;
}

export interface CreateArchiveOptions {
	readonly format?: ArchiveFormat;
	readonly compressionLevel?: number;
	readonly overwrite?: boolean;
}

export interface ExtractedArchiveFile {
	readonly entry: ArchiveEntry;
	readonly outputPath: string;
	readonly percent: number;
}

export interface ReadStreamOptions {
	readonly highWaterMark?: number;
	readonly maxBytes?: number | bigint | null;
	readonly signal?: AbortSignal;
}

export interface ExtractToFolderOptions {
	readonly ids?: readonly EntryId[];
	readonly paths?: readonly string[];
	readonly concurrency?: number;
	readonly overwrite?: boolean;
	readonly onExtract?: (result: ExtractedArchiveFile) => void;
	readonly maxBytes?: number | bigint | null;
	readonly signal?: AbortSignal;
}

export type ArchiveErrorCode
	= | 'ERR_ARCHIVE_CLOSED'
		| 'ERR_INVALID_ENTRY'
		| 'ERR_INVALID_RANGE'
		| 'ERR_RESOURCE_LIMIT'
		| 'ERR_ARCHIVE_OPEN'
		| 'ERR_ARCHIVE_PASSWORD'
		| 'ERR_ARCHIVE_PATH'
		| 'ERR_ARCHIVE_EXTRACT'
		| 'ERR_ARCHIVE_CREATE';

export class ArchiveError extends Error {
	constructor(readonly code: ArchiveErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ArchiveError';
	}
}
