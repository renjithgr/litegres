package io.litegres.client;

import java.util.Map;

/**
 * Typed error thrown for control-plane failures. Carries the structured
 * {@code code}, HTTP {@code status}, {@code requestId} and {@code details}
 * from the Litegres daemon.
 */
public class LitegresException extends RuntimeException {

    private final String code;
    private final int status;
    private final String requestId;
    private final Map<String, Object> details;

    public LitegresException(String code, String message, int status, String requestId, Map<String, Object> details) {
        super(message);
        this.code = code;
        this.status = status;
        this.requestId = requestId;
        this.details = details == null ? Map.of() : details;
    }

    public static LitegresException of(Throwable cause) {
        return new LitegresException("INTERNAL_ERROR", cause.getMessage(), -1, null, Map.of());
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }

    public String requestId() {
        return requestId;
    }

    public Map<String, Object> details() {
        return details;
    }

    @Override
    public String toString() {
        return "LitegresException{code='" + code + "', status=" + status
                + ", requestId='" + requestId + "', message='" + getMessage() + "'}";
    }
}
