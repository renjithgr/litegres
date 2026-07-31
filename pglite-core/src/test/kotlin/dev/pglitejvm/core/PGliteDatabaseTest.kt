package dev.pglitejvm.core

import dev.pglitejvm.core.exceptions.PGliteRuntimeNotFoundException
import dev.pglitejvm.core.exceptions.PGliteStartupException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Path
import java.sql.DriverManager
import java.time.Duration

class PGliteDatabaseTest {

    @Test
    fun `starts successfully and exposes a valid JDBC URL`() {
        PGliteDatabase.builder().build().use { database ->
            database.start()
            assertEquals(PGliteLifecycleState.RUNNING, database.state)
            assertTrue(database.jdbcUrl.startsWith("jdbc:postgresql://127.0.0.1:"))
            assertTrue(database.jdbcUrl.endsWith("/postgres?sslmode=disable&prepareThreshold=0"))
            assertTrue(database.port > 0)
            assertEquals("127.0.0.1", database.host)
        }
    }

    @Test
    fun `accepts a JDBC connection and SELECT 1 succeeds`() {
        PGliteDatabase.builder().build().use { database ->
            database.start()
            DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT 1").use { rs ->
                        assertTrue(rs.next())
                        assertEquals(1, rs.getInt(1))
                    }
                }
            }
        }
    }

    @Test
    fun `reports pglite and postgres versions once running`() {
        PGliteDatabase.builder().build().use { database ->
            database.start()
            assertTrue(database.pgliteVersion?.isNotBlank() == true)
            assertTrue(database.postgresVersion?.contains("PostgreSQL") == true)
        }
    }

    @Test
    fun `multiple calls to start are safe and idempotent`() {
        PGliteDatabase.builder().build().use { database ->
            database.start()
            val firstPort = database.port
            database.start()
            database.start()
            assertEquals(firstPort, database.port)
            assertEquals(PGliteLifecycleState.RUNNING, database.state)
        }
    }

    @Test
    fun `multiple calls to close are safe`() {
        val database = PGliteDatabase.builder().build()
        database.start()
        database.close()
        database.close()
        database.close()
        assertEquals(PGliteLifecycleState.STOPPED, database.state)
        assertFalse(database.isRunning())
    }

    @Test
    fun `close is safe even if start was never called`() {
        val database = PGliteDatabase.builder().build()
        database.close()
        assertEquals(PGliteLifecycleState.STOPPED, database.state)
    }

    @Test
    fun `accessing host and port before start throws a clear error`() {
        val database = PGliteDatabase.builder().build()
        assertThrows(IllegalStateException::class.java) { database.host }
        assertThrows(IllegalStateException::class.java) { database.port }
        assertThrows(IllegalStateException::class.java) { database.jdbcUrl }
    }

    @Test
    fun `custom database name, username and password are honored`() {
        PGliteDatabase.builder()
            .databaseName("appdb")
            .username("appuser")
            .password("secret")
            .build()
            .use { database ->
                database.start()
                assertEquals("appdb", database.databaseName)
                assertEquals("appuser", database.username)
                DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
                    connection.createStatement().use { it.execute("SELECT 1") }
                }
            }
    }

    @Test
    fun `init scripts run before start returns, in order`() {
        PGliteDatabase.builder()
            .withInitSql("create table t (id int);")
            .withInitSql("insert into t values (1), (2);")
            .build()
            .use { database ->
                database.start()
                DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
                    connection.createStatement().use { statement ->
                        statement.executeQuery("select count(*) from t").use { rs ->
                            rs.next()
                            assertEquals(2, rs.getInt(1))
                        }
                    }
                }
            }
    }

    @Test
    fun `a failing init script stops the database and reports the script identity`() {
        val database = PGliteDatabase.builder()
            .withInitSql("this is not valid sql;")
            .build()
        val exception = assertThrows(dev.pglitejvm.core.exceptions.PGliteInitializationException::class.java) {
            database.start()
        }
        assertTrue(exception.message?.contains("inline SQL") == true)
        assertEquals(PGliteLifecycleState.FAILED, database.state)
    }

    @Test
    fun `startup timeout kills the process and reports diagnostics`() {
        val database = PGliteDatabase.builder()
            .startupTimeout(Duration.ofMillis(1))
            .build()
        val exception = assertThrows(PGliteStartupException::class.java) { database.start() }
        assertTrue(exception.message?.contains("startup timeout", ignoreCase = true) == true)
        assertEquals(PGliteLifecycleState.FAILED, database.state)
    }

    @Test
    fun `an unknown explicit bun executable produces a runtime-not-found exception`() {
        val database = PGliteDatabase.builder()
            .withBunExecutable(Path.of("/does/not/exist/bun"))
            .build()
        assertThrows(PGliteRuntimeNotFoundException::class.java) { database.start() }
    }

    @Test
    fun `configuring conflicting runtime options fails fast at build time`() {
        assertThrows(IllegalArgumentException::class.java) {
            PGliteDatabase.builder()
                .withBunExecutable(Path.of("/usr/bin/bun"))
                .useBundledRuntime()
                .build()
        }
    }

    @Test
    fun `restarting after close throws`() {
        val database = PGliteDatabase.builder().build()
        database.start()
        database.close()
        assertThrows(IllegalStateException::class.java) { database.start() }
    }
}
