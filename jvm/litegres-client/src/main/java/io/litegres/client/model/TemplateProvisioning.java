package io.litegres.client.model;

/**
 * A template in {@code provisioning} state plus the ephemeral PostgreSQL
 * endpoint used by external migration tooling. The endpoint is returned
 * exactly once and is closed on finalize.
 */
public record TemplateProvisioning(Template template, ConnectionInfo provisioningDatabase) {
}
