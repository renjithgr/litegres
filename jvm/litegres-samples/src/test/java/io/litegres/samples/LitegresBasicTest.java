package io.litegres.samples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

import io.litegres.junit5.LitegresDatabase;
import io.litegres.junit5.LitegresExtension;

/**
 * The basics: every test method gets its own disposable database, injected
 * either as {@link LitegresDatabase} (connection details) or as a live
 * {@link Connection}.
 */
class LitegresBasicTest {

    @RegisterExtension
    static LitegresExtension postgres = LitegresExtension.empty();

    @Test
    void createsAndQueriesItsOwnTable(LitegresDatabase db) throws Exception {
        try (Connection conn = jdbc(db); Statement st = conn.createStatement()) {
            st.execute("CREATE TABLE accounts (id bigint primary key, name text not null)");
            st.execute("INSERT INTO accounts VALUES (1, 'alice'), (2, 'bob')");

            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM accounts")) {
                rs.next();
                assertEquals(2, rs.getInt(1));
            }
        }
    }

    @Test
    void getsAFreshDatabasePerTest(LitegresDatabase db) throws Exception {
        try (Connection conn = jdbc(db); Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT to_regclass('accounts')")) {
                rs.next();
                // the table created by the previous test must not exist here
                assertEquals(null, rs.getString(1));
            }
            st.execute("CREATE TABLE accounts (id int)");
            st.execute("INSERT INTO accounts VALUES (42)");
        }
    }

    @Test
    void connectionParameterIsAutoClosed(Connection conn) throws Exception {
        // the extension opened this connection and will close it after the test
        try (Statement st = conn.createStatement();
                ResultSet rs = st.executeQuery("SELECT 1")) {
            rs.next();
            assertEquals(1, rs.getInt(1));
        }
    }

    private static Connection jdbc(LitegresDatabase db) throws Exception {
        return java.sql.DriverManager.getConnection(db.jdbcUrl(), db.username(), db.password());
    }
}
