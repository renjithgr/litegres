// Root build for the Litegres JVM modules.
plugins {
    base
}

subprojects {
    group = "io.litegres"
    version = "0.1.0"

    repositories {
        mavenCentral()
    }
}
