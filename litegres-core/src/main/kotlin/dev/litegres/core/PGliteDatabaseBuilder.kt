package dev.litegres.core

import dev.litegres.core.init.InitScript
import dev.litegres.core.runtime.RuntimeSelection
import java.nio.file.Path
import java.time.Duration

/**
 * Builds a [PGliteDatabase]. Not started automatically — call [PGliteDatabase.start]
 * (or use the JUnit 5 / Spring helper modules, which do it for you).
 */
class PGliteDatabaseBuilder internal constructor() {

    private var databaseName = "postgres"
    private var username = "postgres"
    private var password = "postgres"
    private var dataDir: Path? = null
    private var startupTimeout: Duration = Duration.ofSeconds(15)
    private var shutdownTimeout: Duration = Duration.ofSeconds(5)
    private val initScripts = mutableListOf<InitScript>()
    private var customInitializer: PGliteInitializer? = null

    private var bunExecutable: Path? = null
    private var runtimeExecutable: Path? = null
    private var useBundledRuntime = false

    fun databaseName(name: String): PGliteDatabaseBuilder = apply {
        require(name.isNotBlank()) { "databaseName must not be blank" }
        databaseName = name
    }

    fun username(username: String): PGliteDatabaseBuilder = apply {
        require(username.isNotBlank()) { "username must not be blank" }
        this.username = username
    }

    fun password(password: String): PGliteDatabaseBuilder = apply {
        this.password = password
    }

    /** Persists the database to this directory instead of using an in-memory instance. */
    fun dataDir(path: Path): PGliteDatabaseBuilder = apply {
        dataDir = path
    }

    fun dataDir(path: String): PGliteDatabaseBuilder = dataDir(Path.of(path))

    fun startupTimeout(duration: Duration): PGliteDatabaseBuilder = apply {
        require(!duration.isNegative && !duration.isZero) { "startupTimeout must be positive" }
        startupTimeout = duration
    }

    fun shutdownTimeout(duration: Duration): PGliteDatabaseBuilder = apply {
        require(!duration.isNegative && !duration.isZero) { "shutdownTimeout must be positive" }
        shutdownTimeout = duration
    }

    /** `"classpath:foo.sql"` for a classpath resource, or a filesystem path otherwise. Runs in call order. */
    fun withInitScript(location: String): PGliteDatabaseBuilder = apply {
        initScripts += InitScript.fromLocation(location)
    }

    /** Runs this raw SQL directly; runs in call order alongside any [withInitScript] calls. */
    fun withInitSql(sql: String): PGliteDatabaseBuilder = apply {
        initScripts += InitScript.RawSql(sql)
    }

    /**
     * Registers a custom post-startup initializer (e.g. Flyway migrations), run
     * after init scripts and after JDBC connectivity has been verified.
     */
    fun withInitializer(initializer: PGliteInitializer): PGliteDatabaseBuilder = apply {
        customInitializer = initializer
    }

    /** Use this specific `bun` executable instead of discovering one. */
    fun withBunExecutable(path: Path): PGliteDatabaseBuilder = apply {
        bunExecutable = path
    }

    fun withBunExecutable(path: String): PGliteDatabaseBuilder = withBunExecutable(Path.of(path))

    /** Use this specific compiled standalone runtime executable instead of discovering one. */
    fun withRuntimeExecutable(path: Path): PGliteDatabaseBuilder = apply {
        runtimeExecutable = path
    }

    fun withRuntimeExecutable(path: String): PGliteDatabaseBuilder = withRuntimeExecutable(Path.of(path))

    /** Use this library's own bundled standalone executable for the current platform. */
    fun useBundledRuntime(): PGliteDatabaseBuilder = apply {
        useBundledRuntime = true
    }

    fun build(): PGliteDatabase {
        val explicitSelections = listOfNotNull(
            bunExecutable?.let { "withBunExecutable" },
            runtimeExecutable?.let { "withRuntimeExecutable" },
            if (useBundledRuntime) "useBundledRuntime" else null,
        )
        require(explicitSelections.size <= 1) {
            "Configure at most one of ${explicitSelections.joinToString(", ")} — they are mutually exclusive"
        }

        val runtimeSelection = when {
            runtimeExecutable != null -> RuntimeSelection.ExplicitStandalone(runtimeExecutable!!)
            bunExecutable != null -> RuntimeSelection.ExplicitBun(bunExecutable!!)
            useBundledRuntime -> RuntimeSelection.UseBundled
            else -> RuntimeSelection.Auto
        }

        val configuration = PGliteConfiguration(
            databaseName = databaseName,
            username = username,
            password = password,
            dataDir = dataDir,
            startupTimeout = startupTimeout,
            shutdownTimeout = shutdownTimeout,
            initScripts = initScripts.toList(),
            customInitializer = customInitializer,
            runtimeSelection = runtimeSelection,
        )

        return PGliteDatabaseImpl(configuration)
    }
}
