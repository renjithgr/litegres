package dev.litegres.core.runtime

/**
 * Identifies the current OS/CPU combination using the same identifiers used to
 * name bundled standalone-executable resources, e.g. `darwin-aarch64`.
 */
internal object PlatformId {

    fun isWindows(): Boolean = System.getProperty("os.name").lowercase().contains("win")

    fun current(): String {
        val osName = System.getProperty("os.name").lowercase()
        val osArch = System.getProperty("os.arch").lowercase()

        val os = when {
            osName.contains("mac") || osName.contains("darwin") -> "darwin"
            osName.contains("linux") -> "linux"
            osName.contains("win") -> "windows"
            else -> throw UnsupportedOperationException(
                "litegres does not support operating system \"$osName\". " +
                    "Supported: darwin, linux, windows.",
            )
        }

        val arch = when (osArch) {
            "aarch64", "arm64" -> "aarch64"
            "x86_64", "amd64" -> "x86_64"
            else -> throw UnsupportedOperationException(
                "litegres does not support CPU architecture \"$osArch\". " +
                    "Supported: aarch64, x86_64.",
            )
        }

        return "$os-$arch"
    }
}
