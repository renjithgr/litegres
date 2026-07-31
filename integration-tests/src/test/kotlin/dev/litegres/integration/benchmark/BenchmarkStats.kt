package dev.litegres.integration.benchmark

import kotlin.math.sqrt

/** Timing samples (in milliseconds) collected for one named scenario. */
data class ScenarioResult(val name: String, val samplesMillis: List<Long>) {
    val min: Long = samplesMillis.min()
    val max: Long = samplesMillis.max()
    val mean: Double = samplesMillis.average()
    val median: Long = samplesMillis.sorted()[samplesMillis.size / 2]
    val stddev: Double = run {
        if (samplesMillis.size < 2) return@run 0.0
        val m = mean
        sqrt(samplesMillis.sumOf { (it - m) * (it - m) } / samplesMillis.size)
    }
}

/**
 * Runs [block] [warmupIterations] times (discarded) then [measuredIterations]
 * times (timed), printing each raw sample as it completes so a long-running
 * scenario (e.g. Testcontainers) still shows live progress.
 */
fun runScenario(
    name: String,
    measuredIterations: Int,
    warmupIterations: Int = 0,
    block: () -> Unit,
): ScenarioResult {
    println("--- $name ---")
    if (warmupIterations > 0) {
        print("  warming up ($warmupIterations)... ")
        repeat(warmupIterations) { block() }
        println("done")
    }
    val samples = (1..measuredIterations).map { i ->
        val millis = timeMillis(block)
        println("  run $i/$measuredIterations: ${millis}ms")
        millis
    }
    return ScenarioResult(name, samples)
}

fun timeMillis(block: () -> Unit): Long {
    val start = System.nanoTime()
    block()
    return (System.nanoTime() - start) / 1_000_000
}

fun printResultsTable(results: List<ScenarioResult>) {
    println()
    println("=".repeat(100))
    println("%-52s %8s %8s %9s %8s %9s".format("Scenario", "min", "median", "mean", "max", "stddev"))
    println("-".repeat(100))
    results.forEach {
        println(
            "%-52s %6dms %6dms %7.0fms %6dms %7.0fms"
                .format(it.name, it.min, it.median, it.mean, it.max, it.stddev),
        )
    }
    println("=".repeat(100))
}

fun printSpeedups(results: List<ScenarioResult>) {
    fun find(substring: String) = results.find { it.name.contains(substring) }

    val comparisons = listOf(
        Triple("cold startup", "litegres: cold startup (in-memory)", "Testcontainers: cold startup"),
        Triple(
            "cold startup + Flyway migration",
            "litegres: cold startup + Flyway migration",
            "Testcontainers: cold startup + Flyway migration",
        ),
        Triple(
            "5 sequential fresh instances (a small test suite)",
            "litegres: 5 sequential fresh instances",
            "Testcontainers: 5 sequential fresh instances",
        ),
    )

    val lines = comparisons.mapNotNull { (label, litegresName, tcName) ->
        val litegresMedian = find(litegresName)?.median
        val tcMedian = find(tcName)?.median
        if (litegresMedian == null || tcMedian == null || litegresMedian <= 0) return@mapNotNull null
        "  %-52s %.1fx faster (median: %dms vs %dms)".format(label, tcMedian.toDouble() / litegresMedian, litegresMedian, tcMedian)
    }

    if (lines.isEmpty()) return
    println()
    println("litegres vs. Testcontainers (median), this run only:")
    lines.forEach(::println)
}

fun writeMarkdownReport(results: List<ScenarioResult>, outputFile: java.io.File) {
    outputFile.parentFile?.mkdirs()
    outputFile.writeText(
        buildString {
            appendLine("# litegres vs Testcontainers startup benchmark")
            appendLine()
            appendLine(
                "Single machine, single run — see the project README's " +
                    "\"Compatibility limitations\" section before drawing conclusions.",
            )
            appendLine()
            appendLine("| Scenario | min | median | mean | max | stddev |")
            appendLine("|---|---|---|---|---|---|")
            results.forEach {
                appendLine(
                    "| ${it.name} | ${it.min}ms | ${it.median}ms | " +
                        "${"%.0f".format(it.mean)}ms | ${it.max}ms | ${"%.0f".format(it.stddev)}ms |",
                )
            }
        },
    )
    println()
    println("Markdown report written to ${outputFile.absolutePath}")
}
