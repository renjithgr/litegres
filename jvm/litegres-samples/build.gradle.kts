plugins {
    java
}

java {
    // Compile to Java 17 bytecode using whatever JDK is installed.
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}

dependencies {
    implementation(project(":litegres-junit5"))
    implementation(project(":litegres-client"))

    implementation(platform("org.junit:junit-bom:5.11.4"))
    implementation("org.junit.jupiter:junit-jupiter")
    runtimeOnly("org.junit.platform:junit-platform-launcher")

    implementation("org.postgresql:postgresql:42.7.4")
    implementation("com.zaxxer:HikariCP:6.2.1")
}

tasks.test {
    useJUnitPlatform()
    // The samples need a running litegresd daemon; point them at its runtime
    // dir with -PlitegresRuntimeDir=/path (see jvm/README.md). A Gradle
    // property is used because it flows to the daemon per-invocation, unlike
    // the daemon's cached environment.
    val rt = project.findProperty("litegresRuntimeDir") as String?
    if (rt != null) {
        systemProperty("litegres.runtimeDir", rt)
    }
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}
