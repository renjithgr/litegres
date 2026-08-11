package io.litegres.junit5;

import io.litegres.client.model.Database;
import io.litegres.client.model.ConnectionInfo;

/**
 * The disposable database created for one test method, plus its connection
 * details. Injected into test methods as a parameter.
 */
public record LitegresDatabase(
        String id,
        String sessionId,
        String templateId,
        Database database,
        ConnectionInfo connection) {

    public String jdbcUrl() {
        return connection.jdbcUrl();
    }

    public String postgresUrl() {
        return connection.postgresUrl();
    }

    public String host() {
        return connection.host();
    }

    public int port() {
        return connection.port();
    }

    public String username() {
        return connection.username();
    }

    public String password() {
        return connection.password();
    }

    public String databaseName() {
        return connection.database();
    }
}
