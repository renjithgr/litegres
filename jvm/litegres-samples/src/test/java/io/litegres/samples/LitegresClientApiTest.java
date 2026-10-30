package io.litegres.samples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;

import org.junit.jupiter.api.Test;

import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresClients;
import io.litegres.client.LitegresException;
import io.litegres.client.model.ConnectionInfo;
import io.litegres.client.model.Database;
import io.litegres.client.model.DatabaseFilter;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.DatabaseWithConnection;
import io.litegres.client.model.SessionRequest;
import io.litegres.client.model.SessionWithLeaseToken;
import io.litegres.client.model.Template;
import io.litegres.client.model.TemplateProvisioning;
import io.litegres.client.model.TemplateRequest;

/**
 * Raw client usage, without the JUnit extension: sessions, databases,
 * renewals, lease-token scoping, and the external-provisioning template
 * flow (migrations run with your own tooling, then finalize).
 */
class LitegresClientApiTest {

    @Test
    void sessionDatabaseRenewDeleteFlow() throws Exception {
        try (LitegresClient client = LitegresClients.connect()) {
            SessionWithLeaseToken session = client.createSession(
                    SessionRequest.create().clientName("samples").clientFramework("junit5").ttlSeconds(1800));
            assertTrue(session.session().active());
            assertTrue(session.leaseToken() != null && !session.leaseToken().isBlank());

            DatabaseWithConnection created = client.createDatabase(
                    DatabaseRequest.empty().sessionId(session.session().id()).ttlSeconds(600)
                            .statement("CREATE TABLE t (x int)")
                            .statement("INSERT INTO t VALUES (7)"));
            assertTrue(created.database().ready());

            // ordinary JDBC against the PostgreSQL server
            try (Connection conn = open(created.connection());
                    Statement st = conn.createStatement();
                    ResultSet rs = st.executeQuery("SELECT x FROM t")) {
                rs.next();
                assertEquals(7, rs.getInt(1));
            }

            // renew the lease
            Database renewed = client.renewDatabase(created.database().id(), 1200);
            assertTrue(renewed.expiresAt().compareTo(created.database().expiresAt()) > 0);

            // lease-token scoped client can manage only its own session
            try (LitegresClient scoped = LitegresClients.connectWithLeaseToken(client.controlUrl(), session.leaseToken())) {
                scoped.deleteDatabase(created.database().id());
                List<Database> databases = client.listDatabases(DatabaseFilter.bySession(session.session().id()));
                assertEquals(0, databases.size());
            }

            client.deleteSession(session.session().id());
        }
    }

    @Test
    void externalProvisioningTemplateFlow() throws Exception {
        try (LitegresClient client = LitegresClients.connect()) {
            // 1. start provisioning — the daemon gives us a live PG endpoint
            TemplateProvisioning provisioning = client.createTemplate(
                    TemplateRequest.forProvisioning("sha256:samples-provisioning-v1").name("provisioned"));
            assertEquals("provisioning", provisioning.template().status());
            ConnectionInfo endpoint = provisioning.provisioningDatabase();
            assertTrue(endpoint != null && endpoint.port() > 0);

            // 2. run "migrations" with our own tooling against that endpoint
            try (Connection conn = open(endpoint); Statement st = conn.createStatement()) {
                st.execute("CREATE TABLE flyway_schema_history (version text primary key, description text)");
                st.execute("INSERT INTO flyway_schema_history VALUES ('1', 'create accounts')");
                st.execute("CREATE TABLE accounts (id bigint primary key, name text)");
            }

            // 3. finalize: endpoint closes, template becomes immutable
            Template finalized = client.finalizeTemplate(provisioning.template().id());
            assertEquals("ready", finalized.status());

            // 4. clone it
            DatabaseWithConnection clone = client.createDatabase(
                    DatabaseRequest.fromTemplate(provisioning.template().id()).ttlSeconds(600));
            try (Connection conn = open(clone.connection());
                    Statement st = conn.createStatement();
                    ResultSet rs = st.executeQuery("SELECT description FROM flyway_schema_history WHERE version = '1'")) {
                rs.next();
                assertEquals("create accounts", rs.getString(1));
            }

            client.deleteDatabase(clone.database().id());
            client.deleteTemplate(provisioning.template().id());
        }
    }

    @Test
    void typedErrorsCarryCodeAndStatus() {
        try (LitegresClient client = LitegresClients.connect()) {
            LitegresException e = assertThrows(LitegresException.class, () -> client.getDatabase("db_missing"));
            assertEquals("DATABASE_NOT_FOUND", e.code());
            assertEquals(404, e.status());
        }
    }

    private static Connection open(ConnectionInfo connection) throws Exception {
        return DriverManager.getConnection(connection.jdbcUrl(), connection.username(), connection.password());
    }
}
