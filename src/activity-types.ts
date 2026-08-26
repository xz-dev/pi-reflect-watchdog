export interface ActivityStatus {
	readonly active: boolean;
	readonly elapsedMs: number;
	readonly loops: number;
}

export interface ActivitySnapshot {
	readonly elapsedMs: number;
	readonly loops: number;
}
