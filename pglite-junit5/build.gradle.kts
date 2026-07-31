plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    api(project(":pglite-core"))
    api(platform(libs.junit.bom))
    api(libs.junit.jupiter.api)

    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testRuntimeOnly(libs.logback.classic)
}
