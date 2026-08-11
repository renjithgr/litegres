package io.litegres.client.model;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Request to create a template, either from statements ({@code put}) or as
 * an external provisioning target ({@code create}).
 */
public final class TemplateRequest {

    private final String fingerprint;
    private String name;
    private final Map<String, String> metadata = new LinkedHashMap<>();
    private final java.util.List<String> statements = new java.util.ArrayList<>();

    private TemplateRequest(String fingerprint) {
        this.fingerprint = fingerprint;
    }

    /** A template created from raw statements (idempotent by fingerprint). */
    public static TemplateRequest fromStatements(String fingerprint, String... statements) {
        TemplateRequest r = new TemplateRequest(fingerprint);
        for (String s : statements) {
            r.statements.add(s);
        }
        return r;
    }

    /** A template for external provisioning (migrations run by your tooling). */
    public static TemplateRequest forProvisioning(String fingerprint) {
        return new TemplateRequest(fingerprint);
    }

    public TemplateRequest name(String name) {
        this.name = name;
        return this;
    }

    public TemplateRequest metadata(String key, String value) {
        this.metadata.put(key, value);
        return this;
    }

    public String fingerprint() {
        return fingerprint;
    }

    public Map<String, Object> toJson() {
        Map<String, Object> json = new LinkedHashMap<>();
        if (name != null) {
            json.put("name", name);
        }
        if (!statements.isEmpty()) {
            json.put("initialization", Map.of("statements", statements));
        }
        if (!metadata.isEmpty()) {
            json.put("metadata", metadata);
        }
        return json;
    }
}
