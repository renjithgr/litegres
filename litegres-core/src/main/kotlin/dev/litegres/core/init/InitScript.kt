package dev.litegres.core.init

import java.nio.file.Files
import java.nio.file.Path

/** A SQL initialization source: a classpath resource, a filesystem file, or an inline string. */
internal sealed interface InitScript {
    /** Human-readable identity used in logs and exception messages. */
    val identity: String

    fun readSql(): String

    data class ClasspathResource(val resourcePath: String) : InitScript {
        override val identity get() = "classpath:$resourcePath"

        override fun readSql(): String {
            val stream = Thread.currentThread().contextClassLoader?.getResourceAsStream(resourcePath)
                ?: InitScript::class.java.classLoader.getResourceAsStream(resourcePath)
                ?: throw IllegalArgumentException("Classpath init script not found: $resourcePath")
            return stream.use { it.readBytes().toString(Charsets.UTF_8) }
        }
    }

    data class FilesystemPath(val path: Path) : InitScript {
        override val identity get() = path.toString()

        override fun readSql(): String {
            if (!Files.exists(path)) {
                throw IllegalArgumentException("Init script file not found: $path")
            }
            return Files.readString(path)
        }
    }

    data class RawSql(val sql: String) : InitScript {
        override val identity get() = "inline SQL (${sql.length} chars)"
        override fun readSql(): String = sql
    }

    companion object {
        /** `"classpath:foo.sql"` resolves as a classpath resource; anything else is a filesystem path. */
        fun fromLocation(location: String): InitScript = when {
            location.startsWith("classpath:") -> ClasspathResource(location.removePrefix("classpath:"))
            else -> FilesystemPath(Path.of(location))
        }
    }
}
