package dev.pglitejvm.core

/**
 * Connection details for a running [PGliteDatabase], passed to custom
 * initializers registered via [PGliteDatabaseBuilder.withInitializer].
 */
data class PGliteConnectionInfo(
    val jdbcUrl: String,
    val host: String,
    val port: Int,
    val databaseName: String,
    val username: String,
    val password: String,
)
