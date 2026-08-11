/**
 * Typed errors for the Litegres control API.
 */
export class LitegresError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly details: Record<string, unknown>;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    requestId?: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = "LitegresError";
    this.code = opts.code;
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.details = opts.details ?? {};
  }
}

/** Throw a LitegresError for a non-2xx control API response. */
export async function throwForResponse(response: Response, fallbackMessage: string): Promise<never> {
  let code = "INTERNAL_ERROR";
  let message = fallbackMessage;
  let requestId: string | undefined;
  let details: Record<string, unknown> = {};
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; requestId?: string; details?: Record<string, unknown> };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    requestId = body.error?.requestId;
    details = body.error?.details ?? {};
  } catch {
    // non-JSON error body; keep defaults
  }
  throw new LitegresError({ code, message, status: response.status, requestId, details });
}
