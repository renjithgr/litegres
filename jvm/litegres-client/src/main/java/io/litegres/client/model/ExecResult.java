package io.litegres.client.model;

import java.util.List;
import java.util.Map;

/**
 * Result of the administrative {@code exec} endpoint.
 */
public record ExecResult(List<String> fields, List<Map<String, Object>> rows, Long affectedRows) {
}
