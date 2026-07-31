package dev.pglitejvm.core.exceptions

import java.time.Duration

/**
 * PGlite runtime config is passed as a single JSON argv entry that includes the
 * configured password; this pattern lets us redact it before the command ever
 * appears in an exception message or log line.
 */
private val PASSWORD_JSON_PATTERN = Regex(""""password"\s*:\s*"(?:[^"\\]|\\.)*"""")

internal fun redactCommandForDisplay(command: List<String>): List<String> =
    command.map { arg -> PASSWORD_JSON_PATTERN.replace(arg, "\"password\":\"***\"") }

internal fun buildDiagnosticMessage(
    message: String,
    command: List<String>? = null,
    recentStderr: List<String> = emptyList(),
    startupTimeout: Duration? = null,
    runtimeStack: String? = null,
): String = buildString {
    append(message)
    command?.let {
        append("\nCommand: ")
        append(redactCommandForDisplay(it).joinToString(" "))
    }
    startupTimeout?.let {
        append("\nStartup timeout: ")
        append(it)
    }
    if (recentStderr.isNotEmpty()) {
        append("\nRecent runtime stderr output:")
        recentStderr.forEach {
            append("\n  ")
            append(it)
        }
    }
    runtimeStack?.let {
        append("\nRuntime stack trace:\n")
        append(it)
    }
}
