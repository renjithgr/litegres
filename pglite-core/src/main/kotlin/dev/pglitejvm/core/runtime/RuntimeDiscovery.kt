package dev.pglitejvm.core.runtime

import dev.pglitejvm.core.exceptions.PGliteRuntimeNotFoundException
import java.nio.file.Files
import java.nio.file.Path

/**
 * Resolves a [PGliteRuntime] from a [RuntimeSelection], following the documented
 * discovery order for [RuntimeSelection.Auto]:
 *
 * 1. Explicit builder configuration (handled by the non-Auto branches)
 * 2. `PGLITE_JVM_RUNTIME_PATH` (external compiled standalone executable)
 * 3. A bundled platform-specific standalone executable on the classpath
 * 4. `PGLITE_JVM_BUN_PATH`
 * 5. `bun` found on `PATH`
 */
internal object RuntimeDiscovery {

    fun resolve(selection: RuntimeSelection): PGliteRuntime = when (selection) {
        is RuntimeSelection.ExplicitStandalone ->
            PGliteRuntime.StandaloneExternal(requireExecutable(selection.executable, "explicit runtime executable"))

        is RuntimeSelection.ExplicitBun ->
            PGliteRuntime.Bun(requireExecutable(selection.executable, "explicit bun executable"))

        is RuntimeSelection.UseBundled ->
            resolveBundled() ?: throw PGliteRuntimeNotFoundException(
                listOf("bundled executable for platform ${runCatching { PlatformId.current() }.getOrDefault("unknown")} (not present on the classpath)"),
            )

        RuntimeSelection.Auto -> resolveAuto()
    }

    private fun resolveAuto(): PGliteRuntime {
        val checked = mutableListOf<String>()

        System.getenv("PGLITE_JVM_RUNTIME_PATH")?.let { path ->
            return PGliteRuntime.StandaloneExternal(requireExecutable(Path.of(path), "PGLITE_JVM_RUNTIME_PATH=$path"))
        }
        checked += "PGLITE_JVM_RUNTIME_PATH (not set)"

        resolveBundled()?.let { return it }
        checked += "bundled executable for platform ${runCatching { PlatformId.current() }.getOrDefault("unknown")} (not present on the classpath)"

        System.getenv("PGLITE_JVM_BUN_PATH")?.let { path ->
            return PGliteRuntime.Bun(requireExecutable(Path.of(path), "PGLITE_JVM_BUN_PATH=$path"))
        }
        checked += "PGLITE_JVM_BUN_PATH (not set)"

        findOnPath("bun")?.let { return PGliteRuntime.Bun(it) }
        checked += "bun on PATH"

        throw PGliteRuntimeNotFoundException(checked)
    }

    private fun resolveBundled(): PGliteRuntime.StandaloneBundled? {
        val platformId = runCatching { PlatformId.current() }.getOrNull() ?: return null
        val entrypointName = if (PlatformId.isWindows()) "pglite-runtime.exe" else "pglite-runtime"
        val resourcePath = "pglite-runtime/bin/$platformId/$entrypointName"
        val found = Thread.currentThread().contextClassLoader?.getResource(resourcePath)
            ?: RuntimeDiscovery::class.java.classLoader.getResource(resourcePath)
        return if (found != null) PGliteRuntime.StandaloneBundled(platformId) else null
    }

    private fun requireExecutable(path: Path, source: String): Path {
        if (!Files.exists(path)) {
            throw PGliteRuntimeNotFoundException(listOf("$source -> $path does not exist"))
        }
        if (!Files.isRegularFile(path)) {
            throw PGliteRuntimeNotFoundException(listOf("$source -> $path is not a regular file"))
        }
        if (!PlatformId.isWindows() && !Files.isExecutable(path)) {
            throw PGliteRuntimeNotFoundException(listOf("$source -> $path is not executable (check file permissions)"))
        }
        return path
    }

    private fun findOnPath(executableName: String): Path? {
        val pathEnv = System.getenv("PATH") ?: return null
        val candidateNames = if (PlatformId.isWindows()) {
            listOf("$executableName.exe", "$executableName.cmd", "$executableName.bat", executableName)
        } else {
            listOf(executableName)
        }
        for (dir in pathEnv.split(java.io.File.pathSeparatorChar)) {
            if (dir.isBlank()) continue
            for (name in candidateNames) {
                val candidate = Path.of(dir, name)
                if (Files.isRegularFile(candidate) && (PlatformId.isWindows() || Files.isExecutable(candidate))) {
                    return candidate
                }
            }
        }
        return null
    }
}
