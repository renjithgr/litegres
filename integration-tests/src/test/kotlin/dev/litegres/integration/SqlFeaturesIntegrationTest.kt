package dev.litegres.integration

import dev.litegres.junit5.PGliteExtension
import dev.litegres.junit5.PGliteLifecycle
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import org.postgresql.PGConnection
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException

/**
 * Exercises representative PostgreSQL SQL features against a real PGlite
 * instance through the standard JDBC driver. Where PGlite/pglite-socket has a
 * genuine limitation, the test asserts and documents that behavior explicitly
 * rather than skipping it silently.
 *
 * Each test method gets its own fresh [PGliteExtension] instance
 * ([PGliteLifecycle.PER_TEST]) rather than sharing one class-wide database:
 * PGlite runs Postgres in single-user mode, so every socket connection shares
 * one real backend session — table names, transaction/abort state, and
 * server-side prepared statements are NOT isolated per test the way separate
 * PostgreSQL backends would be. Per-test isolation avoids state bleeding
 * between unrelated test methods.
 */
class SqlFeaturesIntegrationTest {

    @JvmField
    @RegisterExtension
    val database = PGliteExtension.builder().lifecycle(PGliteLifecycle.PER_TEST).build()

    private fun connect(): Connection =
        DriverManager.getConnection(database.jdbcUrl, database.username, database.password)

    @Test
    fun `table creation, inserts, and RETURNING`() {
        connect().use { conn ->
            conn.createStatement().use { it.execute("create table widgets (id serial primary key, name text not null)") }
            conn.prepareStatement("insert into widgets (name) values (?) returning id").use { ps ->
                ps.setString(1, "sprocket")
                ps.executeQuery().use { rs ->
                    assertTrue(rs.next())
                    assertTrue(rs.getInt(1) > 0)
                }
            }
        }
    }

    @Test
    fun `transactions commit and rollback correctly`() {
        connect().use { conn ->
            conn.createStatement().use { it.execute("create table txn_test (id int primary key)") }
            conn.autoCommit = false

            conn.createStatement().use { it.execute("insert into txn_test values (1)") }
            conn.rollback()

            conn.createStatement().use { statement ->
                statement.executeQuery("select count(*) from txn_test").use { rs ->
                    rs.next()
                    assertEquals(0, rs.getInt(1))
                }
            }

            conn.createStatement().use { it.execute("insert into txn_test values (2)") }
            conn.commit()

            conn.createStatement().use { statement ->
                statement.executeQuery("select count(*) from txn_test").use { rs ->
                    rs.next()
                    assertEquals(1, rs.getInt(1))
                }
            }
        }
    }

    @Test
    fun `savepoints allow partial rollback within a transaction`() {
        connect().use { conn ->
            conn.createStatement().use { it.execute("create table savepoint_test (id int primary key)") }
            conn.autoCommit = false

            conn.createStatement().use { it.execute("insert into savepoint_test values (1)") }
            val savepoint = conn.setSavepoint("sp1")
            conn.createStatement().use { it.execute("insert into savepoint_test values (2)") }
            conn.rollback(savepoint)
            conn.commit()

            conn.createStatement().use { statement ->
                statement.executeQuery("select id from savepoint_test order by id").use { rs ->
                    assertTrue(rs.next())
                    assertEquals(1, rs.getInt(1))
                    assertFalse(rs.next())
                }
            }
        }
    }

    @Test
    fun `JSONB, arrays and enums round-trip correctly`() {
        connect().use { conn ->
            conn.createStatement().use { statement ->
                statement.execute("create type mood as enum ('happy', 'sad')")
                statement.execute(
                    "create table feelings (id int primary key, tags text[], payload jsonb, current_mood mood)",
                )
                statement.execute(
                    "insert into feelings values (1, array['a','b','c'], '{\"score\": 42}'::jsonb, 'happy')",
                )
            }
            conn.createStatement().use { statement ->
                statement.executeQuery("select tags, payload, current_mood from feelings where id = 1").use { rs ->
                    assertTrue(rs.next())
                    val tags = rs.getArray("tags").array as Array<*>
                    assertEquals(listOf("a", "b", "c"), tags.toList())
                    assertEquals("""{"score": 42}""", rs.getString("payload"))
                    assertEquals("happy", rs.getString("current_mood"))
                }
            }
        }
    }

    @Test
    fun `generated columns are computed by the server`() {
        connect().use { conn ->
            conn.createStatement().use { statement ->
                statement.execute(
                    "create table rectangles (width int, height int, area int generated always as (width * height) stored)",
                )
                statement.execute("insert into rectangles (width, height) values (3, 4)")
            }
            conn.createStatement().use { statement ->
                statement.executeQuery("select area from rectangles").use { rs ->
                    assertTrue(rs.next())
                    assertEquals(12, rs.getInt(1))
                }
            }
        }
    }

    @Test
    fun `foreign keys and unique constraints are enforced`() {
        connect().use { conn ->
            conn.createStatement().use { statement ->
                statement.execute("create table parents (id int primary key)")
                statement.execute(
                    "create table children (id int primary key, parent_id int unique references parents(id))",
                )
                statement.execute("insert into parents values (1)")
                statement.execute("insert into children values (1, 1)")
            }
        }

        // Each check below uses its OWN fresh connection. See
        // `an error on one statement can surface on a later statement's
        // response over the same connection` for why: reusing one connection
        // across a failing statement and the next one can misattribute the
        // first statement's error to the second statement's response.
        connect().use { conn ->
            assertThrows(SQLException::class.java) {
                conn.createStatement().use { it.execute("insert into children values (2, 99)") } // no such parent
            }
        }
        connect().use { conn ->
            assertThrows(SQLException::class.java) {
                conn.createStatement().use { it.execute("insert into children values (3, 1)") } // duplicate parent_id
            }
        }
    }

    /**
     * Documented limitation, found while writing this test suite: if a
     * statement fails on a connection and the very next statement on that
     * *same* connection succeeds, the driver can observe the first
     * statement's error as if it were the second statement's response — i.e.
     * the error is not always reported at the point of the failing call.
     * Reproduced independently of this library with a raw JDBC connection
     * against the runtime directly, so this is a PGlite/pglite-socket
     * wire-protocol bridging limitation, not a litegres bug. Practical
     * takeaway: don't assume "no exception from this statement" means "this
     * statement succeeded" when reusing one connection across statements that
     * might fail — check results/state, or give risky statements their own
     * connection, as the rest of this test class now does.
     */
    @Test
    fun `an error on one statement can surface on a later statement's response (documented limitation)`() {
        connect().use { conn ->
            conn.createStatement().use { statement ->
                statement.execute("create table unique_probe (id int primary key)")
                statement.execute("insert into unique_probe values (1)")
            }

            var errorOnFirstInsert: SQLException? = null
            conn.createStatement().use { statement ->
                try {
                    statement.execute("insert into unique_probe values (1)") // duplicate key: should fail
                } catch (e: SQLException) {
                    errorOnFirstInsert = e
                }
            }

            var errorOnSecondStatement: SQLException? = null
            conn.createStatement().use { statement ->
                try {
                    statement.executeQuery("select count(*) from unique_probe").use { it.next() }
                } catch (e: SQLException) {
                    errorOnSecondStatement = e
                }
            }

            assertTrue(
                errorOnFirstInsert != null || errorOnSecondStatement != null,
                "Expected the duplicate-key error to surface on either the failing statement or the next one",
            )
        }
    }

    @Test
    fun `ON CONFLICT performs an upsert`() {
        connect().use { conn ->
            conn.createStatement().use { statement ->
                statement.execute("create table counters (name text primary key, hits int not null default 0)")
            }
            repeat(3) {
                conn.createStatement().use { statement ->
                    statement.execute(
                        "insert into counters (name, hits) values ('clicks', 1) " +
                            "on conflict (name) do update set hits = counters.hits + 1",
                    )
                }
            }
            conn.createStatement().use { statement ->
                statement.executeQuery("select hits from counters where name = 'clicks'").use { rs ->
                    rs.next()
                    assertEquals(3, rs.getInt(1))
                }
            }
        }
    }

    /**
     * `SELECT ... FOR UPDATE` is accepted and executes without error, since it's
     * valid single-connection SQL. This does NOT validate real row-locking
     * concurrency semantics across two sessions — PGlite has no independent
     * concurrent backends to contend over the lock, so that guarantee cannot be
     * meaningfully tested here. See the README's compatibility limitations.
     */
    @Test
    fun `SELECT FOR UPDATE executes, without validating real cross-session locking`() {
        connect().use { conn ->
            conn.createStatement().use { it.execute("create table lockable (id int primary key, value int)") }
            conn.createStatement().use { it.execute("insert into lockable values (1, 100)") }
            conn.autoCommit = false
            conn.createStatement().use { statement ->
                statement.executeQuery("select value from lockable where id = 1 for update").use { rs ->
                    assertTrue(rs.next())
                    assertEquals(100, rs.getInt(1))
                }
            }
            conn.commit()
        }
    }

    @Test
    fun `session-level advisory locks work within a single connection`() {
        connect().use { conn ->
            conn.createStatement().use { statement ->
                statement.executeQuery("select pg_try_advisory_lock(42)").use { rs ->
                    rs.next()
                    assertTrue(rs.getBoolean(1))
                }
                statement.executeQuery("select pg_advisory_unlock(42)").use { rs ->
                    rs.next()
                    assertTrue(rs.getBoolean(1))
                }
            }
        }
    }

    /**
     * Documented limitation: pglite-socket does not deliver asynchronous
     * NOTIFY payloads to a *different* connection than the one that issued
     * NOTIFY. Real PostgreSQL pushes NotificationResponse messages to every
     * backend that LISTENs on the channel; PGlite's socket bridge does not.
     * This test asserts the (current) unsupported behavior rather than
     * silently skipping LISTEN/NOTIFY coverage.
     */
    @Test
    fun `LISTEN NOTIFY across two connections is not delivered (documented limitation)`() {
        connect().use { listenerConn ->
            listenerConn.createStatement().use { it.execute("LISTEN integration_test_channel") }

            connect().use { notifierConn ->
                notifierConn.createStatement().use { it.execute("NOTIFY integration_test_channel, 'payload'") }
            }

            Thread.sleep(300)
            val notifications = listenerConn.unwrap(PGConnection::class.java).getNotifications(1000)
            assertTrue(
                notifications == null || notifications.isEmpty(),
                "Expected no cross-connection NOTIFY delivery (documented PGlite limitation), " +
                    "but received: ${notifications?.toList()}",
            )
        }
    }

    /**
     * Documented limitation: PGlite ignores the database/username named in a
     * client's wire-protocol StartupMessage entirely — every connection lands
     * on the same internal `postgres`/`postgres` session regardless of what a
     * JDBC URL requests. See README's "Compatibility limitations".
     */
    @Test
    fun `PGlite ignores the requested database and username (documented limitation)`() {
        val url = "jdbc:postgresql://${database.host}:${database.port}/totally_made_up_db?sslmode=disable"
        DriverManager.getConnection(url, "totally_made_up_user", "irrelevant").use { conn ->
            conn.createStatement().use { statement ->
                statement.executeQuery("select current_database(), current_user").use { rs ->
                    assertTrue(rs.next())
                    assertEquals("postgres", rs.getString(1))
                    assertEquals("postgres", rs.getString(2))
                }
            }
        }
    }

    @Test
    fun `PGlite has no password authentication (documented limitation)`() {
        // The point of this test is that connecting with the WRONG password
        // still succeeds, since PGlite's socket bridge never checks it.
        DriverManager.getConnection(database.jdbcUrl, database.username, "definitely-the-wrong-password").use { conn ->
            conn.createStatement().use { statement ->
                statement.executeQuery("select 1").use { rs -> assertTrue(rs.next()) }
            }
        }
    }
}
