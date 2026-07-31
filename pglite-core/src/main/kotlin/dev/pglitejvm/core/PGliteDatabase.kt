package dev.pglitejvm.core

/**
 * A PGlite-backed PostgreSQL-compatible database, reachable over the standard
 * PostgreSQL wire protocol via the normal `org.postgresql:postgresql` JDBC driver.
 *
 * PGlite is Postgres compiled to WebAssembly and run inside a Bun process — it is
 * fast and Docker-free, but it is **not** a complete substitute for native
 * PostgreSQL. See the project README for compatibility limitations before relying
 * on it for anything beyond fast local/CI integration tests.
 *
 * Instances are single-use: once [close]d (or after a failed [start]), a
 * [PGliteDatabase] cannot be restarted. Create a new instance instead.
 */
interface PGliteDatabase : AutoCloseable {

    /** Current lifecycle state; see [PGliteLifecycleState]. */
    val state: PGliteLifecycleState

    /**
     * The JDBC URL to connect with, e.g. `jdbc:postgresql://127.0.0.1:54321/postgres?sslmode=disable`.
     * Throws [IllegalStateException] if the database has not been started yet.
     */
    val jdbcUrl: String

    /** Host the runtime bound to; always `127.0.0.1`. Throws if not yet started. */
    val host: String

    /** The ephemeral (or configured) port the runtime bound to. Throws if not yet started. */
    val port: Int

    val databaseName: String
    val username: String
    val password: String

    /** PGlite's own package version, populated once [RUNNING][PGliteLifecycleState.RUNNING]. */
    val pgliteVersion: String?

    /** The `SELECT version()` output reported by PGlite, populated once running. */
    val postgresVersion: String?

    /**
     * Starts the underlying runtime process, waits for readiness, verifies JDBC
     * connectivity, and runs any configured init scripts/initializer.
     * Idempotent: calling this again while already [RUNNING][PGliteLifecycleState.RUNNING]
     * is a no-op and will not launch a second process.
     */
    fun start()

    fun isRunning(): Boolean

    /** Idempotent: safe to call multiple times, and safe even if [start] was never called. */
    override fun close()

    companion object {
        @JvmStatic
        fun builder(): PGliteDatabaseBuilder = PGliteDatabaseBuilder()
    }
}
