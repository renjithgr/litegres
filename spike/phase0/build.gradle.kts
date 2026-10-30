plugins {
    java
    id("org.springframework.boot") version "3.5.6"
    id("io.spring.dependency-management") version "1.1.7"
}

repositories { mavenCentral() }

tasks.withType<JavaCompile>().configureEach { options.release.set(21) }

// Reuse the Litegres Java client sources directly (no publishing needed for the spike).
sourceSets { test { java.srcDir("../../jvm/litegres-client/src/main/java") } }

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.flywaydb:flyway-core")
    implementation("org.flywaydb:flyway-database-postgresql")
    runtimeOnly("org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.flywaydb:flyway-core")
    testImplementation("org.flywaydb:flyway-database-postgresql")
    testImplementation("org.postgresql:postgresql")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

val backend = (findProperty("backend") ?: "template").toString()
val forks = (findProperty("forks") ?: "1").toString().toInt()

tasks.test {
    useJUnitPlatform()
    ignoreFailures = true
    maxParallelForks = forks
    systemProperty("spike.backend", backend)
    findProperty("poolSize")?.let { systemProperty("spike.poolSize", it.toString()) }
    findProperty("prepareWorkaround")?.let { systemProperty("spike.prepareWorkaround", it.toString()) }
    systemProperty("spike.pg.url", System.getProperty("spike.pg.url") ?: "jdbc:postgresql://127.0.0.1:55432/postgres")
    findProperty("litegresRuntimeDir")?.let { systemProperty("litegres.runtimeDir", it.toString()) }
    systemProperty("spike.out", layout.buildDirectory.dir("spike-$backend-f$forks").get().asFile.absolutePath)
    // each run starts clean
    doFirst { delete(layout.buildDirectory.dir("spike-$backend-f$forks")) }
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.SHORT }
    reports.junitXml.outputLocation.set(layout.buildDirectory.dir("results-$backend-f$forks"))
}

tasks.register<JavaExec>("bench") {
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("spike.Bench")
    isIgnoreExitValue = false
    systemProperty("spike.backend", backend)
    systemProperty("spike.pg.url", System.getProperty("spike.pg.url") ?: "jdbc:postgresql://127.0.0.1:55432/postgres")
    findProperty("litegresRuntimeDir")?.let { systemProperty("litegres.runtimeDir", it.toString()) }
    systemProperty("spike.out", layout.buildDirectory.dir("bench-$backend").get().asFile.absolutePath)
}
