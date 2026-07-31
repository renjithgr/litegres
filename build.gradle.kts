plugins {
    alias(libs.plugins.kotlin.jvm) apply false
}

allprojects {
    group = "dev.pglitejvm"
    version = "0.1.0-SNAPSHOT"

    repositories {
        mavenCentral()
    }
}

subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension> {
            jvmToolchain(21)
        }

        tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
            compilerOptions {
                freeCompilerArgs.add("-Xjsr305=strict")
            }
        }

        tasks.withType<Test>().configureEach {
            useJUnitPlatform()
            // pglite-core's shutdown-hook test reflects into java.lang.ApplicationShutdownHooks
            // to verify hooks are actually deregistered, not just that no exception is thrown.
            jvmArgs("--add-opens", "java.base/java.lang=ALL-UNNAMED")
            testLogging {
                events("passed", "skipped", "failed")
                exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
            }
        }
    }
}
