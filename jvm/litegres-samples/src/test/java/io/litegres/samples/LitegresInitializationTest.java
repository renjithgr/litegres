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
 * Initialization statements run before the database is exposed, so the
 * schema is ready when the test starts.
 */
class LitegresInitializationTest {

    @RegisterExtension
    static LitegresExtension postgres = LitegresExtension.withStatements(
            "CREATE TABLE accounts (id bigint primary key, name text not null)",
            "CREATE TABLE journal_entries (id bigserial primary key, account_id bigint, amount numeric)",
            "INSERT INTO accounts VALUES (1, 'seed')");

    @Test
    void schemaAndSeedDataArePresent(LitegresDatabase db) throws Exception {
        try (Connection conn = Driver(db); Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM accounts")) {
                rs.next();
                assertEquals(1, rs.getInt(1));
            }
            try (ResultSet rs = st.executeQuery("SELECT to_regclass('journal_entries')")) {
                rs.next();
                assertEquals("journal_entries", rs.getString(1));
            }
        }
    }

    private static Connection Driver(LitegresDatabase db) throws Exception {
        return java.sql.DriverManager.getConnection(db.jdbcUrl(), db.username(), db.password());
    }
}
