package io.litegres.client;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Finds and starts a {@code litegresd} binary when no daemon is running.
 *
 * <p>Binary lookup order: JVM property {@code litegres.bin}, environment
 * variable {@code LITEGRES_BIN}, {@code litegresd} on {@code PATH}, then
 * {@code dist/litegresd} in the working directory or any parent (handy in a
 * repository checkout).</p>
 *
 * <p>The daemon is started detached ({@code litegresd start --background}) in
 * the resolved runtime directory and is left running so that every test JVM,
 * Gradle fork and later run shares it. Stop it with {@code litegresd stop}.
 * Starting is serialized across processes with a file lock, so parallel test
 * forks never race.</p>
 *
 * <p>Configuration passed to a daemon started here: {@code litegres.postgresUrl}
 * becomes {@code LITEGRES_POSTGRES_URL}, {@code litegres.engine} becomes
 * {@code LITEGRES_ENGINE}; everything else is inherited from the environment
 * ({@code LITEGRES_*}).</p>
 */
public final class DaemonLauncher {

    private static final Duration STARTUP_TIMEOUT = Duration.ofSeconds(120);
    private static final int DEFAULT_CONTROL_PORT = 49100;
    /** FileLock forbids overlapping locks inside one JVM, so threads queue here first. */
    private static final Object JVM_LOCK = new Object();

    private DaemonLauncher() {
    }

    /** The {@code litegresd} binary to launch, if one can be found. */
    public static Optional<Path> findBinary() {
        String prop = System.getProperty("litegres.bin");
        if (prop != null && !prop.isBlank()) {
            return Optional.of(Path.of(prop));
        }
        String env = System.getenv("LITEGRES_BIN");
        if (env != null && !env.isBlank()) {
            return Optional.of(Path.of(env));
        }
        String path = System.getenv("PATH");
        if (path != null) {
            for (String dir : path.split(java.io.File.pathSeparator)) {
                if (dir.isBlank()) {
                    continue;
                }
                Path candidate = Path.of(dir, "litegresd");
                if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
                    return Optional.of(candidate);
                }
            }
        }
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int i = 0; i < 6 && dir != null; i++, dir = dir.getParent()) {
            Path candidate = dir.resolve("dist").resolve("litegresd");
            if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }

    /**
     * Ensure a ready daemon exists in the runtime directory, starting one if
     * necessary, and return a connected client.
     *
     * @throws LitegresException {@code DAEMON_NOT_FOUND} if no daemon runs and no binary
     *                           can be found, {@code DAEMON_START_FAILED} if it does not come up
     */
    static LitegresClient startAndConnect(LitegresException notRunning) {
        Path binary = findBinary().orElseThrow(() -> new LitegresException(
                "DAEMON_NOT_FOUND",
                notRunning.getMessage() + " No litegresd binary was found to start one: set -Dlitegres.bin=<path> "
                        + "or LITEGRES_BIN, put litegresd on PATH, or build it with `bun run build`.",
                404, null, notRunning.details()));
        Path runtimeDir = Discovery.runtimeDir();
        try {
            Files.createDirectories(runtimeDir);
        } catch (IOException e) {
            throw new LitegresException("DAEMON_START_FAILED", "Cannot create runtime dir " + runtimeDir + ": " + e.getMessage(),
                    500, null, Map.of());
        }
        synchronized (JVM_LOCK) {
            return startLocked(binary, runtimeDir);
        }
    }

    private static LitegresClient startLocked(Path binary, Path runtimeDir) {
        try (FileChannel channel = FileChannel.open(runtimeDir.resolve("start.lock"),
                StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                FileLock ignored = channel.lock()) {
            // Another process may have started it while we waited for the lock.
            Optional<LitegresClient> existing = tryConnect();
            if (existing.isPresent()) {
                return existing.get();
            }
            launch(binary, runtimeDir);
            return awaitReady(runtimeDir, binary);
        } catch (IOException e) {
            throw new LitegresException("DAEMON_START_FAILED", "Could not lock " + runtimeDir + ": " + e.getMessage(),
                    500, null, Map.of());
        }
    }

    private static Optional<LitegresClient> tryConnect() {
        try {
            return Optional.of(LitegresClients.connect());
        } catch (LitegresException e) {
            return Optional.empty();
        }
    }

    private static void launch(Path binary, Path runtimeDir) {
        Path log = runtimeDir.resolve("launcher.log");
        ProcessBuilder pb = new ProcessBuilder(List.of(binary.toString(), "start", "--background"));
        pb.environment().put("LITEGRES_RUNTIME_DIR", runtimeDir.toString());
        copyProperty(pb, "litegres.postgresUrl", "LITEGRES_POSTGRES_URL");
        copyProperty(pb, "litegres.engine", "LITEGRES_ENGINE");
        copyProperty(pb, "litegres.port", "LITEGRES_PORT");
        chooseFreePortIfDefaultIsTaken(pb);
        pb.redirectErrorStream(true);
        pb.redirectOutput(log.toFile());
        try {
            Process process = pb.start();
            if (!process.waitFor(120, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new LitegresException("DAEMON_START_FAILED", "`" + binary + " start --background` did not return.\n" + tail(log),
                        500, null, Map.of());
            }
            if (process.exitValue() != 0) {
                throw new LitegresException("DAEMON_START_FAILED",
                        "`" + binary + " start --background` failed (exit " + process.exitValue() + "):\n" + tail(log),
                        500, null, Map.of());
            }
        } catch (IOException e) {
            throw new LitegresException("DAEMON_START_FAILED", "Could not run " + binary + ": " + e.getMessage(), 500, null, Map.of());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new LitegresException("DAEMON_START_FAILED", "Interrupted while starting " + binary, 500, null, Map.of());
        }
    }

    private static LitegresClient awaitReady(Path runtimeDir, Path binary) {
        long deadline = System.nanoTime() + STARTUP_TIMEOUT.toNanos();
        LitegresException last = null;
        while (System.nanoTime() < deadline) {
            try {
                return LitegresClients.connect();
            } catch (LitegresException e) {
                last = e;
            }
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new LitegresException("DAEMON_START_FAILED",
                "Started " + binary + " but it did not become ready within " + STARTUP_TIMEOUT.toSeconds() + "s"
                        + (last == null ? "" : " (" + last.getMessage() + ")") + ".\n" + tail(runtimeDir.resolve("launcher.log"))
                        + "\nDaemon log: " + runtimeDir.resolve("daemon.log"),
                500, null, Map.of());
    }

    /**
     * The daemon's default control port may be held by another daemon (for
     * example one with a different runtime directory). Unless a port was
     * configured explicitly, fall back to a free one instead of failing.
     */
    private static void chooseFreePortIfDefaultIsTaken(ProcessBuilder pb) {
        if (pb.environment().containsKey("LITEGRES_PORT")) {
            return;
        }
        if (isFree(DEFAULT_CONTROL_PORT)) {
            return;
        }
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            pb.environment().put("LITEGRES_PORT", String.valueOf(socket.getLocalPort()));
        } catch (IOException e) {
            // leave the default; the daemon will report the conflict
        }
    }

    private static boolean isFree(int port) {
        try (java.net.ServerSocket socket = new java.net.ServerSocket(port, 1, java.net.InetAddress.getLoopbackAddress())) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static void copyProperty(ProcessBuilder pb, String property, String env) {
        String value = System.getProperty(property);
        if (value != null && !value.isBlank()) {
            pb.environment().put(env, value);
        }
    }

    private static String tail(Path file) {
        try {
            List<String> lines = new ArrayList<>(Files.readAllLines(file, StandardCharsets.UTF_8));
            int from = Math.max(0, lines.size() - 15);
            return String.join("\n", lines.subList(from, lines.size()));
        } catch (IOException e) {
            return "(no output)";
        }
    }
}
