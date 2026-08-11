/**
 * Control-plane authentication.
 *
 * All /v1 mutations require either the daemon control token (Authorization:
 * Bearer <token>) or a valid session lease token that specifically authorizes
 * the target resource. Health endpoints are unauthenticated on localhost.
 */
import { ApiError } from "../api/errors";
import type { SessionRegistry } from "../registry/session-registry";
import type { SessionId } from "../types";

export type AuthActor =
  | { kind: "daemon" }
  | { kind: "session"; sessionId: SessionId };

export class AuthManager {
  constructor(
    private readonly controlToken: string,
    private readonly sessions: SessionRegistry,
  ) {}

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
    return diff === 0;
  }

  isValidControlToken(token: string): boolean {
    return this.timingSafeEqual(token, this.controlToken);
  }

  /** Extract the bearer token from an Authorization header, if present. */
  static bearerToken(authorization: string | null): string | undefined {
    if (!authorization) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return match?.[1];
  }

  /**
   * Resolve who is making this request.
   * Returns undefined when unauthenticated.
   */
  resolveActor(opts: {
    authorization: string | null;
    /** Session lease token supplied via X-Litegres-Lease-Token header. */
    leaseTokenHeader: string | null;
  }): AuthActor | undefined {
    const bearer = AuthManager.bearerToken(opts.authorization);
    if (bearer && this.isValidControlToken(bearer)) {
      return { kind: "daemon" };
    }
    if (opts.leaseTokenHeader) {
      const session = this.findSessionByLeaseToken(opts.leaseTokenHeader);
      if (session) return { kind: "session", sessionId: session.id };
    }
    return undefined;
  }

  /** Resolve an actor, throwing UNAUTHORIZED when absent. */
  requireActor(opts: {
    authorization: string | null;
    leaseTokenHeader: string | null;
  }): AuthActor {
    const actor = this.resolveActor(opts);
    if (!actor) {
      throw new ApiError(
        "UNAUTHORIZED",
        "Authentication required. Provide a valid daemon control token (Authorization: Bearer <token>) or session lease token.",
        401,
      );
    }
    return actor;
  }

  private findSessionByLeaseToken(token: string): { id: SessionId; isActive: boolean } | undefined {
    for (const session of this.sessions.list()) {
      if (this.timingSafeEqual(session.leaseToken, token)) {
        return { id: session.id, isActive: session.isActive };
      }
    }
    return undefined;
  }

  /**
   * Verify that the actor may perform a database-scoped operation.
   * Daemon token authorizes everything; a session token authorizes only
   * databases owned by that session.
   */
  authorizeDatabase(actor: AuthActor, databaseSessionId: SessionId | undefined): void {
    if (actor.kind === "daemon") return;
    if (databaseSessionId === undefined || actor.sessionId !== databaseSessionId) {
      throw new ApiError(
        "UNAUTHORIZED",
        `Session ${actor.sessionId} is not authorized to manage this database.`,
        403,
      );
    }
  }

  /** Verify the actor may mutate the given session. */
  authorizeSession(actor: AuthActor, sessionId: SessionId): void {
    if (actor.kind === "daemon") return;
    if (actor.sessionId !== sessionId) {
      throw new ApiError(
        "UNAUTHORIZED",
        `Session ${actor.sessionId} is not authorized to manage session ${sessionId}.`,
        403,
      );
    }
  }

  /** Lease tokens may create databases inside their own session. */
  authorizeSessionScope(actor: AuthActor, sessionId: SessionId | undefined): void {
    if (actor.kind === "daemon") return;
    if (sessionId === undefined || actor.sessionId !== sessionId) {
      throw new ApiError(
        "UNAUTHORIZED",
        `Session ${actor.sessionId} may only create databases within its own session.`,
        403,
      );
    }
  }
}
