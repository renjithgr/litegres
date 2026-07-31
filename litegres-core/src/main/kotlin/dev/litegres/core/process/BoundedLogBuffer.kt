package dev.litegres.core.process

/** A thread-safe ring buffer of the most recent [maxLines] lines, for exception diagnostics. */
internal class BoundedLogBuffer(private val maxLines: Int) {
    private val lines = ArrayDeque<String>()
    private val lock = Any()

    fun add(line: String) {
        synchronized(lock) {
            lines.addLast(line)
            while (lines.size > maxLines) {
                lines.removeFirst()
            }
        }
    }

    fun snapshot(): List<String> = synchronized(lock) { lines.toList() }
}
