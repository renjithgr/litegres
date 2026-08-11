package io.litegres.samples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresClients;
import io.litegres.client.model.Database;
import io.litegres.client.model.Template;
import io.litegres.client.model.TemplateRequest;
import io.litegres.junit5.LitegresDatabase;
import io.litegres.junit5.LitegresExtension;

/**
 * Templates: prepare one template once, then every test clones it into an
 * isolated database. Clones are independent — changes in one test never
 * leak into another.
 */
class LitegresTemplateTest {

    private static final String FINGERPRINT = "sha256:samples-template-v1";

    // prepared once, before the extension field below (static init order)
    private static final String templateId = prepareTemplate();

    @RegisterExtension
    static LitegresExtension postgres = LitegresExtension.fromTemplate(templateId);

    private static String prepareTemplate() {
        try (LitegresClient client = LitegresClients.connect()) {
            Template template = client.putTemplate(TemplateRequest.fromStatements(
                    FINGERPRINT,
                    "CREATE TABLE accounts (id bigint primary key, name text not null)",
                    "CREATE TABLE journal_entries (id bigserial primary key, account_id bigint, amount numeric)",
                    "INSERT INTO accounts VALUES (1, 'alice')"));
            assertTrue(template.ready(), "template should be ready: " + template);
            return template.id();
        }
    }

    @Test
    void clonedSchemaAndDataArePresent(LitegresDatabase db) throws Exception {
        try (Connection conn = open(db); Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT name FROM accounts WHERE id = 1")) {
                rs.next();
                assertEquals("alice", rs.getString(1));
            }
            // each test mutates only its own clone
            st.execute("INSERT INTO journal_entries (account_id, amount) VALUES (1, 100)");
        }
    }

    @Test
    void clonesAreIsolated(LitegresDatabase db) throws Exception {
        try (Connection conn = open(db); Statement st = conn.createStatement()) {
            // the journal row inserted by the previous test must not exist here
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM journal_entries")) {
                rs.next();
                assertEquals(0, rs.getInt(1));
            }
        }
    }

    @Test
    void listsTheTemplateViaTheClient() throws Exception {
        try (LitegresClient client = LitegresClients.connect()) {
            List<Template> templates = client.listTemplates();
            assertTrue(templates.stream().anyMatch(t -> FINGERPRINT.equals(t.fingerprint())));
            List<Database> databases = client.listDatabases(io.litegres.client.model.DatabaseFilter.none());
            // the extension's per-test databases are visible here (no credentials)
            assertTrue(databases.size() >= 1);
        }
    }

    private static Connection open(LitegresDatabase db) throws Exception {
        return java.sql.DriverManager.getConnection(db.jdbcUrl(), db.username(), db.password());
    }
}
