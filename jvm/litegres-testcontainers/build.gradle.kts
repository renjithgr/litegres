plugins {
    `java-library`
}

java {
    // Compile to Java 17 bytecode using whatever JDK is installed.
    withSourcesJar()
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}

dependencies {
    api(project(":litegres-client"))
    api(project(":litegres-junit5"))
    api("org.testcontainers:testcontainers:1.21.4")

    // JUnit extension interfaces implemented by LitegresContainer are
    // provided by the consuming test framework at runtime.
    compileOnly("org.junit.jupiter:junit-jupiter-api:5.11.4")

    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("org.postgresql:postgresql:42.7.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    // Docker-backed tests need the Litegres image. Override the default with
    // -PlitegresDockerImage=my-registry/litegresd:tag (or build it first:
    // `bun run docker-build` at the repo root).
    val image = project.findProperty("litegresDockerImage") as String?
    if (image != null) {
        systemProperty("litegres.testcontainers.image", image)
    }
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}
