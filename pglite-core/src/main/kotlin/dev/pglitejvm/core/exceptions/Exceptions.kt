package dev.pglitejvm.core.exceptions

import java.time.Duration

/** Base type for all exceptions raised by pglite-jvm. */
open class PGliteException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/**
 * No usable PGlite runtime (Bun executable or compiled standalone executable)
 * could be found. [checkedLocations] lists every discovery step that was tried,
 * in order, for inclusion in the exception message.
 */
class PGliteRuntimeNotFoundException(checkedLocations: List<String>) : PGliteException(
    buildString {
        append("Could not locate a PGlite runtime (Bun executable or compiled standalone executable).\n")
        append("pglite-jvm's development-mode runtime requires Bun — install it from https://bun.sh ")
        append("(curl -fsSL https://bun.sh/install | bash), or point at one directly.\n")
        append("Checked, in order:\n")
        checkedLocations.forEach { append(" - $it\n") }
        append("Configure one of: PGliteDatabase.builder().withBunExecutable(path), ")
        append(".withRuntimeExecutable(path), .useBundledRuntime(), ")
        append("or set the PGLITE_JVM_BUN_PATH / PGLITE_JVM_RUNTIME_PATH environment variables.")
    },
)

/** The runtime process failed to start or reported a startup error. */
class PGliteStartupException(
    message: String,
    command: List<String>? = null,
    recentStderr: List<String> = emptyList(),
    startupTimeout: Duration? = null,
    runtimeStack: String? = null,
    cause: Throwable? = null,
) : PGliteException(buildDiagnosticMessage(message, command, recentStderr, startupTimeout, runtimeStack), cause)

/** The runtime reported readiness, but its control message was malformed or unusable. */
class PGliteReadinessException(
    message: String,
    command: List<String>? = null,
    recentStderr: List<String> = emptyList(),
    cause: Throwable? = null,
) : PGliteException(buildDiagnosticMessage(message, command, recentStderr), cause)

/** The runtime process exited before it ever reported readiness. */
class PGliteProcessExitedException(
    message: String,
    command: List<String>? = null,
    val exitCode: Int? = null,
    recentStderr: List<String> = emptyList(),
    cause: Throwable? = null,
) : PGliteException(
    buildDiagnosticMessage("$message (exit code: ${exitCode ?: "unknown"})", command, recentStderr),
    cause,
)

/** An init script or custom initializer failed while bootstrapping the database. */
class PGliteInitializationException(
    message: String,
    val scriptIdentity: String,
    cause: Throwable,
) : PGliteException("$message [script: $scriptIdentity]", cause)
