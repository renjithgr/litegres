package spike;

import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresClients;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.DatabaseWithConnection;
import io.litegres.client.model.SessionRequest;
import io.litegres.client.model.SessionWithLeaseToken;
import io.litegres.client.model.TemplateProvisioning;
import io.litegres.client.model.TemplateRequest;
import org.flywaydb.core.Flyway;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.UUID;

/** One abstraction over the two candidate backends: Litegres (PGlite/WASM) or native Postgres + CREATE DATABASE ... TEMPLATE. */
final class Db {
    record Handle(String label, String url, String user, String password, long provisionMs, Runnable release) {
        String urlWith(String params) { return url + (url.contains("?") ? "&" : "?") + params; }
    }

    static final String BACKEND = System.getProperty("spike.backend", "template");
    static final String PG_URL = System.getProperty("spike.pg.url", "jdbc:postgresql://127.0.0.1:55432/postgres");
    static final Path OUT = Path.of(System.getProperty("spike.out", "build/spike-out"));
    static final boolean PREPARE_WORKAROUND = !"false".equals(System.getProperty("spike.prepareWorkaround", "true"));
    private static final String TEMPLATE_DB = "app_template";

    private static LitegresClient client;
    private static String sessionId;
    private static String litegresTemplateId;

    private Db() {}

    static Handle acquire(String label) {
        try {
            Files.createDirectories(OUT);
            ensureTemplate();
            long t0 = System.nanoTime();
            Handle h = BACKEND.equals("litegres") ? acquireLitegres(label, t0) : acquireNative(label, t0);
            log(label, "provision_ms", h.provisionMs());
            return h;
        } catch (Exception e) {
            throw new IllegalStateException("acquire failed for " + label + ": " + e, e);
        }
    }

    // ---------------- template (built once per run, shared across forks via file lock) ----------------

    private static synchronized void ensureTemplate() throws Exception {
        try (FileChannel ch = FileChannel.open(OUT.resolve("template.lock"),
                StandardOpenOption.CREATE, StandardOpenOption.WRITE);
             FileLock ignored = ch.lock()) {
            if (BACKEND.equals("litegres")) ensureLitegresTemplate(); else ensureNativeTemplate();
        }
    }

    private static void ensureNativeTemplate() throws Exception {
        try (Connection c = DriverManager.getConnection(PG_URL, "postgres", "postgres");
             Statement st = c.createStatement()) {
            ResultSet rs = st.executeQuery("SELECT 1 FROM pg_database WHERE datname = '" + TEMPLATE_DB + "'");
            if (rs.next()) return;
            long t0 = System.nanoTime();
            st.execute("CREATE DATABASE " + TEMPLATE_DB);
            migrate(nativeUrl(TEMPLATE_DB), "postgres", "postgres");
            log("-", "template_build_ms", ms(t0));
        }
    }

    private static void ensureLitegresTemplate() throws Exception {
        if (litegresTemplateId != null) return;
        Path idFile = OUT.resolve("template.id");
        if (Files.exists(idFile)) {
            litegresTemplateId = Files.readString(idFile).trim();
            return;
        }
        long t0 = System.nanoTime();
        TemplateProvisioning p = client().createTemplate(TemplateRequest.forProvisioning("sha256:phase0").name("phase0"));
        var conn = p.provisioningDatabase();
        migrate(conn.jdbcUrl(), conn.username(), conn.password());
        litegresTemplateId = client().finalizeTemplate(p.template().id()).id();
        Files.writeString(idFile, litegresTemplateId);
        log("-", "template_build_ms", ms(t0));
    }

    private static void migrate(String url, String user, String pass) {
        var cfg = Flyway.configure().dataSource(url, user, pass).locations("classpath:db/migration");
        // Needed only for the PGlite engine (Flyway deadlocks across its two connections).
        if (PREPARE_WORKAROUND) cfg.configuration(java.util.Map.of("flyway.postgresql.transactional.lock", "false"));
        cfg.load().migrate();
    }

    // ---------------- native ----------------

    private static String nativeUrl(String db) {
        return PG_URL.substring(0, PG_URL.lastIndexOf('/') + 1) + db;
    }

    private static Handle acquireNative(String label, long t0) throws Exception {
        String name = "t_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        try (Connection c = DriverManager.getConnection(PG_URL, "postgres", "postgres");
             Statement st = c.createStatement()) {
            st.execute("CREATE DATABASE " + name + " TEMPLATE " + TEMPLATE_DB);
        }
        long took = ms(t0);
        return new Handle(label, nativeUrl(name), "postgres", "postgres", took, () -> {
            try (Connection c = DriverManager.getConnection(PG_URL, "postgres", "postgres");
                 Statement st = c.createStatement()) {
                st.execute("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
            } catch (Exception ignored) {}
        });
    }

    // ---------------- litegres ----------------

    private static synchronized LitegresClient client() {
        if (client == null) {
            client = LitegresClients.connect();
            SessionWithLeaseToken s = client.createSession(SessionRequest.create().clientName("phase0").ttlSeconds(3600));
            sessionId = s.session().id();
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                try { client.deleteSession(sessionId); } catch (Exception ignored) {}
            }));
        }
        return client;
    }

    private static Handle acquireLitegres(String label, long t0) {
        DatabaseWithConnection d = client().createDatabase(
                DatabaseRequest.fromTemplate(litegresTemplateId).sessionId(sessionId).ttlSeconds(3000));
        long took = ms(t0);
        var c = d.connection();
        return new Handle(label, c.jdbcUrl() + (PREPARE_WORKAROUND ? "&prepareThreshold=0" : ""), c.username(), c.password(), took, () -> {
            try { client().deleteDatabase(d.database().id()); } catch (Exception ignored) {}
        });
    }

    // ---------------- misc ----------------

    static long ms(long t0) { return (System.nanoTime() - t0) / 1_000_000; }

    static synchronized void log(String label, String event, long value) {
        try {
            Files.createDirectories(OUT);
            Files.writeString(OUT.resolve("timings.csv"),
                    BACKEND + "," + ProcessHandle.current().pid() + "," + label + "," + event + "," + value + "\n",
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) {}
    }

    static synchronized void report(String file, String line) {
        try {
            Files.createDirectories(OUT);
            Files.writeString(OUT.resolve(file), line + "\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) {}
    }
}
