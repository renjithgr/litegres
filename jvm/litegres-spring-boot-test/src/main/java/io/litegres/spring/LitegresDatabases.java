package io.litegres.spring;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresClients;
import io.litegres.client.LitegresException;
import io.litegres.client.model.ConnectionInfo;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.DatabaseWithConnection;
import io.litegres.client.model.SessionRequest;
import io.litegres.client.model.SessionWithLeaseToken;

/**
 * Per-JVM registry of Litegres databases, one per distinct configuration.
 *
 * <p>Owns a single client and session for the whole JVM. The session and its
 * databases are renewed in the background and deleted when the JVM exits (the
 * daemon's reaper cleans up after a crash).</p>
 */
public final class LitegresDatabases {

    /** What distinguishes one database from another. */
    public record Key(List<String> statements, String templateId, List<String> migrations) {
    }

    /** A database handed to a Spring context. */
    public static final class Handle {
        private final String id;
        private final ConnectionInfo connection;
        private volatile boolean dirty;

        private Handle(String id, ConnectionInfo connection) {
            this.id = id;
            this.connection = connection;
        }

        public String id() {
            return id;
        }

        public ConnectionInfo connection() {
            return connection;
        }

        /** True once any test may have changed the database since creation or the last reset. */
        boolean dirty() {
            return dirty;
        }

        void markDirty() {
            dirty = true;
        }

        /** Restore the database to its initial state. */
        public synchronized void reset() {
            client().resetDatabase(id);
            dirty = false;
        }
    }

    private static final int DATABASE_TTL_SECONDS = 3600;
    private static final int SESSION_TTL_SECONDS = 14400;

    private static final Map<Key, Handle> HANDLES = new ConcurrentHashMap<>();
    private static LitegresClient client;
    private static SessionWithLeaseToken session;
    private static ScheduledExecutorService renewer;

    private LitegresDatabases() {
    }

    /** The database for this configuration, created on first use. */
    public static Handle get(Key key) {
        Handle existing = HANDLES.get(key);
        if (existing != null) {
            return existing;
        }
        synchronized (LitegresDatabases.class) {
            return HANDLES.computeIfAbsent(key, LitegresDatabases::create);
        }
    }

    static synchronized LitegresClient client() {
        if (client == null) {
            LitegresClient c = LitegresClients.connectOrStart();
            session = c.createSession(SessionRequest.create()
                    .clientName("litegres-spring-boot-test")
                    .clientFramework("spring")
                    .ttlSeconds(SESSION_TTL_SECONDS));
            client = c;
            renewer = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "litegres-lease-renewer");
                t.setDaemon(true);
                return t;
            });
            renewer.scheduleAtFixedRate(LitegresDatabases::renewLeases, 10, 10, TimeUnit.MINUTES);
            Runtime.getRuntime().addShutdownHook(new Thread(LitegresDatabases::shutdown, "litegres-shutdown"));
        }
        return client;
    }

    private static Handle create(Key key) {
        LitegresClient c = client();
        validate(key);
        String templateId = key.templateId();
        if (!key.migrations().isEmpty()) {
            templateId = FlywayTemplates.ensure(c, key.migrations());
        }
        DatabaseRequest.Builder request = DatabaseRequest.builder().ttlSeconds(DATABASE_TTL_SECONDS);
        if (templateId != null && !templateId.isEmpty()) {
            request.templateId(templateId);
        }
        for (String statement : key.statements()) {
            request.statement(statement);
        }
        DatabaseWithConnection created = c.createDatabase(request.build().sessionId(session.session().id()));
        return new Handle(created.database().id(), created.connection());
    }

    private static void validate(Key key) {
        int sources = (key.statements().isEmpty() ? 0 : 1)
                + (key.migrations().isEmpty() ? 0 : 1)
                + (key.templateId().isEmpty() ? 0 : 1);
        if (sources > 1) {
            throw new IllegalStateException(
                    "@LitegresTest: use at most one of statements, migrations and templateId.");
        }
    }

    private static void renewLeases() {
        try {
            client.renewSession(session.session().id(), SESSION_TTL_SECONDS);
            for (Handle h : HANDLES.values()) {
                client.renewDatabase(h.id(), DATABASE_TTL_SECONDS);
            }
        } catch (LitegresException ignored) {
            // the daemon may be gone; nothing useful to do from a background thread
        }
    }

    private static void shutdown() {
        try {
            if (renewer != null) {
                renewer.shutdownNow();
            }
            if (client != null && session != null) {
                client.deleteSession(session.session().id());
            }
        } catch (RuntimeException ignored) {
            // best effort: the daemon's reaper expires leaked sessions
        } finally {
            if (client != null) {
                client.close();
            }
        }
    }
}
