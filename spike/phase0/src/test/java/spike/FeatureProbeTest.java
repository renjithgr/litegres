package spike;

import org.junit.jupiter.api.Test;

import java.sql.*;
import java.util.concurrent.Callable;

/** Records (never asserts) which Postgres features a typical Spring app might lean on actually work. */
class FeatureProbeTest {
    @Test
    void probe() throws Exception {
        probe("ext:pgcrypto", "CREATE EXTENSION IF NOT EXISTS pgcrypto");
        probe("ext:uuid-ossp", "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"");
        probe("ext:pg_trgm", "CREATE EXTENSION IF NOT EXISTS pg_trgm");
        probe("ext:citext", "CREATE EXTENSION IF NOT EXISTS citext");
        probe("ext:hstore", "CREATE EXTENSION IF NOT EXISTS hstore");
        probe("ext:btree_gist", "CREATE EXTENSION IF NOT EXISTS btree_gist");
        probe("ext:unaccent", "CREATE EXTENSION IF NOT EXISTS unaccent");
        probe("ext:vector", "CREATE EXTENSION IF NOT EXISTS vector");
        probe("ext:postgis", "CREATE EXTENSION IF NOT EXISTS postgis");
        probe("gen_random_uuid", "SELECT gen_random_uuid()");
        probe("create-index-concurrently", "CREATE INDEX CONCURRENTLY idx_probe ON accounts(owner)");
        probe("partitioned-table", "CREATE TABLE pt(id int, d date) PARTITION BY RANGE (d)");
        probe("generated-column", "CREATE TABLE gc(a int, b int GENERATED ALWAYS AS (a*2) STORED)");
        probe("full-text-search", "SELECT to_tsvector('english','hello world') @@ to_tsquery('hello')");
        probe("window-fn+cte", "WITH x AS (SELECT g FROM generate_series(1,5) g) SELECT sum(g) OVER (ORDER BY g) FROM x");
        probe("listen-notify", () -> {
            try (Connection a = c(); Connection b = c()) {
                a.createStatement().execute("LISTEN ch");
                b.createStatement().execute("NOTIFY ch, 'hi'");
                a.createStatement().execute("SELECT 1");
                var n = a.unwrap(org.postgresql.PGConnection.class).getNotifications(2000);
                return n != null && n.length > 0 ? "OK" : "FAIL(no notification delivered)";
            }
        });
    }

    static Connection c() throws SQLException {
        Db.Handle h = H;
        Connection c = DriverManager.getConnection(h.urlWith("socketTimeout=8&connectTimeout=5"), h.user(), h.password());
        c.setAutoCommit(true);
        return c;
    }

    static Db.Handle H;

    void probe(String name, String sql) throws Exception {
        probe(name, () -> {
            try (Connection c = c(); Statement s = c.createStatement()) { s.execute(sql); return "OK"; }
        });
    }

    void probe(String name, Callable<String> body) throws Exception {
        H = Db.acquire("probe");
        String result;
        try {
            result = body.call();
        } catch (Throwable t) {
            String m = String.valueOf(t.getMessage()).replace('\n', ' ').replace(',', ';');
            result = "FAIL(" + m.substring(0, Math.min(90, m.length())) + ")";
        } finally {
            H.release().run();
        }
        Db.report("features.csv", Db.BACKEND + "," + name + "," + result);
    }
}
