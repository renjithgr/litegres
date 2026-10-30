/**
 * Advertised endpoint rewriting.
 *
 * Databases live on one PostgreSQL server whose address is correct for
 * clients that can reach it directly, but not necessarily for clients
 * elsewhere (for example when the daemon runs in a container and the server's
 * port is published on a different host port).
 *
 * `publicHost` / `publicPort` let an operator advertise a different address in
 * every connection string the control API returns, without changing where the
 * daemon connects. Internal use (readiness checks, the CLI) keeps using the
 * real address; only API responses are rewritten.
 */
import type { DaemonConfig } from "./config";

export interface AdvertisedEndpoint {
  host: string;
  port: number;
}

/** Host and port to advertise for a database served at `host:port`. */
export function advertisedEndpoint(
  config: Pick<DaemonConfig, "publicHost" | "publicPort">,
  host: string,
  port: number,
): AdvertisedEndpoint {
  return {
    host: config.publicHost ?? host,
    port: config.publicPort ?? port,
  };
}
