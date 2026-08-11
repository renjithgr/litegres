package io.litegres.samples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;

import javax.sql.DataSource;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;

import io.litegres.junit5.LitegresDatabase;
import io.litegres.junit5.LitegresExtension;

/**
 * Spring Boot integration pattern: wire the database's JDBC URL into
 * {@code System} properties exactly as a test would for
 * {@code spring.datasource.url}, then build a pooling {@link DataSource}
 * from those properties. This is the same shape a real Spring context
 * would consume.
 */
class LitegresDataSourceTest {

    @RegisterExtension
    static LitegresExtension postgres = LitegresExtension.empty();

    @Test
    void dataSourceFromSystemProperties(LitegresDatabase db) throws Exception {
        // mimic what a Spring Boot test helper would do
        System.setProperty("spring.datasource.url", db.jdbcUrl());
        System.setProperty("spring.datasource.username", db.username());
        System.setProperty("spring.datasource.password", db.password());

        try (HikariDataSource dataSource = new HikariDataSource(hikariConfig())) {
            try (Connection conn = dataSource.getConnection(); Statement st = conn.createStatement()) {
                st.execute("CREATE TABLE items (id int primary key, label text)");
                st.execute("INSERT INTO items VALUES (1, 'first')");
                try (ResultSet rs = st.executeQuery("SELECT label FROM items WHERE id = 1")) {
                    rs.next();
                    assertEquals("first", rs.getString(1));
                }
            }
        } finally {
            System.clearProperty("spring.datasource.url");
            System.clearProperty("spring.datasource.username");
            System.clearProperty("spring.datasource.password");
        }
    }

    private static HikariConfig hikariConfig() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(System.getProperty("spring.datasource.url"));
        config.setUsername(System.getProperty("spring.datasource.username"));
        config.setPassword(System.getProperty("spring.datasource.password"));
        config.setMaximumPoolSize(4);
        return config;
    }
}
