package dev.litegres.integration

import dev.litegres.junit5.PGliteExtension
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import java.sql.DriverManager

/** A hand-rolled repository over plain `java.sql` — the "no framework at all" integration path. */
private class AccountRepository(private val jdbcUrl: String, private val username: String, private val password: String) {

    fun create(name: String): Long {
        DriverManager.getConnection(jdbcUrl, username, password).use { conn ->
            conn.prepareStatement("insert into accounts (name) values (?) returning id").use { ps ->
                ps.setString(1, name)
                ps.executeQuery().use { rs ->
                    rs.next()
                    return rs.getLong(1)
                }
            }
        }
    }

    fun deposit(id: Long, amountCents: Long) {
        DriverManager.getConnection(jdbcUrl, username, password).use { conn ->
            conn.prepareStatement("update accounts set balance_cents = balance_cents + ? where id = ?").use { ps ->
                ps.setLong(1, amountCents)
                ps.setLong(2, id)
                ps.executeUpdate()
            }
        }
    }

    fun balanceOf(id: Long): Long {
        DriverManager.getConnection(jdbcUrl, username, password).use { conn ->
            conn.prepareStatement("select balance_cents from accounts where id = ?").use { ps ->
                ps.setLong(1, id)
                ps.executeQuery().use { rs ->
                    rs.next()
                    return rs.getLong(1)
                }
            }
        }
    }
}

class PlainJdbcRepositoryTest {

    companion object {
        @JvmField
        @RegisterExtension
        val database = PGliteExtension.builder()
            .withInitScript("classpath:schema.sql")
            .build()
    }

    @Test
    fun `repository create, deposit and read round-trip through plain JDBC`() {
        val repository = AccountRepository(database.jdbcUrl, database.username, database.password)

        val id = repository.create("Ada")
        repository.deposit(id, 500)
        repository.deposit(id, 250)

        assertEquals(750L, repository.balanceOf(id))
    }
}
