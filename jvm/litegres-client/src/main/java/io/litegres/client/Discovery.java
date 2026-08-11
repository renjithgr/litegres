package io.litegres.client;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * Daemon discovery: locate the runtime directory ({@code daemon.json}) and
 * read the control token, mirroring the daemon's own resolution rules.
 */
public final class Discovery {

    private Discovery() {
    }

    public record Info(String controlUrl, String token, Path tokenFile, int pid, String version, String startedAt) {
    }

    public static Info discover() {
        return discover(runtimeDir());
    }

    public static Info discover(Path runtimeDir) {
        Path daemonFile = runtimeDir.resolve("daemon.json");
        if (!Files.isRegularFile(daemonFile)) {
            throw new LitegresException(
                    "DAEMON_NOT_FOUND",
                    "No Litegres daemon discovery file at " + daemonFile
                            + ". Start the daemon with `litegresd run` (or build the binary with `bun run build`) first.",
                    404, null, Map.of("runtimeDir", runtimeDir.toString()));
        }
        Map<String, Object> json = Json.readObject(read(daemonFile));
        String controlUrl = (String) json.get("controlUrl");
        Number pid = (Number) json.get("pid");
        if (controlUrl == null || pid == null) {
            throw new LitegresException("DAEMON_NOT_FOUND", "Malformed discovery file at " + daemonFile, 500, null, Map.of());
        }
        Path tokenFile = Path.of((String) json.get("tokenFile"));
        String token = null;
        if (Files.isRegularFile(tokenFile)) {
            token = read(tokenFile).trim();
        }
        if (token == null || token.isEmpty()) {
            throw new LitegresException(
                    "DAEMON_NOT_FOUND",
                    "No Litegres control token at " + tokenFile + ". Start the daemon first.",
                    404, null, Map.of());
        }
        return new Info(
                controlUrl,
                token,
                tokenFile,
                pid.intValue(),
                (String) json.get("version"),
                (String) json.get("startedAt"));
    }

    /**
     * Resolve the runtime directory: {@code LITEGRES_RUNTIME_DIR} beats
     * {@code XDG_RUNTIME_DIR}/litegres beats {@code ~/.local/state/litegres}
     * beats {@code tmpdir/litegres-<uid>}.
     */
    public static Path runtimeDir() {
        // Explicit JVM property wins (reliable through the Gradle daemon),
        // then the environment, then platform defaults.
        String propDir = System.getProperty("litegres.runtimeDir");
        if (propDir != null && !propDir.isBlank()) {
            return Path.of(propDir);
        }
        String envDir = System.getenv("LITEGRES_RUNTIME_DIR");
        if (envDir != null && !envDir.isBlank()) {
            return Path.of(envDir);
        }
        String xdg = System.getenv("XDG_RUNTIME_DIR");
        if (xdg != null && !xdg.isBlank()) {
            return Path.of(xdg, "litegres");
        }
        String home = System.getProperty("user.home");
        if (home != null && !home.isBlank()) {
            return Path.of(home, ".local", "state", "litegres");
        }
        return Path.of(System.getProperty("java.io.tmpdir"), "litegres-" + System.getProperty("user.name"));
    }

    private static String read(Path p) {
        try {
            return Files.readString(p, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new LitegresException("DAEMON_NOT_FOUND", "Could not read " + p + ": " + e.getMessage(), 500, null, Map.of());
        }
    }
}
