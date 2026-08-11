package io.litegres.junit5;

import java.sql.Connection;
import java.sql.DriverManager;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.junit.jupiter.api.extension.AfterAllCallback;
import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.BeforeEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolutionException;
import org.junit.jupiter.api.extension.ParameterResolver;

import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresClients;
import io.litegres.client.LitegresException;
import io.litegres.client.model.Database;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.SessionRequest;
import io.litegres.client.model.SessionWithLeaseToken;

/**
 * JUnit 5 extension that gives every test method its own disposable
 * Litegres database.
 *
 * <pre>{@code
 * @RegisterExtension
 * static LitegresExtension postgres = LitegresExtension.empty();
 *
 * @Test
 * void test(LitegresDatabase db) { ... }          // connection details
 * @Test
 * void test2(Connection conn) { ... }             // live JDBC connection
 * }</pre>
 *
 * Lifecycle:
 * <ul>
 *   <li>first use: connect to the daemon (runtime-dir discovery) and create
 *       one session for the whole test class;</li>
 *   <li>{@code beforeEach}: create a database (empty, initialized with
 *       statements, or cloned from a template);</li>
 *   <li>{@code afterEach}: close any injected {@link Connection} and delete
 *       the database;</li>
 *   <li>{@code afterAll}: close the session, destroying everything it owned.</li>
 * </ul>
 *
 * The daemon must be running ({@code litegresd run}); discovery honors
 * {@code LITEGRES_RUNTIME_DIR} / {@code XDG_RUNTIME_DIR} / the default
 * runtime dir, matching the daemon.
 */
public final class LitegresExtension implements BeforeEachCallback, AfterEachCallback, AfterAllCallback, ParameterResolver {

    private static final ExtensionContext.Namespace DB_NS = ExtensionContext.Namespace.create("litegres", "db");
    private static final ExtensionContext.Namespace SESSION_NS = ExtensionContext.Namespace.create("litegres", "session");
    private static final String DB_KEY = "database";
    private static final String CONN_KEY = "connection";

    private final DatabaseRequest.Builder databaseRequest;
    private String controlUrl;
    private String controlToken;
    private int sessionTtlSeconds = 1800;
    private String clientName = "litegres-junit5";
    /** Pre-built client (e.g. from LitegresContainer); beats discovery. */
    private LitegresClient clientOverride;

    private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();

    private LitegresExtension(DatabaseRequest.Builder request) {
        this.databaseRequest = request;
    }

    /** A fresh empty database per test. */
    public static LitegresExtension empty() {
        return new LitegresExtension(DatabaseRequest.builder());
    }

    /** A fresh clone of a template per test. */
    public static LitegresExtension fromTemplate(String templateId) {
        return new LitegresExtension(DatabaseRequest.builder().templateId(templateId));
    }

    /** A fresh database initialized with the given statements per test. */
    public static LitegresExtension withStatements(String... statements) {
        DatabaseRequest.Builder b = DatabaseRequest.builder();
        for (String s : statements) {
            b.statement(s);
        }
        return new LitegresExtension(b);
    }

    /** Use an explicit daemon control URL instead of discovery. */
    public LitegresExtension controlUrl(String controlUrl) {
        this.controlUrl = controlUrl;
        return this;
    }

    /** Use an explicit daemon token instead of the discovered one. */
    public LitegresExtension controlToken(String controlToken) {
        this.controlToken = controlToken;
        return this;
    }

    /**
     * Use a pre-built {@link LitegresClient} instead of discovery. Used by
     * {@code LitegresContainer} to inject a client whose connection info has
     * been rewritten for Docker port mapping.
     */
    public LitegresExtension client(LitegresClient client) {
        this.clientOverride = client;
        return this;
    }

    /** Database TTL in seconds (default 600). */
    public LitegresExtension ttlSeconds(int ttlSeconds) {
        this.databaseRequest.ttlSeconds(ttlSeconds);
        return this;
    }

    /** Session TTL in seconds (default 1800). */
    public LitegresExtension sessionTtlSeconds(int ttlSeconds) {
        this.sessionTtlSeconds = ttlSeconds;
        return this;
    }

    public LitegresExtension metadata(String key, String value) {
        this.databaseRequest.metadata(key, value);
        return this;
    }

    // ---- lifecycle ----

    @Override
    public void beforeEach(ExtensionContext context) {
        LitegresClient client = client(context);
        SessionWithLeaseToken session = ensureSession(context, client);
        DatabaseRequest request = databaseRequest.build().sessionId(session.session().id());
        io.litegres.client.model.DatabaseWithConnection created = client.createDatabase(request);
        context.getStore(DB_NS).put(DB_KEY, created);
    }

    @Override
    public void afterEach(ExtensionContext context) {
        ExtensionContext.Store store = context.getStore(DB_NS);
        Object conn = store.remove(CONN_KEY);
        if (conn instanceof Connection c) {
            try {
                c.close();
            } catch (Exception ignored) {
                // best effort
            }
        }
        Object db = store.remove(DB_KEY);
        if (db instanceof io.litegres.client.model.DatabaseWithConnection created) {
            try {
                client(context).deleteDatabase(created.database().id());
            } catch (LitegresException e) {
                // database may already be gone; deletion is idempotent
            }
        }
    }

    @Override
    public void afterAll(ExtensionContext context) {
        ExtensionContext.Store store = context.getRoot().getStore(SESSION_NS);
        Object session = store.remove(sessionKey(context));
        if (session instanceof SessionWithLeaseToken s) {
            try {
                client(context).deleteSession(s.session().id());
            } catch (LitegresException ignored) {
                // idempotent
            }
        }
        Object client = store.remove("client");
        if (client instanceof LitegresClient c) {
            c.close();
        }
    }

    // ---- parameter resolution ----

    @Override
    public boolean supportsParameter(ParameterContext parameterContext, ExtensionContext extensionContext) {
        Class<?> type = parameterContext.getParameter().getType();
        return type == LitegresDatabase.class || type == Connection.class;
    }

    @Override
    public Object resolveParameter(ParameterContext parameterContext, ExtensionContext context) {
        Object raw = context.getStore(DB_NS).get(DB_KEY);
        if (!(raw instanceof io.litegres.client.model.DatabaseWithConnection created)) {
            throw new ParameterResolutionException(
                    "LitegresExtension could not find the per-test database. Is the extension registered on this test?");
        }
        if (parameterContext.getParameter().getType() == LitegresDatabase.class) {
            Database db = created.database();
            return new LitegresDatabase(db.id(), db.sessionId(), db.templateId(), db, created.connection());
        }
        if (parameterContext.getParameter().getType() == Connection.class) {
            try {
                Connection connection = DriverManager.getConnection(
                        created.connection().jdbcUrl(),
                        created.connection().username(),
                        created.connection().password());
                context.getStore(DB_NS).put(CONN_KEY, connection);
                return connection;
            } catch (Exception e) {
                throw new ParameterResolutionException("Failed to open JDBC connection: " + e.getMessage(), e);
            }
        }
        throw new ParameterResolutionException("Unsupported parameter type " + parameterContext.getParameter().getType());
    }

    // ---- helpers ----

    private LitegresClient client(ExtensionContext context) {
        ExtensionContext.Store store = context.getRoot().getStore(SESSION_NS);
        return (LitegresClient) store.getOrComputeIfAbsent("client", k -> {
            if (clientOverride != null) {
                return clientOverride;
            }
            try {
                if (controlUrl != null && controlToken != null) {
                    return LitegresClients.connectTo(controlUrl, controlToken);
                }
                return LitegresClients.connect();
            } catch (LitegresException e) {
                throw new LitegresException(
                        "DAEMON_NOT_FOUND",
                        "Could not connect to the Litegres daemon: " + e.getMessage(),
                        e.status(), e.requestId(), e.details());
            }
        });
    }

    private SessionWithLeaseToken ensureSession(ExtensionContext context, LitegresClient client) {
        ExtensionContext.Store store = context.getRoot().getStore(SESSION_NS);
        String key = sessionKey(context);
        Object existing = store.get(key);
        if (existing instanceof SessionWithLeaseToken s) {
            return s;
        }
        synchronized (sessionLocks.computeIfAbsent(key, k -> new Object())) {
            Object now = store.get(key);
            if (now instanceof SessionWithLeaseToken s) {
                return s;
            }
            SessionWithLeaseToken created = client.createSession(
                    SessionRequest.create()
                            .clientName(clientName)
                            .clientFramework("junit5")
                            .ttlSeconds(sessionTtlSeconds));
            store.put(key, created);
            return created;
        }
    }

    private static String sessionKey(ExtensionContext context) {
        return "session:" + context.getTestClass().map(Class::getName).orElse("anonymous");
    }
}
