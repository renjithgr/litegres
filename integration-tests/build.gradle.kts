plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    testImplementation(project(":pglite-core"))
    testImplementation(project(":pglite-junit5"))
    testImplementation(project(":pglite-spring"))
    testImplementation(project(":pglite-flyway"))

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testRuntimeOnly(libs.logback.classic)

    testImplementation(platform(libs.spring.boot.dependencies))
    testImplementation(libs.spring.boot.starter.test)
    testImplementation(libs.spring.boot.starter.jdbc)

    testImplementation(libs.jooq)

    testImplementation(libs.testcontainers.postgresql)
    testImplementation(libs.testcontainers.junit.jupiter)
}

tasks.register<Test>("integrationTest") {
    group = "verification"
    description = "Runs the full pglite-jvm end-to-end integration test suite"
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    shouldRunAfter(tasks.named("test"))
}

tasks.register<JavaExec>("benchmark") {
    group = "verification"
    description = "Runs the (rough, single-machine) PGlite-vs-Testcontainers startup benchmark. Requires Docker."
    mainClass.set("dev.pglitejvm.integration.benchmark.BenchmarkKt")
    classpath = sourceSets["test"].runtimeClasspath
}

// This module only exists to prove the released modules work together end to
// end; there is nothing to publish, and its own `test` task already IS the
// integration suite (there is no separate unit-test source set here).
tasks.named("test") {
    enabled = false
}
