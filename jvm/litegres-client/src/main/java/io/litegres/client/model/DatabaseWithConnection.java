package io.litegres.client.model;

/**
 * A database plus its credentials. Returned exactly once, at creation time.
 */
public record DatabaseWithConnection(Database database, ConnectionInfo connection) {
}
