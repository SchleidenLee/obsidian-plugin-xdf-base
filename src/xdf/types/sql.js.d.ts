/**
 * Minimal type declarations for sql.js (WASM).
 *
 * sql.js does not ship official TypeScript types; the runtime API is a single
 * `Database` class plus a `locateFile` callback. The full surface we touch is:
 *   - initSqlJs({ locateFile })
 *   - new SQL.Database(buffer?)
 *   - db.exec(sql)
 *   - db.prepare(sql).run(params) / .bind(params) / .step() / .getAsObject() / .free()
 *   - db.export() -> Uint8Array
 *   - db.close()
 *
 * If/when `@types/sql.js` becomes available, delete this file and rely on it.
 */
declare module "sql.js" {
	export interface SqlJsStatic {
		Database: new (data?: ArrayLike<number> | Buffer | Uint8Array) => Database;
	}

	export interface Statement {
		run(params?: any[]): void;
		bind(params?: any[]): boolean;
		step(): boolean;
		getAsObject(): Record<string, any>;
		free(): void;
		reset(): void;
	}

	export interface Database {
		exec(sql: string): void;
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
	}

	export interface InitSqlJsOptions {
		locateFile?: (file: string) => string;
		/** emscripten 支持：直接传入 wasm 二进制，免去运行时 locateFile */
		wasmBinary?: ArrayBuffer | Uint8Array;
	}

	// sql.js 是 emscripten MODULARIZE 产物：module.exports = initSqlJs（工厂函数本身），
	// 运行时必须用 default import，命名导入拿到的是 undefined。
	export default function initSqlJs(
		options?: InitSqlJsOptions
	): Promise<SqlJsStatic>;
}

// esbuild binary loader：import wasm from "sql.js/dist/sql-wasm.wasm"
declare module "sql.js/dist/sql-wasm.wasm" {
	const data: Uint8Array;
	export default data;
}
