package dev.litegres.junit5

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import java.sql.DriverManager

class PGliteExtensionPerTestTest {

    @JvmField
    @RegisterExtension
    val database = PGliteExtension.builder()
        .lifecycle(PGliteLifecycle.PER_TEST)
        .withInitSql("create table t (id int);")
        .build()

    @Test
    fun `first test gets a fresh empty database`() {
        DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
            connection.createStatement().use { statement ->
                statement.execute("insert into t values (1)")
            }
        }
    }

    @Test
    fun `second test gets its own fresh database, not sharing state with the first`() {
        DriverManager.getConnection(database.jdbcUrl, database.username, database.password).use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery("select count(*) from t").use { rs ->
                    rs.next()
                    assertEquals(0, rs.getInt(1))
                }
            }
        }
    }
}
