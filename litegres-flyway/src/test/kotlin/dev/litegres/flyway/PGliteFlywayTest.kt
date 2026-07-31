package dev.litegres.flyway

import dev.litegres.core.PGliteDatabase
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.sql.DriverManager

class PGliteFlywayTest {

    @Test
    fun `flyway migrations run against PGlite through the standard JDBC driver`() {
        PGliteDatabase.builder()
            .withInitializer(PGliteFlyway.migrate())
            .build()
            .use { database ->
                database.start()

                DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
                    connection.createStatement().use { statement ->
                        statement.executeQuery(
                            "select name, email from accounts where id = 1",
                        ).use { rs ->
                            assertTrue(rs.next())
                            assertEquals("Ada Lovelace", rs.getString("name"))
                            assertEquals("ada@example.com", rs.getString("email"))
                        }

                        statement.executeQuery(
                            "select count(*) from flyway_schema_history where success = true",
                        ).use { rs ->
                            rs.next()
                            assertEquals(2, rs.getInt(1))
                        }
                    }
                }
            }
    }
}
