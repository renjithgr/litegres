plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
}

dependencies {
    api(libs.postgresql.jdbc)
    implementation(libs.jackson.databind)
    implementation(libs.jackson.module.kotlin)
    implementation(libs.slf4j.api)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
    testRuntimeOnly(libs.logback.classic)
}

val runtimeDir = rootProject.layout.projectDirectory.dir("litegres-runtime")

fun currentPlatformId(): String {
    val osName = System.getProperty("os.name").lowercase()
    val osArch = System.getProperty("os.arch").lowercase()
    val os = when {
        osName.contains("mac") -> "darwin"
        osName.contains("linux") -> "linux"
        osName.contains("windows") -> "windows"
        else -> throw GradleException("Unsupported OS for building litegres-runtime: $osName")
    }
    val arch = when (osArch) {
        "aarch64", "arm64" -> "aarch64"
        "x86_64", "amd64" -> "x86_64"
        else -> throw GradleException("Unsupported architecture for building litegres-runtime: $osArch")
    }
    return "$os-$arch"
}

val hostPlatformId = currentPlatformId()
val runtimeAssetNames = listOf("pglite.wasm", "pglite.data", "initdb.wasm")

val runtimeInstallDependencies = tasks.register<Exec>("runtimeInstallDependencies") {
    group = "litegres-runtime"
    description = "Installs litegres-runtime's JS dependencies with bun install"
    workingDir = runtimeDir.asFile
    commandLine("bun", "install", "--frozen-lockfile")
    inputs.file(runtimeDir.file("package.json"))
    inputs.file(runtimeDir.file("bun.lock"))
    outputs.dir(runtimeDir.dir("node_modules"))
}

val runtimeTypecheck = tasks.register<Exec>("runtimeTypecheck") {
    group = "litegres-runtime"
    description = "Type-checks the litegres-runtime TypeScript sources"
    dependsOn(runtimeInstallDependencies)
    workingDir = runtimeDir.asFile
    commandLine("bunx", "tsc", "--noEmit")
    inputs.dir(runtimeDir.dir("src"))
    inputs.dir(runtimeDir.dir("test"))
    inputs.file(runtimeDir.file("tsconfig.json"))
    outputs.upToDateWhen { false }
}

val runtimeTest = tasks.register<Exec>("runtimeTest") {
    group = "litegres-runtime"
    description = "Runs the litegres-runtime bun:test suite"
    dependsOn(runtimeInstallDependencies)
    workingDir = runtimeDir.asFile
    commandLine("bun", "test")
    inputs.dir(runtimeDir.dir("src"))
    inputs.dir(runtimeDir.dir("test"))
    outputs.upToDateWhen { false }
}

val runtimeBundle = tasks.register<Exec>("runtimeBundle") {
    group = "litegres-runtime"
    description = "Bundles the runtime into a single JS file runnable by an installed bun (development mode)"
    dependsOn(runtimeInstallDependencies)
    workingDir = runtimeDir.asFile
    commandLine("bun", "run", "bundle")
    inputs.dir(runtimeDir.dir("src"))
    inputs.file(runtimeDir.file("package.json"))
    inputs.file(runtimeDir.file("tsconfig.json"))
    outputs.file(runtimeDir.file("dist/litegres-runtime-bundle.js"))
}

val runtimeBuildExecutable = tasks.register<Exec>("runtimeBuildExecutable") {
    group = "litegres-runtime"
    description = "Compiles a standalone host-platform executable with bun build --compile"
    dependsOn(runtimeInstallDependencies)
    workingDir = runtimeDir.asFile
    commandLine("bun", "run", "build")
    inputs.dir(runtimeDir.dir("src"))
    inputs.file(runtimeDir.file("package.json"))
    inputs.file(runtimeDir.file("tsconfig.json"))
    outputs.file(runtimeDir.file("dist/litegres-runtime"))
}

val generatedResourcesDir = layout.buildDirectory.dir("generated-resources/litegres-runtime")

val prepareDevBundleResources = tasks.register<Copy>("prepareDevBundleResources") {
    group = "litegres-runtime"
    description = "Packages the bundled JS runtime + PGlite assets as classpath resources (development mode)"
    dependsOn(runtimeBundle)
    from(runtimeDir.file("dist/litegres-runtime-bundle.js"))
    from(runtimeDir.dir("node_modules/@electric-sql/pglite/dist")) {
        include(runtimeAssetNames)
    }
    into(generatedResourcesDir.map { it.dir("litegres-runtime/bundle") })
}

val prepareStandaloneResources = tasks.register<Copy>("prepareStandaloneResources") {
    group = "litegres-runtime"
    description = "Packages a compiled standalone executable + PGlite assets for the host platform as classpath resources"
    dependsOn(runtimeBuildExecutable)
    from(runtimeDir.file("dist/litegres-runtime"))
    from(runtimeDir.dir("node_modules/@electric-sql/pglite/dist")) {
        include(runtimeAssetNames)
    }
    into(generatedResourcesDir.map { it.dir("litegres-runtime/bin/$hostPlatformId") })
}

tasks.register("buildPGliteRuntime") {
    group = "litegres-runtime"
    description = "Type-checks, tests and packages the litegres-runtime for both development and standalone modes"
    dependsOn(runtimeTypecheck, runtimeTest, prepareDevBundleResources, prepareStandaloneResources)
}

sourceSets {
    main {
        resources.srcDir(generatedResourcesDir)
    }
}

tasks.named("processResources") {
    dependsOn(prepareDevBundleResources, prepareStandaloneResources)
}

tasks.named("check") {
    dependsOn(runtimeTypecheck, runtimeTest)
}
