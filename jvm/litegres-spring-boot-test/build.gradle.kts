plugins {
    `java-library`
}

java {
    withSourcesJar()
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}

// Only spring-test is needed at compile time: the module hooks into the test
// context through ContextCustomizer / TestExecutionListener and sets plain
// spring.datasource.* properties, so it works with Spring Boot 3 and 4 alike.
val springBootBom = "org.springframework.boot:spring-boot-dependencies:3.5.6"

dependencies {
    api(project(":litegres-client"))

    compileOnly(platform(springBootBom))
    compileOnly("org.springframework:spring-test")
    compileOnly("org.springframework:spring-context")
    // Optional: only used when @LitegresTest(migrations = ...) is set.
    compileOnly("org.flywaydb:flyway-core")

    testImplementation(platform(springBootBom))
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-jdbc")
    testImplementation("org.flywaydb:flyway-core")
    testImplementation("org.flywaydb:flyway-database-postgresql")
    testRuntimeOnly("org.postgresql:postgresql")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    // Two forks prove the per-JVM database: each fork gets its own database
    // and never sees the other's data.
    maxParallelForks = 2
    val rt = project.findProperty("litegresRuntimeDir") as String?
    if (rt != null) {
        systemProperty("litegres.runtimeDir", rt)
    }
    mapOf("litegresBin" to "litegres.bin", "litegresPostgresUrl" to "litegres.postgresUrl").forEach { (prop, sys) ->
        project.findProperty(prop)?.let { systemProperty(sys, it.toString()) }
    }
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}
