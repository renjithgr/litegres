package dev.pglitejvm.core

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import dev.pglitejvm.core.exceptions.PGliteInitializationException
import dev.pglitejvm.core.exceptions.PGliteReadinessException
import dev.pglitejvm.core.init.SqlScriptRunner
import dev.pglitejvm.core.process.PGliteProcessHandle
import dev.pglitejvm.core.process.ReadyMessage
import dev.pglitejvm.core.runtime.ExtractedRuntime
import dev.pglitejvm.core.runtime.PGliteRuntime
import dev.pglitejvm.core.runtime.RuntimeDiscovery
import dev.pglitejvm.core.runtime.RuntimeResources
import org.slf4j.LoggerFactory
import java.sql.DriverManager
import java.sql.SQLException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class PGliteDatabaseImpl(private val configuration: PGliteConfiguration) : PGliteDatabase {

    private val logger = LoggerFactory.getLogger(PGliteDatabase::class.java)
    private val lock = ReentrantLock()

    @Volatile
    private var currentState = PGliteLifecycleState.NEW

    private var processHandle: PGliteProcessHandle? = null
    private var extractedRuntime: ExtractedRuntime? = null
    private var shutdownHook: Thread? = null

    private var resolvedHost: String? = null
    private var resolvedPort: Int? = null
    private var resolvedPgliteVersion: String? = null
    private var resolvedPostgresVersion: String? = null

    override val state: PGliteLifecycleState get() = currentState

    override val databaseName: String get() = configuration.databaseName
    override val username: String get() = configuration.username
    override val password: String get() = configuration.password
    override val pgliteVersion: String? get() = resolvedPgliteVersion
    override val postgresVersion: String? get() = resolvedPostgresVersion

    override val host: String
        get() = resolvedHost ?: error("PGliteDatabase has not been started yet; call start() first")

    override val port: Int
        get() = resolvedPort ?: error("PGliteDatabase has not been started yet; call start() first")

    override val jdbcUrl: String
        // prepareThreshold=0 disables the driver's server-side prepared statements.
        // PGlite runs Postgres in single-user mode: every socket connection shares
        // ONE real backend session, so server-side statement names ("S_1", "S_2", ...)
        // are not connection-private the way they are on real PostgreSQL — a second,
        // unrelated JDBC Connection can collide with a name a prior connection never
        // got to deallocate, failing with "prepared statement \"S_1\" already exists".
        // This mirrors the standard advice for PgBouncer transaction-pooling mode,
        // for the same underlying reason (statements aren't private to one session).
        get() = "jdbc:postgresql://$host:$port/$databaseName?sslmode=disable&prepareThreshold=0"

    override fun isRunning(): Boolean = currentState == PGliteLifecycleState.RUNNING

    override fun start() {
        lock.withLock {
            when (currentState) {
                PGliteLifecycleState.RUNNING -> return
                PGliteLifecycleState.STOPPING, PGliteLifecycleState.STOPPED ->
                    throw IllegalStateException("PGliteDatabase cannot be restarted after close(); create a new instance")
                PGliteLifecycleState.FAILED ->
                    throw IllegalStateException("PGliteDatabase previously failed to start; create a new instance")
                PGliteLifecycleState.STARTING, PGliteLifecycleState.NEW -> Unit
            }

            currentState = PGliteLifecycleState.STARTING
            try {
                doStart()
                currentState = PGliteLifecycleState.RUNNING
                registerShutdownHook()
                logger.info("PGlite database started: {}", jdbcUrl)
            } catch (e: Exception) {
                currentState = PGliteLifecycleState.FAILED
                cleanupQuietly()
                throw e
            }
        }
    }

    override fun close() {
        lock.withLock {
            when (currentState) {
                PGliteLifecycleState.NEW -> {
                    currentState = PGliteLifecycleState.STOPPED
                    return
                }
                PGliteLifecycleState.STOPPED, PGliteLifecycleState.STOPPING -> return
                else -> Unit
            }

            currentState = PGliteLifecycleState.STOPPING
            deregisterShutdownHook()
            cleanupQuietly()
            currentState = PGliteLifecycleState.STOPPED
            logger.info("PGlite database stopped")
        }
    }

    private class LaunchPreparation(val command: List<String>, val assetsDir: String?, val cleanup: ExtractedRuntime?)

    private fun prepareLaunch(runtime: PGliteRuntime): LaunchPreparation = when (runtime) {
        is PGliteRuntime.Bun -> {
            val extracted = RuntimeResources.extractDevBundle()
            LaunchPreparation(
                command = listOf(runtime.executable.toString(), extracted.entrypoint.toString()),
                assetsDir = extracted.directory.toString(),
                cleanup = extracted,
            )
        }
        is PGliteRuntime.StandaloneBundled -> {
            val extracted = RuntimeResources.extractStandalone(runtime.platformId)
            LaunchPreparation(
                command = listOf(extracted.entrypoint.toString()),
                assetsDir = extracted.directory.toString(),
                cleanup = extracted,
            )
        }
        is PGliteRuntime.StandaloneExternal -> LaunchPreparation(
            command = listOf(runtime.executable.toString()),
            assetsDir = null,
            cleanup = null,
        )
    }

    private fun doStart() {
        val runtime = RuntimeDiscovery.resolve(configuration.runtimeSelection)
        val launch = prepareLaunch(runtime)
        extractedRuntime = launch.cleanup

        val configJson = buildRuntimeConfigJson(launch.assetsDir)
        val command = launch.command + configJson

        val handle = PGliteProcessHandle.start(command)
        processHandle = handle

        val ready: ReadyMessage = handle.awaitReady(configuration.startupTimeout)

        resolvedHost = ready.host
        resolvedPort = ready.port
        resolvedPgliteVersion = ready.pgliteVersion
        resolvedPostgresVersion = ready.postgresVersion

        verifyJdbcConnection()
        runInitializers()
    }

    private fun buildRuntimeConfigJson(assetsDir: String?): String {
        val payload = linkedMapOf<String, Any?>(
            "port" to 0,
            "database" to configuration.databaseName,
            "username" to configuration.username,
            "password" to configuration.password,
            "startupTimeoutMs" to configuration.startupTimeout.toMillis(),
        )
        configuration.dataDir?.let { payload["dataDir"] = it.toString() }
        assetsDir?.let { payload["assetsDir"] = it }
        return OBJECT_MAPPER.writeValueAsString(payload)
    }

    private fun verifyJdbcConnection() {
        try {
            DriverManager.getConnection(jdbcUrl, username, password).use { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery("SELECT 1").use { resultSet ->
                        check(resultSet.next() && resultSet.getInt(1) == 1) {
                            "SELECT 1 did not return the expected result"
                        }
                    }
                }
            }
        } catch (e: SQLException) {
            throw PGliteReadinessException(
                message = "Failed to verify JDBC connectivity to $jdbcUrl after the runtime reported readiness",
                cause = e,
            )
        }
    }

    private fun runInitializers() {
        for (script in configuration.initScripts) {
            try {
                DriverManager.getConnection(jdbcUrl, username, password).use { connection ->
                    SqlScriptRunner.run(connection, script)
                }
            } catch (e: Exception) {
                throw PGliteInitializationException(
                    message = "Failed to execute init script",
                    scriptIdentity = script.identity,
                    cause = e,
                )
            }
        }

        configuration.customInitializer?.let { initializer ->
            try {
                initializer.initialize(PGliteConnectionInfo(jdbcUrl, host, port, databaseName, username, password))
            } catch (e: Exception) {
                throw PGliteInitializationException(
                    message = "Custom initializer failed",
                    scriptIdentity = "custom initializer",
                    cause = e,
                )
            }
        }
    }

    private fun cleanupQuietly() {
        processHandle?.let { runCatching { it.shutdown(configuration.shutdownTimeout) } }
        extractedRuntime?.let { runCatching { it.close() } }
    }

    private fun registerShutdownHook() {
        val hook = Thread({ cleanupQuietly() }, "pglite-jvm-shutdown-hook")
        shutdownHook = hook
        runCatching { Runtime.getRuntime().addShutdownHook(hook) }
    }

    private fun deregisterShutdownHook() {
        shutdownHook?.let { hook ->
            runCatching { Runtime.getRuntime().removeShutdownHook(hook) }
            shutdownHook = null
        }
    }

    companion object {
        private val OBJECT_MAPPER = jacksonObjectMapper()
    }
}
