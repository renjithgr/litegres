/**
 * API error model. Every error surfaced through the control plane is an
 * ApiError (or is wrapped into one) so the HTTP layer can serialize a
 * consistent `{ error: { code, message, requestId, details } }` shape.
 */
export const ERROR_CODES = [
  "UNAUTHORIZED",
  "INVALID_REQUEST",
  "INVALID_CONFIGURATION",
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "DATABASE_NOT_FOUND",
  "DATABASE_NOT_READY",
  "DATABASE_CAPACITY_EXHAUSTED",
  "TEMPLATE_NOT_FOUND",
  "TEMPLATE_NOT_READY",
  "TEMPLATE_CAPACITY_EXHAUSTED",
  "INVALID_STATE_TRANSITION",
  "DATABASE_CREATION_FAILED",
  "TEMPLATE_CREATION_FAILED",
  "DATABASE_CLEANUP_FAILED",
  "PGLITE_STARTUP_FAILED",
  "SOCKET_SERVER_STARTUP_FAILED",
  "DATA_PLANE_PORTS_EXHAUSTED",
  "READINESS_CHECK_FAILED",
  "DAEMON_ALREADY_RUNNING",
  "DAEMON_NOT_READY",
  "INTERNAL_ERROR",
  "PAYLOAD_TOO_LARGE",
  "EXEC_FAILED",
  "EXEC_TIMEOUT",
  "EXEC_ROW_LIMIT",
  "RESET_NOT_SUPPORTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;
  /** A stable identifier for this failure instance (populated by the HTTP layer). */
  requestId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus = 400,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  withRequestId(requestId: string): this {
    this.requestId = requestId;
    return this;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Serialize any thrown value into a JSON-safe error object. */
export function toErrorObject(
  err: unknown,
  requestId: string,
): { error: Record<string, unknown> } {
  if (err instanceof ApiError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        requestId,
        details: err.details ?? {},
      },
    };
  }
  const message =
    err instanceof Error ? err.message : "An unexpected error occurred.";
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "An internal error occurred.",
      requestId,
      details: { reason: message },
    },
  };
}
