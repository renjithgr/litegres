package dev.litegres.integration

import dev.litegres.core.PGliteDatabase
import dev.litegres.flyway.PGliteFlyway
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.sql.DriverManager

/** Proves Flyway migrations run successfully against PGlite through the standard PostgreSQL JDBC driver. */
class FlywayMigrationIntegrationTest {

    @Test
    fun `flyway migrations run against PGlite and are recorded in schema history`() {
        PGliteDatabase.builder()
            .withInitializer(PGliteFlyway.migrate(listOf("classpath:db/migration")))
            .build()
            .use { database ->
                database.start()

                DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { conn ->
                    conn.createStatement().use { statement ->
                        statement.executeQuery("select sku, price_cents from products where sku = 'WIDGET-1'").use { rs ->
                            assertTrue(rs.next())
                            assertEquals("WIDGET-1", rs.getString("sku"))
                            assertEquals(1999, rs.getInt("price_cents"))
                        }

                        statement.executeQuery(
                            "select version from flyway_schema_history where success = true order by installed_rank",
                        ).use { rs ->
                            assertTrue(rs.next())
                            assertEquals("1", rs.getString(1))
                        }
                    }
                }
            }
    }
}
