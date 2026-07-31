package dev.pglitejvm.core.process

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/** Mirrors the `{"type":"ready",...}` message the runtime writes to stdout. */
@JsonIgnoreProperties(ignoreUnknown = true)
internal data class ReadyMessage(
    val host: String,
    val port: Int,
    val database: String,
    val username: String,
    val password: String,
    val pgliteVersion: String?,
    val postgresVersion: String?,
)

/** Mirrors the `{"type":"error",...}` message the runtime writes to stdout. */
@JsonIgnoreProperties(ignoreUnknown = true)
internal data class ErrorControlMessage(
    val message: String,
    val stack: String?,
)
