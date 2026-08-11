package io.litegres.testcontainers;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.DockerClientFactory;

import io.litegres.client.LitegresClient;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.DatabaseWithConnection;
import io.litegres.client.model.SessionRequest;
import io.litegres.client.model.SessionWithLeaseToken;

/**
 * Manual (non-extension) usage: start the Litegres container, talk to its
 * control plane, and connect to databases through the published data-plane
 * ports.
 *
 * <p>Requires Docker and the {@code litegres/litegresd:0.1.0} image (build
 * with {@code bun run docker-build} at the repo root; override with
 * {@code -PlitegresDockerImage=...}). Skipped when Docker is unavailable.</p>
 */
class LitegresContainerManualTest {

    private static LitegresContainer litegres;

    @BeforeAll
    static void start() {
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker is not available");
        litegres = new LitegresContainer();
        litegres.start();
    }

    @AfterAll
    static void stop() {
        if (litegres != null) {
            litegres.stop();
        }
    }

    @Test
    void controlPlaneAndDataPlaneWorkThroughPublishedPorts() throws Exception {
        try (LitegresClient client = litegres.getClient()) {
            SessionWithLeaseToken session = client.createSession(
                    SessionRequest.create().clientName("testcontainers-manual").ttlSeconds(1800));

            DatabaseWithConnection database = client.createDatabase(
                    DatabaseRequest.empty().sessionId(session.session().id()).ttlSeconds(600)
                            .statement("CREATE TABLE accounts (id bigint primary key, name text not null)"));

            // The daemon advertises in-container addresses; the container must
            // rewrite them to the Docker host's published ports.
            assertEquals(litegres.getHost(), database.connection().host());
            assertNotEquals(0, database.connection().port());

            try (Connection conn = DriverManager.getConnection(
                    database.connection().jdbcUrl(),
                    database.connection().username(),
                    database.connection().password());
                    Statement st = conn.createStatement()) {
                st.execute("INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob')");
                try (ResultSet rs = st.executeQuery("SELECT count(*) FROM accounts")) {
                    rs.next();
                    assertEquals(2, rs.getInt(1));
                }
            }

            // get/list also report the rewritten host/port
            var listed = client.listDatabases(null);
            assertTrue(listed.stream().anyMatch(d -> d.id().equals(database.database().id())));
            assertEquals(litegres.getHost(), listed.get(0).host());
        }
    }

    @Test
    void databasesGetDistinctPublishedPorts() {
        try (LitegresClient client = litegres.getClient()) {
            SessionWithLeaseToken session = client.createSession(
                    SessionRequest.create().clientName("testcontainers-ports").ttlSeconds(1800));
            DatabaseWithConnection a = client.createDatabase(
                    DatabaseRequest.empty().sessionId(session.session().id()).ttlSeconds(600));
            DatabaseWithConnection b = client.createDatabase(
                    DatabaseRequest.empty().sessionId(session.session().id()).ttlSeconds(600));
            assertNotNull(a.connection());
            assertNotNull(b.connection());
            assertNotEquals(a.connection().port(), b.connection().port());
        }
    }
}
