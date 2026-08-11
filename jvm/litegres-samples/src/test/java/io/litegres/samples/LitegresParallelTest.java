package io.litegres.samples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.junit.jupiter.api.parallel.Execution;
import org.junit.jupiter.api.parallel.ExecutionMode;

import io.litegres.junit5.LitegresDatabase;
import io.litegres.junit5.LitegresExtension;

/**
 * Parallel execution: this class runs its methods concurrently (JUnit 5
 * {@code @Execution(CONCURRENT)}), and each method still gets its own
 * isolated database. The extension keeps per-test state in per-test stores,
 * so parallel runs are safe.
 */
@Execution(ExecutionMode.CONCURRENT)
class LitegresParallelTest {

    @RegisterExtension
    static LitegresExtension postgres = LitegresExtension.empty();

    @Test
    void parallelWorkerOne(LitegresDatabase db) throws Exception {
        try (Connection conn = open(db); Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE worker_one (id int)");
            st.execute("INSERT INTO worker_one VALUES (1)");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM worker_one")) {
                rs.next();
                assertEquals(1, rs.getInt(1));
            }
            Thread.sleep(50);
        }
    }

    @Test
    void parallelWorkerTwo(LitegresDatabase db) throws Exception {
        try (Connection conn = open(db); Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT to_regclass('worker_one')")) {
                rs.next();
                assertEquals(null, rs.getString(1));
            }
            st.execute("CREATE TABLE worker_two (x text)");
            st.execute("INSERT INTO worker_two VALUES ('hello')");
            Thread.sleep(50);
        }
    }

    @Test
    void parallelWorkerThree(LitegresDatabase db) throws Exception {
        try (Connection conn = open(db); Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT to_regclass('worker_one'), to_regclass('worker_two')")) {
                rs.next();
                assertEquals(null, rs.getString(1));
                assertEquals(null, rs.getString(2));
            }
        }
    }

    private static Connection open(LitegresDatabase db) throws Exception {
        return java.sql.DriverManager.getConnection(db.jdbcUrl(), db.username(), db.password());
    }
}
