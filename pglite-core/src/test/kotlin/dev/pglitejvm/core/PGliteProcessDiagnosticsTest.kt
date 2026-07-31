package dev.pglitejvm.core

import dev.pglitejvm.core.exceptions.PGliteProcessExitedException
import dev.pglitejvm.core.exceptions.PGliteReadinessException
import dev.pglitejvm.core.exceptions.PGliteStartupException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

/**
 * Exercises failure paths that are impractical to trigger with a real PGlite
 * process (malformed control messages, early process exit) using tiny fake
 * "runtime" shell scripts wired in via [PGliteDatabaseBuilder.withRuntimeExecutable].
 * [PGliteDatabaseTest] covers the real-process happy and startup-timeout paths.
 */
class PGliteProcessDiagnosticsTest {

    @Test
    fun `a malformed readiness line produces a readiness exception with stderr diagnostics`() {
        val script = FakeRuntimeScripts.extract("malformed-json.sh")
        val database = PGliteDatabase.builder().withRuntimeExecutable(script).build()

        val exception = assertThrows(PGliteReadinessException::class.java) { database.start() }
        assertTrue(exception.message?.contains("Malformed control message") == true)
        assertEquals(PGliteLifecycleState.FAILED, database.state)
    }

    @Test
    fun `an early process exit before readiness produces a process-exited exception`() {
        val script = FakeRuntimeScripts.extract("early-exit.sh")
        val database = PGliteDatabase.builder().withRuntimeExecutable(script).build()

        val exception = assertThrows(PGliteProcessExitedException::class.java) { database.start() }
        assertEquals(7, exception.exitCode)
        assertEquals(PGliteLifecycleState.FAILED, database.state)
    }

    @Test
    fun `a runtime-reported error message surfaces its message and stack, and stderr is captured`() {
        val script = FakeRuntimeScripts.extract("error-message.sh")
        val database = PGliteDatabase.builder().withRuntimeExecutable(script).build()

        val exception = assertThrows(PGliteStartupException::class.java) { database.start() }
        assertTrue(exception.message?.contains("simulated fatal startup error") == true)
        assertTrue(exception.message?.contains("error-message.sh:1") == true)
        assertTrue(exception.message?.contains("diagnostic detail on stderr") == true)
    }

    @Test
    fun `shutdown hooks are removed on normal close, verified via reflection on the JVM hook table`() {
        val hookTableSizeBefore = applicationShutdownHookCount()

        repeat(3) {
            PGliteDatabase.builder().build().use { database ->
                database.start()
                // While RUNNING, exactly one hook should be registered for this instance.
                assertEquals(hookTableSizeBefore + 1, applicationShutdownHookCount())
            }
            // After close(), our hook must have been deregistered again.
            assertEquals(hookTableSizeBefore, applicationShutdownHookCount())
        }
    }

    /**
     * `java.lang.ApplicationShutdownHooks` holds the actual hook table but is
     * package-private JDK-internal API; reading its size via reflection is the
     * only way to verify hooks are removed (not just that no exception is thrown).
     */
    private fun applicationShutdownHookCount(): Int {
        val clazz = Class.forName("java.lang.ApplicationShutdownHooks")
        val field = clazz.getDeclaredField("hooks")
        field.isAccessible = true
        val hooks = field.get(null) as Map<*, *>
        return hooks.size
    }
}
