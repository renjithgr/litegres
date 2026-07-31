package dev.pglitejvm.core.runtime

import dev.pglitejvm.core.exceptions.PGliteRuntimeNotFoundException
import org.slf4j.LoggerFactory
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.atomic.AtomicBoolean

/** A runtime extracted to a private temp directory, along with its own cleanup. */
internal class ExtractedRuntime(val directory: Path, val entrypoint: Path) : Closeable {
    private val logger = LoggerFactory.getLogger(ExtractedRuntime::class.java)
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching {
            directory.toFile().deleteRecursively()
        }.onFailure {
            logger.warn("Failed to remove extracted runtime directory {}: {}", directory, it.message)
        }
    }
}

/**
 * Extracts classpath-packaged runtime assets (bundled JS launcher, or a
 * platform-specific standalone executable, plus PGlite's own WASM/data assets)
 * into a private, uniquely-named temp directory. Using [Files.createTempDirectory]
 * keeps concurrent tests, and multiple copies of this library on one JVM, from
 * colliding with each other.
 */
internal object RuntimeResources {

    private val ASSET_NAMES = listOf("pglite.wasm", "pglite.data", "initdb.wasm")

    fun extractDevBundle(): ExtractedRuntime =
        extract(resourceDir = "pglite-runtime/bundle", entrypointName = "pglite-runtime-bundle.js", makeExecutable = false)

    fun extractStandalone(platformId: String): ExtractedRuntime {
        val entrypointName = if (PlatformId.isWindows()) "pglite-runtime.exe" else "pglite-runtime"
        return extract(resourceDir = "pglite-runtime/bin/$platformId", entrypointName = entrypointName, makeExecutable = true)
    }

    private fun extract(resourceDir: String, entrypointName: String, makeExecutable: Boolean): ExtractedRuntime {
        val tempDir = Files.createTempDirectory("pglite-jvm-")
        for (name in listOf(entrypointName) + ASSET_NAMES) {
            val resourcePath = "$resourceDir/$name"
            val resourceStream = classpathResource(resourcePath)
                ?: throw PGliteRuntimeNotFoundException(
                    listOf(
                        "classpath resource $resourcePath was not found — was the runtime built and packaged? " +
                            "run ./gradlew :pglite-core:buildPGliteRuntime",
                    ),
                )
            val target = tempDir.resolve(name)
            resourceStream.use { Files.copy(it, target, StandardCopyOption.REPLACE_EXISTING) }
        }
        val entrypoint = tempDir.resolve(entrypointName)
        if (makeExecutable) {
            entrypoint.toFile().setExecutable(true)
        }
        return ExtractedRuntime(tempDir, entrypoint)
    }

    private fun classpathResource(path: String) =
        Thread.currentThread().contextClassLoader?.getResourceAsStream(path)
            ?: RuntimeResources::class.java.classLoader.getResourceAsStream(path)
}
