package io.litegres.client.model;

import java.util.Map;

/**
 * Connection details for one disposable database, as returned by the daemon
 * on creation. The {@code password} is only available here — never from list
 * or get responses.
 */
public record ConnectionInfo(
        String host,
        int port,
        String database,
        String username,
        String password,
        String postgresUrl,
        String jdbcUrl) {

    public static ConnectionInfo from(Map<String, Object> m) {
        return new ConnectionInfo(
                (String) m.get("host"),
                ((Number) m.get("port")).intValue(),
                (String) m.get("database"),
                (String) m.get("username"),
                (String) m.get("password"),
                (String) m.get("postgresUrl"),
                (String) m.get("jdbcUrl"));
    }
}
