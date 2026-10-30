package spike;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.*;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Plain-JDBC probes of what a real Postgres guarantees across connections.
 * Every probe gets its own database so one hang cannot poison the next.
 * socketTimeout turns a blocked/hung connection into a failure instead of a stuck build.
 */
class ConnectionSemanticsTest {
    Db.Handle h;
    final ExecutorService ex = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r); t.setDaemon(true); return t; });

    @BeforeEach
    void up(org.junit.jupiter.api.TestInfo info) { h = Db.acquire("sem-" + info.getTestMethod().get().getName()); }

    @AfterEach
    void down() { ex.shutdownNow(); h.release().run(); }

    Connection open() throws SQLException {
        Connection c = DriverManager.getConnection(h.urlWith("socketTimeout=6&connectTimeout=5"), h.user(), h.password());
        c.setAutoCommit(false);
        return c;
    }

    static long one(Connection c, String sql) throws SQLException {
        try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) { rs.next(); return rs.getLong(1); }
    }

    @Test
    void eachConnectionIsItsOwnBackendProcess() throws Exception {
        try (Connection a = open(); Connection b = open()) {
            assertNotEquals(one(a, "SELECT pg_backend_pid()"), one(b, "SELECT pg_backend_pid()"),
                    "connections share one Postgres backend (one session)");
        }
    }

    @Test
    void tempTablesArePerConnection() throws Exception {
        try (Connection a = open(); Connection b = open()) {
            try (Statement s = a.createStatement()) { s.execute("CREATE TEMP TABLE only_mine(x int)"); }
            assertThrows(SQLException.class, () -> one(b, "SELECT count(*) FROM only_mine"),
                    "temp table leaked into another connection");
        }
    }

    @Test
    void advisoryLocksExcludeOtherConnections() throws Exception {
        try (Connection a = open(); Connection b = open()) {
            assertEquals(1, one(a, "SELECT CASE WHEN pg_try_advisory_lock(42) THEN 1 ELSE 0 END"));
            assertEquals(0, one(b, "SELECT CASE WHEN pg_try_advisory_lock(42) THEN 1 ELSE 0 END"),
                    "advisory lock not exclusive across connections (breaks ShedLock/Quartz/Flyway-style locking)");
        }
    }

    @Test
    void openTransactionOnOneConnectionDoesNotBlockUnrelatedQueriesOnAnother() throws Exception {
        try (Connection a = open(); Connection b = open()) {
            try (Statement s = a.createStatement()) { s.execute("INSERT INTO accounts(owner, balance) VALUES ('a', 1)"); } // a stays open
            long t0 = System.nanoTime();
            assertEquals(1, one(b, "SELECT 1"));
            long took = Db.ms(t0);
            Db.report("behavior.csv", Db.BACKEND + ",select1_while_other_tx_open_ms," + took);
            assertTrue(took < 1000);
        }
    }

    @Test
    void readCommittedHidesUncommittedWrites() throws Exception {
        try (Connection a = open(); Connection b = open()) {
            try (Statement s = a.createStatement()) { s.execute("INSERT INTO accounts(owner, balance) VALUES ('ghost', 1)"); }
            assertEquals(0, one(b, "SELECT count(*) FROM accounts WHERE owner = 'ghost'"),
                    "dirty read: B sees A's uncommitted row");
        }
    }

    @Test
    void rollbackOnOneConnectionDoesNotUndoAnotherConnectionsWork() throws Exception {
        try (Connection a = open(); Connection b = open()) {
            try (Statement s = a.createStatement()) { s.execute("INSERT INTO accounts(owner, balance) VALUES ('keep', 1)"); }
            try (Statement s = b.createStatement()) { s.execute("INSERT INTO accounts(owner, balance) VALUES ('drop', 1)"); }
            b.rollback();
            a.commit();
            try (Connection c = open()) {
                assertEquals(1, one(c, "SELECT count(*) FROM accounts WHERE owner = 'keep'"),
                        "A's committed work was lost because B rolled back (shared session)");
                assertEquals(0, one(c, "SELECT count(*) FROM accounts WHERE owner = 'drop'"));
            }
        }
    }

    @Test
    void rowLockBlocksWriterUntilCommit() throws Exception {
        try (Connection seed = open()) {
            try (Statement s = seed.createStatement()) { s.execute("INSERT INTO accounts(id, owner, balance) VALUES (1, 'x', 10)"); }
            seed.commit();
        }
        try (Connection a = open(); Connection b = open()) {
            try (Statement s = a.createStatement()) { s.execute("UPDATE accounts SET balance = 11 WHERE id = 1"); }
            Future<Long> blocked = ex.submit(() -> {
                long t0 = System.nanoTime();
                try (Statement s = b.createStatement()) { s.execute("UPDATE accounts SET balance = 12 WHERE id = 1"); }
                b.commit();
                return Db.ms(t0);
            });
            Thread.sleep(1500);
            assertFalse(blocked.isDone(), "writer should be waiting on A's row lock");
            a.commit();
            assertTrue(blocked.get(5, TimeUnit.SECONDS) >= 1400);
            try (Connection c = open()) { assertEquals(12, one(c, "SELECT balance FROM accounts WHERE id = 1")); }
        }
    }

    @Test
    void deadlockIsDetectedAndOneSideAborted() throws Exception {
        try (Connection seed = open()) {
            try (Statement s = seed.createStatement()) {
                s.execute("INSERT INTO accounts(id, owner, balance) VALUES (1,'x',1),(2,'y',1)");
            }
            seed.commit();
        }
        try (Connection a = open(); Connection b = open()) {
            try (Statement s = a.createStatement()) { s.execute("UPDATE accounts SET balance = 2 WHERE id = 1"); }
            try (Statement s = b.createStatement()) { s.execute("UPDATE accounts SET balance = 2 WHERE id = 2"); }
            Future<String> fa = ex.submit(() -> attempt(a, 2));
            Future<String> fb = ex.submit(() -> attempt(b, 1));
            String ra = fa.get(15, TimeUnit.SECONDS), rb = fb.get(15, TimeUnit.SECONDS);
            Db.report("behavior.csv", Db.BACKEND + ",deadlock_results," + ra + "|" + rb);
            assertTrue(ra.equals("40P01") || rb.equals("40P01"), "expected a 40P01 deadlock, got " + ra + " / " + rb);
        }
    }

    private static String attempt(Connection c, int id) {
        try (Statement s = c.createStatement()) {
            s.execute("UPDATE accounts SET balance = 3 WHERE id = " + id);
            c.commit();
            return "ok";
        } catch (SQLException e) {
            return e.getSQLState() == null ? "err:" + e.getMessage() : e.getSQLState();
        }
    }
}
