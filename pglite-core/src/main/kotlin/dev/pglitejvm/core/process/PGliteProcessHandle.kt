package dev.pglitejvm.core.process

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import dev.pglitejvm.core.exceptions.PGliteProcessExitedException
import dev.pglitejvm.core.exceptions.PGliteReadinessException
import dev.pglitejvm.core.exceptions.PGliteStartupException
import org.slf4j.LoggerFactory
import java.io.IOException
import java.time.Duration
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Owns one PGlite runtime child process: launches it, drains stderr
 * continuously (so the child never blocks on a full pipe buffer), reads the
 * single JSON readiness line from stdout, and manages graceful/forced shutdown.
 */
internal class PGliteProcessHandle private constructor(
    private val process: Process,
    private val command: List<String>,
    private val stderrBuffer: BoundedLogBuffer,
    private val ioExecutor: java.util.concurrent.ExecutorService,
) {

    fun awaitReady(timeout: Duration): ReadyMessage {
        val future = ioExecutor.submit(
            Callable {
                process.inputStream.bufferedReader().readLine()
                    ?: throw IOException("Runtime process closed stdout before writing a ready message")
            },
        )

        val line = try {
            future.get(timeout.toMillis(), TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            future.cancel(true)
            destroyForcibly()
            throw PGliteStartupException(
                message = "PGlite runtime did not report readiness within the startup timeout",
                command = command,
                recentStderr = stderrBuffer.snapshot(),
                startupTimeout = timeout,
                cause = e,
            )
        } catch (e: ExecutionException) {
            val exitCode = waitForExitOrNull(Duration.ofSeconds(2))
            throw PGliteProcessExitedException(
                message = "PGlite runtime process exited before reporting readiness",
                command = command,
                exitCode = exitCode,
                recentStderr = stderrBuffer.snapshot(),
                cause = e.cause ?: e,
            )
        }

        val node = try {
            OBJECT_MAPPER.readTree(line)
        } catch (e: Exception) {
            destroyForcibly()
            throw PGliteReadinessException(
                message = "Malformed control message from PGlite runtime: $line",
                command = command,
                recentStderr = stderrBuffer.snapshot(),
                cause = e,
            )
        }

        return when (val type = node.path("type").asText(null)) {
            "ready" -> OBJECT_MAPPER.treeToValue(node, ReadyMessage::class.java)
            "error" -> {
                val error = OBJECT_MAPPER.treeToValue(node, ErrorControlMessage::class.java)
                destroyForcibly()
                throw PGliteStartupException(
                    message = "PGlite runtime reported a startup error: ${error.message}",
                    command = command,
                    recentStderr = stderrBuffer.snapshot(),
                    runtimeStack = error.stack,
                )
            }
            else -> {
                destroyForcibly()
                throw PGliteReadinessException(
                    message = "Unrecognized control message type \"$type\" from PGlite runtime: $line",
                    command = command,
                    recentStderr = stderrBuffer.snapshot(),
                )
            }
        }
    }

    /** Graceful shutdown: request termination, wait, then force-kill if it overstays [shutdownTimeout]. */
    fun shutdown(shutdownTimeout: Duration) {
        try {
            if (!process.isAlive) return
            process.destroy()
            if (!process.waitFor(shutdownTimeout.toMillis(), TimeUnit.MILLISECONDS)) {
                LOGGER.warn("PGlite runtime did not exit within {}; forcing termination", shutdownTimeout)
                process.destroyForcibly()
                process.waitFor(2, TimeUnit.SECONDS)
            }
        } finally {
            ioExecutor.shutdownNow()
        }
    }

    fun destroyForcibly() {
        runCatching { process.destroyForcibly() }
        runCatching { ioExecutor.shutdownNow() }
    }

    private fun waitForExitOrNull(timeout: Duration): Int? =
        if (process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) process.exitValue() else null

    companion object {
        private val LOGGER = LoggerFactory.getLogger(PGliteProcessHandle::class.java)
        private val OBJECT_MAPPER = jacksonObjectMapper()

        fun start(command: List<String>): PGliteProcessHandle {
            LOGGER.debug("Starting PGlite runtime process")
            val process = try {
                ProcessBuilder(command).redirectErrorStream(false).start()
            } catch (e: IOException) {
                throw PGliteStartupException(
                    message = "Failed to launch PGlite runtime process",
                    command = command,
                    cause = e,
                )
            }

            val stderrBuffer = BoundedLogBuffer(maxLines = 200)
            val ioExecutor = Executors.newFixedThreadPool(2) { runnable ->
                Thread(runnable, "pglite-jvm-io").apply { isDaemon = true }
            }
            ioExecutor.submit { drainStderr(process, stderrBuffer) }

            return PGliteProcessHandle(process, command, stderrBuffer, ioExecutor)
        }

        private fun drainStderr(process: Process, buffer: BoundedLogBuffer) {
            try {
                process.errorStream.bufferedReader().forEachLine { line ->
                    buffer.add(line)
                    LOGGER.debug("[pglite-runtime] {}", line)
                }
            } catch (_: IOException) {
                // Stream closed as part of process shutdown; nothing to do.
            }
        }
    }
}
