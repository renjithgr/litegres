package io.litegres.client;

import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Thin Jackson wrapper used by the client. Jackson reads/writes plain
 * {@code Map}/{@code List} trees, which keeps the models dependency-free and
 * tolerant of new fields.
 */
final class Json {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    private Json() {
    }

    static String write(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (Exception e) {
            throw new LitegresException("INTERNAL_ERROR", "Failed to serialize JSON: " + e.getMessage(), -1, null, Map.of());
        }
    }

    static Map<String, Object> readObject(String text) {
        try {
            return MAPPER.readValue(text, new TypeReference<Map<String, Object>>() {
            });
        } catch (Exception e) {
            throw new LitegresException("INTERNAL_ERROR", "Failed to parse JSON: " + e.getMessage(), -1, null, Map.of());
        }
    }

    static List<Map<String, Object>> readList(String text) {
        try {
            return MAPPER.readValue(text, new TypeReference<List<Map<String, Object>>>() {
            });
        } catch (Exception e) {
            throw new LitegresException("INTERNAL_ERROR", "Failed to parse JSON: " + e.getMessage(), -1, null, Map.of());
        }
    }
}
