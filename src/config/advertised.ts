/**
 * Advertised endpoint rewriting.
 *
 * The daemon binds data-plane (PostgreSQL) endpoints to `config.host`
 * (typically 127.0.0.1 or 0.0.0.0 inside a container) on OS-assigned or
 * fixed-range ports. Those addresses are correct for clients that share the
 * daemon's network namespace but wrong for clients outside a container.
 *
 * `publicHost` / `publicPortBase` let an operator advertise a different
 * address in every connection string the control API returns, without
 * changing where the daemon actually binds:
 *
 *   - publicHost:    replaces the advertised host (e.g. "localhost" when the
 *                    container's data-plane range is published 1:1 on the
 *                    Docker host).
 *   - publicPortBase: when the data-plane range [dataPlanePortBase,
 *                    dataPlanePortBase + dataPlanePortCount) is published on
 *                    different host ports, shift advertised ports by
 *                    (publicPortBase - dataPlanePortBase).
 *
 * Internal use (readiness checks, the CLI) keeps using the real bind
 * address; only API responses are rewritten.
 */
import type { DaemonConfig } from "./config";

export interface AdvertisedEndpoint {
  host: string;
  port: number;
}

/**
 * The host to advertise for a data-plane endpoint bound at `bindHost`.
 */
export function advertisedHost(config: Pick<DaemonConfig, "publicHost">, bindHost: string): string {
  return config.publicHost ?? bindHost;
}

/**
 * The port to advertise for a data-plane endpoint bound at `bindPort`.
 * Ports outside the configured data-plane range are returned unchanged.
 */
export function advertisedPort(
  config: Pick<DaemonConfig, "publicPortBase" | "dataPlanePortBase" | "dataPlanePortCount">,
  bindPort: number,
): number {
  const { publicPortBase, dataPlanePortBase, dataPlanePortCount } = config;
  if (
    publicPortBase !== undefined &&
    dataPlanePortCount > 0 &&
    bindPort >= dataPlanePortBase &&
    bindPort < dataPlanePortBase + dataPlanePortCount
  ) {
    return bindPort - dataPlanePortBase + publicPortBase;
  }
  return bindPort;
}

/** Combined host+port rewriting for one endpoint. */
export function advertisedEndpoint(
  config: Pick<DaemonConfig, "publicHost" | "publicPortBase" | "dataPlanePortBase" | "dataPlanePortCount">,
  bindHost: string,
  bindPort: number,
): AdvertisedEndpoint {
  return {
    host: advertisedHost(config, bindHost),
    port: advertisedPort(config, bindPort),
  };
}
