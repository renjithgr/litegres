package io.litegres.client.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Request to create a disposable database: empty, initialized with
 * statements, or cloned from a template.
 */
public final class DatabaseRequest {

    private String sessionId;
    private String templateId;
    private int ttlSeconds = 600;
    private final List<String> statements = new ArrayList<>();
    private final Map<String, String> metadata = new LinkedHashMap<>();

    private DatabaseRequest() {
    }

    public static DatabaseRequest empty() {
        return new DatabaseRequest();
    }

    public static DatabaseRequest fromTemplate(String templateId) {
        return new DatabaseRequest().templateId(templateId);
    }

    public static DatabaseRequest withStatements(String... statements) {
        DatabaseRequest r = new DatabaseRequest();
        for (String s : statements) {
            r.statements.add(s);
        }
        return r;
    }

    public DatabaseRequest sessionId(String sessionId) {
        this.sessionId = sessionId;
        return this;
    }

    public DatabaseRequest templateId(String templateId) {
        this.templateId = templateId;
        return this;
    }

    public DatabaseRequest ttlSeconds(int ttlSeconds) {
        this.ttlSeconds = ttlSeconds;
        return this;
    }

    public DatabaseRequest statement(String sql) {
        this.statements.add(sql);
        return this;
    }

    public DatabaseRequest metadata(String key, String value) {
        this.metadata.put(key, value);
        return this;
    }

    public String templateId() {
        return templateId;
    }

    /** Mutable builder that produces {@link DatabaseRequest} instances. */
    public static final class Builder {
        private final DatabaseRequest request = new DatabaseRequest();

        public Builder templateId(String templateId) {
            request.templateId(templateId);
            return this;
        }

        public Builder sessionId(String sessionId) {
            request.sessionId(sessionId);
            return this;
        }

        public Builder ttlSeconds(int ttlSeconds) {
            request.ttlSeconds(ttlSeconds);
            return this;
        }

        public Builder statement(String sql) {
            request.statement(sql);
            return this;
        }

        public Builder metadata(String key, String value) {
            request.metadata(key, value);
            return this;
        }

        public DatabaseRequest build() {
            return request;
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        if (sessionId != null) {
            json.put("sessionId", sessionId);
        }
        if (templateId != null) {
            json.put("templateId", templateId);
        }
        json.put("storage", Map.of("type", "memory"));
        json.put("ttlSeconds", ttlSeconds);
        if (!statements.isEmpty()) {
            json.put("initialization", Map.of("statements", statements));
        }
        if (!metadata.isEmpty()) {
            json.put("metadata", metadata);
        }
        return json;
    }
}
