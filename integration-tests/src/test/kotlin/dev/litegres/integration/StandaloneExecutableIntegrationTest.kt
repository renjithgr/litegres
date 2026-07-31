package dev.litegres.integration

import dev.litegres.core.PGliteDatabase
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.sql.DriverManager

/**
 * Proves the `bun build --compile` standalone executable mode works end to
 * end: [PGliteDatabase.builder]'s `.useBundledRuntime()` extracts the
 * host-platform executable and its PGlite WASM/data assets from this
 * library's own classpath resources into a fresh private temp directory
 * (a new one per [dev.litegres.core.runtime.RuntimeResources] extraction —
 * never the project's working directory), then runs it directly with no Bun
 * installation required. This is the scenario documented in the README as
 * "packaging mode 2 (bundled executable)" and is the trickiest part of the
 * whole project to get right, since PGlite normally resolves its WASM/data
 * assets relative to its own module location, which does not survive being
 * bundled into a single compiled binary.
 */
class StandaloneExecutableIntegrationTest {

    @Test
    fun `bundled standalone executable starts, serves PGlite, and accepts a JDBC connection`() {
        PGliteDatabase.builder()
            .useBundledRuntime()
            .build()
            .use { database ->
                database.start()

                assertTrue(database.port > 0)
                assertEquals("127.0.0.1", database.host)
                assertTrue(database.postgresVersion?.contains("PostgreSQL") == true)

                DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { conn ->
                    conn.createStatement().use { statement ->
                        statement.executeQuery("select 1").use { rs ->
                            assertTrue(rs.next())
                            assertEquals(1, rs.getInt(1))
                        }
                    }
                }
            }
    }
}
