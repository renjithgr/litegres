plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    api(project(":pglite-core"))
    api(libs.flyway.core)
    runtimeOnly(libs.flyway.database.postgresql)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testRuntimeOnly(libs.logback.classic)
}
