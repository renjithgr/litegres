package io.litegres.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Daemon-free unit tests for discovery and error mapping.
 */
class LitegresClientDiscoveryTest {

    @TempDir
    Path tempDir;

    @Test
    void discoversDaemonFromRuntimeDir() throws IOException {
        Path runtime = tempDir.resolve("rt");
        Files.createDirectories(runtime);
        Files.writeString(runtime.resolve("daemon.json"), """
                {
                  "pid": 12345,
                  "version": "0.1.0",
                  "controlUrl": "http://127.0.0.1:49100",
                  "tokenFile": "%s",
                  "startedAt": "2026-08-06T17:40:00Z"
                }
                """.formatted(runtime.resolve("token")));
        Files.writeString(runtime.resolve("token"), "tok_secret_value_here\n");

        Discovery.Info info = Discovery.discover(runtime);
        assertEquals("http://127.0.0.1:49100", info.controlUrl());
        assertEquals("tok_secret_value_here", info.token());
        assertEquals(12345, info.pid());
    }

    @Test
    void missingDaemonProducesHelpfulError() {
        Path empty = tempDir.resolve("empty");
        LitegresException e = assertThrows(LitegresException.class, () -> Discovery.discover(empty));
        assertEquals("DAEMON_NOT_FOUND", e.code());
        assertTrue(e.getMessage().contains("litegresd run"), e.getMessage());
    }

    @Test
    void missingTokenProducesHelpfulError() throws IOException {
        Path runtime = tempDir.resolve("rt2");
        Files.createDirectories(runtime);
        Files.writeString(runtime.resolve("daemon.json"), """
                {
                  "pid": 12345,
                  "version": "0.1.0",
                  "controlUrl": "http://127.0.0.1:49100",
                  "tokenFile": "%s"
                }
                """.formatted(runtime.resolve("missing-token")));
        LitegresException e = assertThrows(LitegresException.class, () -> Discovery.discover(runtime));
        assertEquals("DAEMON_NOT_FOUND", e.code());
        assertTrue(e.getMessage().contains("token"), e.getMessage());
    }

    @Test
    void exceptionCarriesCodeStatusAndDetails() {
        LitegresException e = new LitegresException(
                "DATABASE_CAPACITY_EXHAUSTED", "limit reached", 429, "req_1",
                java.util.Map.of("active", 32, "maximum", 32));
        assertEquals("DATABASE_CAPACITY_EXHAUSTED", e.code());
        assertEquals(429, e.status());
        assertEquals("req_1", e.requestId());
        assertEquals(32, e.details().get("active"));
    }
}
