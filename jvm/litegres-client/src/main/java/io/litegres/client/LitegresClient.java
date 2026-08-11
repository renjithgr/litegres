package io.litegres.client;

import java.util.List;

import io.litegres.client.model.Database;
import io.litegres.client.model.DatabaseFilter;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.DatabaseWithConnection;
import io.litegres.client.model.ExecResult;
import io.litegres.client.model.Session;
import io.litegres.client.model.SessionRequest;
import io.litegres.client.model.SessionWithLeaseToken;
import io.litegres.client.model.Status;
import io.litegres.client.model.Template;
import io.litegres.client.model.TemplateProvisioning;
import io.litegres.client.model.TemplateRequest;

/**
 * Client for the Litegres control plane. Language-neutral API, no
 * test-framework lifecycle logic.
 */
public interface LitegresClient extends AutoCloseable {

    // ---- sessions ----

    SessionWithLeaseToken createSession(SessionRequest request);

    Session getSession(String sessionId);

    List<Session> listSessions();

    Session renewSession(String sessionId, int ttlSeconds);

    void deleteSession(String sessionId);

    // ---- databases ----

    DatabaseWithConnection createDatabase(DatabaseRequest request);

    Database getDatabase(String databaseId);

    List<Database> listDatabases(DatabaseFilter filter);

    Database renewDatabase(String databaseId, int ttlSeconds);

    void deleteDatabase(String databaseId);

    ExecResult exec(String databaseId, String sql, List<?> parameters);

    default ExecResult exec(String databaseId, String sql) {
        return exec(databaseId, sql, List.of());
    }

    // ---- templates ----

    /** Create a template from statements; idempotent by fingerprint. */
    Template putTemplate(TemplateRequest request);

    /** Start external provisioning; returns the provisioning endpoint. */
    TemplateProvisioning createTemplate(TemplateRequest request);

    Template getTemplate(String templateId);

    List<Template> listTemplates();

    Template finalizeTemplate(String templateId);

    void deleteTemplate(String templateId);

    // ---- daemon ----

    Status status();

    void shutdown();

    /**
     * A view of this client authenticated as the given session (lease
     * token), scoped to that session's own resources.
     */
    LitegresClient withLeaseToken(String leaseToken);

    /** The base control URL. */
    String controlUrl();

    @Override
    void close();
}
