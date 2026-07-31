package dev.litegres.core.runtime

import java.nio.file.Path

/**
 * The resolved means of launching the PGlite runtime process. Keeping this as a
 * sealed type (rather than scattering `if (bun) ... else ...` checks through
 * process-management code) means Bun-specific behavior stays isolated to the
 * places that actually need it.
 */
internal sealed interface PGliteRuntime {

    /** Run the bundled JS launcher with an installed `bun` executable (development mode). */
    data class Bun(val executable: Path) : PGliteRuntime

    /** Run a standalone executable extracted from this library's own classpath resources. */
    data class StandaloneBundled(val platformId: String) : PGliteRuntime

    /** Run a standalone executable the user pointed us at directly; we do not manage its assets. */
    data class StandaloneExternal(val executable: Path) : PGliteRuntime
}

/** How the caller wants [PGliteRuntime] resolved. */
internal sealed interface RuntimeSelection {
    data object Auto : RuntimeSelection
    data class ExplicitBun(val executable: Path) : RuntimeSelection
    data class ExplicitStandalone(val executable: Path) : RuntimeSelection
    data object UseBundled : RuntimeSelection
}
