package dev.pglitejvm.core

import dev.pglitejvm.core.init.InitScript
import dev.pglitejvm.core.runtime.RuntimeSelection
import java.nio.file.Path
import java.time.Duration

/** Immutable, validated configuration produced by [PGliteDatabaseBuilder.build]. */
internal data class PGliteConfiguration(
    val databaseName: String,
    val username: String,
    val password: String,
    val dataDir: Path?,
    val startupTimeout: Duration,
    val shutdownTimeout: Duration,
    val initScripts: List<InitScript>,
    val customInitializer: PGliteInitializer?,
    val runtimeSelection: RuntimeSelection,
)
