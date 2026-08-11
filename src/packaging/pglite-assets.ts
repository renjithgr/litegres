/**
 * PGlite WASM asset loading.
 *
 * PGlite normally locates `pglite.wasm`, `initdb.wasm` and `pglite.data`
 * relative to its own module URL and reads them from disk. That breaks in a
 * `bun build --compile` executable, where node_modules does not exist.
 *
 * Strategy: import the three artifacts with `{ type: "file" }`. When run from
 * source these resolve to real paths in node_modules; when compiled they are
 * embedded into the executable's $bunfs and resolved to virtual paths. Either
 * way `Bun.file(url)` returns the bytes, and we hand PGlite explicit
 * `pgliteWasmModule` / `initdbWasmModule` / `fsBundle` values so it never
 * reads from disk. This is the single code path for source and standalone.
 */
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import pgliteWasmUrl from "../../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" };
import initdbWasmUrl from "../../node_modules/@electric-sql/pglite/dist/initdb.wasm" with { type: "file" };
import pgliteDataUrl from "../../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" };

export interface PgliteAssetSet {
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  fsBundle: Blob;
}

let cached: PgliteAssetSet | undefined;

export async function loadPgliteAssets(): Promise<PgliteAssetSet> {
  if (cached) return cached;
  const [wasmBytes, initdbBytes, dataBytes] = await Promise.all([
    Bun.file(pgliteWasmUrl).arrayBuffer(),
    Bun.file(initdbWasmUrl).arrayBuffer(),
    Bun.file(pgliteDataUrl).arrayBuffer(),
  ]);
  cached = {
    pgliteWasmModule: new WebAssembly.Module(wasmBytes),
    initdbWasmModule: new WebAssembly.Module(initdbBytes),
    fsBundle: new Blob([dataBytes]),
  };
  return cached;
}

export interface CreatePgliteInput {
  dataDir?: string;
  loadDataDir?: Blob | File;
  initialMemoryBytes?: number;
}

/**
 * Create a PGlite instance with explicit embedded assets. Throws
 * PGLITE_STARTUP_FAILED on failure.
 */
export async function createPglite(input: CreatePgliteInput = {}): Promise<PGlite> {
  const assets = await loadPgliteAssets();
  const options: PGliteOptions = {
    pgliteWasmModule: assets.pgliteWasmModule,
    initdbWasmModule: assets.initdbWasmModule,
    fsBundle: assets.fsBundle,
  };
  if (input.dataDir) options.dataDir = input.dataDir;
  if (input.loadDataDir) options.loadDataDir = input.loadDataDir;
  if (input.initialMemoryBytes) {
    options.initialMemory = input.initialMemoryBytes;
  }
  return PGlite.create(options);
}

/** Dump a PGlite instance's PGDATA to a tarball snapshot (for templates). */
export async function snapshotPglite(db: PGlite): Promise<Blob> {
  return db.dumpDataDir("none");
}
