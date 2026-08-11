/**
 * ApiServer: the localhost HTTP control plane (Bun.serve).
 *
 * Responsibilities: routing, request IDs, body parsing with size limits,
 * authentication enforcement, structured error serialization. It never
 * touches PGlite or socket servers directly.
 */
import { ApiError, toErrorObject, isApiError } from "./errors";
import { routes, type ApiContext, type Route } from "./routes";
import { generateId } from "../ids";
import type { Metrics } from "../observability/metrics";
import type { Logger } from "../observability/logger";

const LEASE_TOKEN_HEADER = "x-litegres-lease-token";

interface CompiledRoute {
  route: Route;
  regex: RegExp;
  paramNames: string[];
}

export interface ApiServerOptions {
  ctx: ApiContext;
  logger: Logger;
  metrics: Metrics;
  hostname: string;
  port: number;
}

export class ApiServer {
  private ctx: ApiContext;
  private logger: Logger;
  private metrics: Metrics;
  private hostname: string;
  private port: number;
  private compiled: CompiledRoute[];
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(opts: ApiServerOptions) {
    this.ctx = opts.ctx;
    this.logger = opts.logger;
    this.metrics = opts.metrics;
    this.hostname = opts.hostname;
    this.port = opts.port;
    this.compiled = routes(this.ctx).map(compileRoute);
  }

  get actualPort(): number {
    return this.server?.port ?? this.port;
  }

  async start(): Promise<void> {
    const server = Bun.serve({
      hostname: this.hostname,
      port: this.port,
      maxRequestBodySize: 2 * 1024 * 1024,
      fetch: (request) => this.handle(request),
    });
    this.server = server;
    this.logger.info("control API listening", {
      url: `http://${this.hostname}:${server.port}`,
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.stop(true);
    this.server = null;
  }

  private async handle(request: Request): Promise<Response> {
    const requestId = generateId("req");
    const started = performance.now();
    const url = new URL(request.url);
    const route = this.match(request.method, url.pathname);
    const headers = request.headers;

    try {
      if (!route) {
        throw new ApiError("INVALID_REQUEST", `No such endpoint: ${request.method} ${url.pathname}`, 404);
      }

      // Authentication.
      const bearer = headers.get("authorization");
      const leaseToken = headers.get(LEASE_TOKEN_HEADER);
      let actor;
      if (route.route.auth === "none") {
        actor = undefined;
      } else if (route.route.auth === "daemon") {
        actor = this.ctx.auth.requireActor({ authorization: bearer, leaseTokenHeader: leaseToken });
        if (actor.kind !== "daemon") {
          throw new ApiError(
            "UNAUTHORIZED",
            "This endpoint requires the daemon control token.",
            403,
          );
        }
      } else {
        actor = this.ctx.auth.resolveActor({ authorization: bearer, leaseTokenHeader: leaseToken });
      }

      // Parse body once for body-carrying methods; handlers read it synchronously.
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        const body = await parseBody(request);
        (request as unknown as { __parsedBody?: Record<string, unknown> }).__parsedBody = body;
      }

      const params: Record<string, string> = {};
      const match = route.regex.exec(url.pathname);
      if (match) {
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1] ?? "");
        });
      }

      const response = await route.route.handler({ request, params, actor, requestId, ctx: this.ctx });
      this.metrics.increment("litegres_http_requests_total");
      this.metrics.increment(`litegres_http_${request.method.toLowerCase()}_${route.route.path.replace(/[^a-z0-9]/gi, "_")}_total`);
      return response;
    } catch (err) {
      const status = isApiError(err) ? err.httpStatus : 500;
      this.metrics.increment("litegres_http_errors_total");
      this.logger.warn("request failed", {
        requestId,
        method: request.method,
        path: url.pathname,
        errorCode: isApiError(err) ? err.code : "INTERNAL_ERROR",
        status,
        durationMs: Math.round(performance.now() - started),
      });
      return new Response(JSON.stringify(toErrorObject(err, requestId)), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  }

  private match(method: string, pathname: string): CompiledRoute | undefined {
    for (const compiled of this.compiled) {
      if (compiled.route.method !== method) continue;
      if (compiled.regex.test(pathname)) return compiled;
    }
    return undefined;
  }
}

function compileRoute(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const pattern = route.path.replace(/:[a-zA-Z0-9_]+/g, (param) => {
    paramNames.push(param.slice(1));
    return "([^/]+)";
  });
  return { route, regex: new RegExp(`^${pattern}$`), paramNames };
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text().catch(() => "");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new ApiError("INVALID_REQUEST", "Invalid JSON body.", 400);
  }
}
