package dev.pglitejvm.junit5

import dev.pglitejvm.core.PGliteDatabase
import dev.pglitejvm.core.PGliteDatabaseBuilder
import dev.pglitejvm.core.PGliteInitializer
import org.junit.jupiter.api.extension.AfterAllCallback
import org.junit.jupiter.api.extension.AfterEachCallback
import org.junit.jupiter.api.extension.BeforeAllCallback
import org.junit.jupiter.api.extension.BeforeEachCallback
import org.junit.jupiter.api.extension.ExtensionContext
import java.nio.file.Path
import java.time.Duration

/**
 * A JUnit 5 extension that starts a [PGliteDatabase] before tests and stops it
 * afterward. Register it with `@RegisterExtension` on a `companion object` field
 * (class-scoped) for [PGliteLifecycle.PER_CLASS], the default.
 *
 * ```kotlin
 * companion object {
 *     @JvmField
 *     @RegisterExtension
 *     val database = PGliteExtension.builder()
 *         .withInitScript("classpath:schema.sql")
 *         .build()
 * }
 * ```
 */
class PGliteExtension internal constructor(
    private val databaseBuilder: PGliteDatabaseBuilder,
    private val lifecycle: PGliteLifecycle,
) : BeforeAllCallback, AfterAllCallback, BeforeEachCallback, AfterEachCallback {

    @Volatile
    private var current: PGliteDatabase? = null

    val jdbcUrl: String get() = active().jdbcUrl
    val host: String get() = active().host
    val port: Int get() = active().port
    val databaseName: String get() = active().databaseName
    val username: String get() = active().username
    val password: String get() = active().password
    val pgliteVersion: String? get() = current?.pgliteVersion
    val postgresVersion: String? get() = current?.postgresVersion

    /** The underlying database, for anything not exposed directly on the extension. */
    fun database(): PGliteDatabase = active()

    private fun active(): PGliteDatabase =
        current ?: error(
            "PGliteExtension's database is not active right now " +
                "(lifecycle is $lifecycle; access it only during test execution)",
        )

    override fun beforeAll(context: ExtensionContext) {
        if (lifecycle == PGliteLifecycle.PER_CLASS) startNew()
    }

    override fun afterAll(context: ExtensionContext) {
        if (lifecycle == PGliteLifecycle.PER_CLASS) stopCurrent()
    }

    override fun beforeEach(context: ExtensionContext) {
        if (lifecycle == PGliteLifecycle.PER_TEST) startNew()
    }

    override fun afterEach(context: ExtensionContext) {
        if (lifecycle == PGliteLifecycle.PER_TEST) stopCurrent()
    }

    private fun startNew() {
        val database = databaseBuilder.build()
        database.start()
        current = database
    }

    private fun stopCurrent() {
        current?.close()
        current = null
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }

    /** Mirrors [PGliteDatabaseBuilder]'s API, plus [lifecycle]. */
    class Builder internal constructor() {
        private val delegate = PGliteDatabase.builder()
        private var lifecycle = PGliteLifecycle.PER_CLASS

        fun lifecycle(lifecycle: PGliteLifecycle): Builder = apply { this.lifecycle = lifecycle }

        fun databaseName(name: String): Builder = apply { delegate.databaseName(name) }
        fun username(username: String): Builder = apply { delegate.username(username) }
        fun password(password: String): Builder = apply { delegate.password(password) }
        fun dataDir(path: Path): Builder = apply { delegate.dataDir(path) }
        fun dataDir(path: String): Builder = apply { delegate.dataDir(path) }
        fun startupTimeout(duration: Duration): Builder = apply { delegate.startupTimeout(duration) }
        fun shutdownTimeout(duration: Duration): Builder = apply { delegate.shutdownTimeout(duration) }
        fun withInitScript(location: String): Builder = apply { delegate.withInitScript(location) }
        fun withInitSql(sql: String): Builder = apply { delegate.withInitSql(sql) }
        fun withInitializer(initializer: PGliteInitializer): Builder = apply { delegate.withInitializer(initializer) }
        fun withBunExecutable(path: Path): Builder = apply { delegate.withBunExecutable(path) }
        fun withBunExecutable(path: String): Builder = apply { delegate.withBunExecutable(path) }
        fun withRuntimeExecutable(path: Path): Builder = apply { delegate.withRuntimeExecutable(path) }
        fun withRuntimeExecutable(path: String): Builder = apply { delegate.withRuntimeExecutable(path) }
        fun useBundledRuntime(): Builder = apply { delegate.useBundledRuntime() }

        fun build(): PGliteExtension = PGliteExtension(delegate, lifecycle)
    }
}
