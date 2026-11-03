export type EntryId = number;

export interface ArchiveEntry {
	readonly id: EntryId;
	readonly path: string;
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

export interface OpenOptions {
	readonly password?: string;
}

export interface ReadStreamOptions {
	readonly highWaterMark?: number;
	readonly maxBytes?: number | bigint | null;
	readonly signal?: AbortSignal;
}

export interface ExtractToFolderOptions {
	readonly ids?: readonly EntryId[];
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
		| 'ERR_ARCHIVE_EXTRACT';

export class ArchiveError extends Error {
	constructor(readonly code: ArchiveErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ArchiveError';
	}
}
