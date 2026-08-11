import { describe, expect, test } from "bun:test";
import { toErrorObject, ApiError } from "../../src/api/errors";

describe("error serialization", () => {
  test("ApiError serializes with code, message, requestId and details", () => {
    const err = new ApiError("DATABASE_NOT_FOUND", "Database db_1 was not found.", 404, { databaseId: "db_1" });
    const out = toErrorObject(err, "req_1");
    expect(out.error.code).toBe("DATABASE_NOT_FOUND");
    expect(out.error.message).toBe("Database db_1 was not found.");
    expect(out.error.requestId).toBe("req_1");
    expect(out.error.details).toEqual({ databaseId: "db_1" });
  });

  test("unknown errors become INTERNAL_ERROR without raw stack traces", () => {
    const out = toErrorObject(new Error("secret internal detail: SELECT * FROM users"), "req_2");
    expect(out.error.code).toBe("INTERNAL_ERROR");
    expect(out.error.message).not.toContain("SELECT * FROM users");
    expect(out.error.requestId).toBe("req_2");
  });

  test("non-error values are wrapped", () => {
    const out = toErrorObject("boom", "req_3");
    expect(out.error.code).toBe("INTERNAL_ERROR");
  });
});
