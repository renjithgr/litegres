/**
 * Ambient declarations for binary assets imported with `{ type: "file" }`.
 * At runtime Bun resolves these to real paths (source) or $bunfs URLs
 * (compiled executable); TypeScript only needs to know they are strings.
 */
declare module "*.wasm" {
  const url: string;
  export default url;
}

declare module "*.data" {
  const url: string;
  export default url;
}

declare module "*.tar.gz" {
  const url: string;
  export default url;
}
