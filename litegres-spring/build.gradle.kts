plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    api(project(":litegres-core"))
    compileOnly(platform(libs.spring.framework.bom))
    compileOnly(libs.spring.test)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(platform(libs.spring.framework.bom))
    testImplementation(libs.spring.test)
    testRuntimeOnly(libs.junit.platform.launcher)
    testRuntimeOnly(libs.logback.classic)
}
