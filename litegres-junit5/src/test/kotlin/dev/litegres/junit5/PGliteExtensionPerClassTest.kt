package dev.litegres.junit5

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import java.sql.DriverManager

class PGliteExtensionPerClassTest {

    companion object {
        @JvmField
        @RegisterExtension
        val database = PGliteExtension.builder()
            .withInitSql("create table accounts (id int primary key, name text);")
            .withInitSql("insert into accounts values (1, 'Ada');")
            .build()
    }

    @Test
    fun `database is running and reachable during test methods`() {
        assertTrue(database.jdbcUrl.startsWith("jdbc:postgresql://"))
        assertTrue(database.port > 0)
        assertEquals("127.0.0.1", database.host)
    }

    @Test
    fun `init scripts ran before any test method`() {
        DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery("select name from accounts where id = 1").use { rs ->
                    assertTrue(rs.next())
                    assertEquals("Ada", rs.getString(1))
                }
            }
        }
    }

    @Test
    fun `same instance is shared across test methods in the class`() {
        val portFromThisTest = database.port
        assertEquals(portFromThisTest, database.port)
    }
}
