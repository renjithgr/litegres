package io.litegres.client.model;

import java.util.Map;

/**
 * Filter for {@code GET /v1/databases}.
 */
public record DatabaseFilter(
        String sessionId,
        String templateId,
        String state,
        Boolean expired,
        String application) {

    public static DatabaseFilter none() {
        return new DatabaseFilter(null, null, null, null, null);
    }

    public static DatabaseFilter bySession(String sessionId) {
        return new DatabaseFilter(sessionId, null, null, null, null);
    }

    public DatabaseFilter application(String app) {
        return new DatabaseFilter(sessionId, templateId, state, expired, app);
    }

    public Map<String, String> toQuery() {
        java.util.LinkedHashMap<String, String> q = new java.util.LinkedHashMap<>();
        if (sessionId != null) {
            q.put("sessionId", sessionId);
        }
        if (templateId != null) {
            q.put("templateId", templateId);
        }
        if (state != null) {
            q.put("state", state);
        }
        if (expired != null) {
            q.put("expired", expired.toString());
        }
        if (application != null) {
            q.put("application", application);
        }
        return q;
    }
}
