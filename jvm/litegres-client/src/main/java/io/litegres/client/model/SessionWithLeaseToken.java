package io.litegres.client.model;

/**
 * A session plus its lease token. The token is returned exactly once, at
 * session creation, and authorizes scoped operations for that session.
 */
public record SessionWithLeaseToken(Session session, String leaseToken) {
}
