package dev.litegres.core

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/** Extracts a script from `src/test/resources/fake-runtimes` to an executable temp file. */
internal object FakeRuntimeScripts {
    fun extract(name: String): Path {
        val resourcePath = "fake-runtimes/$name"
        val stream = Thread.currentThread().contextClassLoader.getResourceAsStream(resourcePath)
            ?: error("Fake runtime script not found on classpath: $resourcePath")
        val target = Files.createTempFile("litegres-fake-runtime-", ".sh")
        stream.use { Files.copy(it, target, StandardCopyOption.REPLACE_EXISTING) }
        target.toFile().setExecutable(true)
        return target
    }
}
