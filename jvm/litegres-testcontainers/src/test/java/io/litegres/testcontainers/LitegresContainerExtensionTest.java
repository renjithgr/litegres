package io.litegres.testcontainers;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.testcontainers.DockerClientFactory;

import io.litegres.junit5.LitegresDatabase;

/**
 * Extension usage: one {@link LitegresContainer} (daemon in Docker) plus one
 * disposable database per test method, injected as {@link LitegresDatabase}
 * or as a live {@link Connection} — the same API as {@code LitegresExtension}
 * but with the daemon running in a container.
 *
 * <p>Requires Docker and the Litegres image; skipped when Docker is
 * unavailable.</p>
 */
class LitegresContainerExtensionTest {

    @RegisterExtension
    static LitegresContainer litegres = new LitegresContainer();

    @BeforeAll
    static void requireDocker() {
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker is not available");
    }

    @Test
    void eachTestGetsItsOwnIsolatedDatabase(LitegresDatabase db) throws Exception {
        try (Connection conn = DriverManagerConnection.of(db); Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE accounts (id bigint primary key, name text not null)");
            st.execute("INSERT INTO accounts VALUES (1, 'alice')");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM accounts")) {
                rs.next();
                assertEquals(1, rs.getInt(1));
            }
        }
    }

    @Test
    void previousTestTablesDoNotLeak(LitegresDatabase db) throws Exception {
        try (Connection conn = DriverManagerConnection.of(db); Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT to_regclass('accounts')")) {
                rs.next();
                assertNull(rs.getString(1)); // created by the other test, must be gone here
            }
        }
    }

    @Test
    void connectionParameterIsAutoClosed(Connection conn) throws Exception {
        try (Statement st = conn.createStatement();
                ResultSet rs = st.executeQuery("SELECT 1")) {
            rs.next();
            assertEquals(1, rs.getInt(1));
        }
    }

    private static final class DriverManagerConnection {
        static Connection of(LitegresDatabase db) throws Exception {
            return java.sql.DriverManager.getConnection(db.jdbcUrl(), db.username(), db.password());
        }
    }
}
