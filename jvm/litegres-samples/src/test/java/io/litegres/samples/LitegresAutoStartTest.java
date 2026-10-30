package io.litegres.samples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import io.litegres.client.DaemonLauncher;
import io.litegres.client.Discovery;
import io.litegres.client.LitegresClient;
import io.litegres.client.LitegresClients;
import io.litegres.client.LitegresException;
import io.litegres.client.model.DatabaseRequest;
import io.litegres.client.model.DatabaseWithConnection;
import io.litegres.client.model.SessionRequest;

/**
 * Runs in its own JVM and runtime dir (Gradle task {@code autoStartTest}) and
 * needs a litegresd binary plus a PostgreSQL server:
 * {@code -PlitegresBin=... -PlitegresPostgresUrl=postgresql://...}. Skipped
 * otherwise.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class LitegresAutoStartTest {

    @BeforeAll
    void requireBinaryAndServer() {
        assumeTrue(DaemonLauncher.findBinary().isPresent(), "no litegresd binary (set -PlitegresBin)");
        assumeTrue(System.getProperty("litegres.postgresUrl") != null, "no PostgreSQL URL (set -PlitegresPostgresUrl)");
        // Fresh state: nothing may be running in this test's runtime dir.
        stopDaemon();
    }

    @AfterAll
    void tearDown() {
        stopDaemon();
    }

    @Test
    void autoStartDisabledFailsClearlyWhenNothingIsRunning() {
        String previous = System.getProperty("litegres.autoStart");
        System.setProperty("litegres.autoStart", "false");
        try {
            LitegresException e = assertThrows(LitegresException.class, LitegresClients::connectOrStart);
            assertEquals("DAEMON_NOT_FOUND", e.code());
        } finally {
            restore("litegres.autoStart", previous);
        }
    }

    @Test
    void concurrentCallersStartExactlyOneSharedDaemon() throws Exception {
        int callers = 4;
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        try {
            List<Future<String>> urls = new ArrayList<>();
            for (int i = 0; i < callers; i++) {
                urls.add(pool.submit(() -> {
                    try (LitegresClient client = LitegresClients.connectOrStart()) {
                        return client.controlUrl();
                    }
                }));
            }
            String first = urls.get(0).get();
            for (Future<String> url : urls) {
                assertEquals(first, url.get(), "all callers must end up on the same daemon");
            }
        } finally {
            pool.shutdownNow();
        }

        // the started daemon really serves databases
        try (LitegresClient client = LitegresClients.connectOrStart()) {
            var session = client.createSession(SessionRequest.create().clientName("autostart-test").ttlSeconds(600));
            DatabaseWithConnection db = client.createDatabase(
                    DatabaseRequest.empty().sessionId(session.session().id()).ttlSeconds(300));
            try (Connection conn = DriverManager.getConnection(
                    db.connection().jdbcUrl(), db.connection().username(), db.connection().password());
                    Statement st = conn.createStatement();
                    ResultSet rs = st.executeQuery("SELECT 1")) {
                assertTrue(rs.next());
                assertEquals(1, rs.getInt(1));
            }
            client.deleteSession(session.session().id());
        }
    }

    private static void stopDaemon() {
        Path runtimeDir = Discovery.runtimeDir();
        if (!Files.exists(runtimeDir.resolve("daemon.json"))) {
            return;
        }
        DaemonLauncher.findBinary().ifPresent(bin -> {
            try {
                ProcessBuilder pb = new ProcessBuilder(bin.toString(), "stop");
                pb.environment().put("LITEGRES_RUNTIME_DIR", runtimeDir.toString());
                pb.redirectErrorStream(true);
                pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
                pb.start().waitFor();
            } catch (Exception ignored) {
                // best effort
            }
        });
    }

    private static void restore(String key, String value) {
        if (value == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }
}
