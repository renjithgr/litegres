package io.litegres.client.model;

import java.util.Map;

/**
 * Daemon status snapshot ({@code GET /v1/status}). No secrets.
 */
public record Status(
        String name,
        String version,
        String state,
        String startedAt,
        long uptimeSeconds,
        int activeDatabases,
        int activeTemplates,
        int activeSessions,
        Map<String, Object> limits,
        Map<String, Object> runtime) {

    public boolean ready() {
        return "READY".equals(state);
    }

    @SuppressWarnings("unchecked")
    public static Status from(Map<String, Object> m) {
        return new Status(
                (String) m.get("name"),
                (String) m.get("version"),
                (String) m.get("state"),
                (String) m.get("startedAt"),
                ((Number) m.getOrDefault("uptimeSeconds", 0)).longValue(),
                ((Number) m.getOrDefault("activeDatabases", 0)).intValue(),
                ((Number) m.getOrDefault("activeTemplates", 0)).intValue(),
                ((Number) m.getOrDefault("activeSessions", 0)).intValue(),
                (Map<String, Object>) m.getOrDefault("limits", Map.of()),
                (Map<String, Object>) m.getOrDefault("runtime", Map.of()));
    }
}
