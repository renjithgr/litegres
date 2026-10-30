import { describe, expect, test } from "bun:test";
import { loadConfig, validateConfig, defaultConfig, cliOverridesToConfig } from "../../src/config/config";
import { ApiError } from "../../src/api/errors";

describe("configuration", () => {
  test("defaults apply when nothing is provided", () => {
    const cfg = loadConfig({ env: {}, cli: {} });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(49100);
    expect(cfg.maxDatabases).toBe(32);
    expect(cfg.maxTemplates).toBe(8);
    expect(cfg.defaultDatabaseTtlSeconds).toBe(600);
    expect(cfg.defaultSessionTtlSeconds).toBe(1800);
  });

  test("environment variables override defaults", () => {
    const cfg = loadConfig({
      env: {
        LITEGRES_PORT: "49999",
        LITEGRES_MAX_DATABASES: "4",
        LITEGRES_MAX_TEMPLATES: "2",
        LITEGRES_RUNTIME_DIR: "/tmp/x",
      },
      cli: {},
    });
    expect(cfg.port).toBe(49999);
    expect(cfg.maxDatabases).toBe(4);
    expect(cfg.maxTemplates).toBe(2);
    expect(cfg.runtimeDir).toBe("/tmp/x");
  });

  test("CLI overrides beat environment variables", () => {
    const cfg = loadConfig({
      env: { LITEGRES_PORT: "49999" },
      cli: cliOverridesToConfig({ port: 50001 }),
    });
    expect(cfg.port).toBe(50001);
  });

  test("config file is honored below env and CLI", () => {
    const file = JSON.stringify({ port: 49995, maxDatabases: 5 });
    const cfg = loadConfig({ env: {}, cli: { configFile: "cfg.json" }, readFile: () => file });
    expect(cfg.port).toBe(49995);
    expect(cfg.maxDatabases).toBe(5);
    // env beats file
    const cfg2 = loadConfig({
      env: { LITEGRES_PORT: "49996" },
      cli: { configFile: "cfg.json" },
      readFile: () => file,
    });
    expect(cfg2.port).toBe(49996);
    expect(cfg2.maxDatabases).toBe(5);
    // CLI beats env
    const cfg3 = loadConfig({
      env: { LITEGRES_PORT: "49996" },
      cli: { configFile: "cfg.json", port: 49997 },
      readFile: () => file,
    });
    expect(cfg3.port).toBe(49997);
  });

  test("non-local host is rejected by default", () => {
    expect(() => validateConfig({ ...defaultConfig(), host: "0.0.0.0" })).toThrow(ApiError);
    expect(() => validateConfig({ ...defaultConfig(), host: "0.0.0.0", rejectNonLocalBind: false })).not.toThrow();
  });

  test("invalid values fail with actionable errors", () => {
    expect(() => validateConfig({ ...defaultConfig(), maxDatabases: 0 })).toThrow(/maxDatabases/);
    expect(() => validateConfig({ ...defaultConfig(), port: 70000 })).toThrow(/port/);
    expect(() =>
      validateConfig({ ...defaultConfig(), maximumDatabaseTtlSeconds: 10, defaultDatabaseTtlSeconds: 600 }),
    ).toThrow(/maximumDatabaseTtlSeconds/);
    expect(() => validateConfig({ ...defaultConfig(), logLevel: "loud" })).toThrow(/logLevel/);
  });

  test("missing config file is reported", () => {
    expect(() => loadConfig({ env: { LITEGRES_CONFIG_FILE: "/nonexistent.json" }, cli: {}, readFile: () => undefined })).toThrow(
      ApiError,
    );
  });

  test("malformed config file is reported", () => {
    expect(() =>
      loadConfig({ env: {}, cli: { configFile: "cfg.json" }, readFile: () => "{not json" }),
    ).toThrow(/Invalid configuration file/);
  });

  test("invalid env integers are rejected", () => {
    expect(() => loadConfig({ env: { LITEGRES_PORT: "abc" }, cli: {} })).toThrow(/LITEGRES_PORT/);
  });

  test("public endpoint overrides default to none", () => {
    const cfg = defaultConfig();
    expect(cfg.publicHost).toBeUndefined();
    expect(cfg.publicPort).toBeUndefined();
  });

  test("public host and port can be configured via env and CLI", () => {
    const fromEnv = loadConfig({
      env: { LITEGRES_PUBLIC_HOST: "localhost", LITEGRES_PUBLIC_PORT: "5433" },
      cli: {},
    });
    expect(fromEnv.publicHost).toBe("localhost");
    expect(fromEnv.publicPort).toBe(5433);

    const fromCli = loadConfig({
      env: {},
      cli: cliOverridesToConfig({ "public-host": "127.0.0.1", "public-port": 5434 }),
    });
    expect(fromCli.publicHost).toBe("127.0.0.1");
    expect(fromCli.publicPort).toBe(5434);
  });

  test("public port validation rejects bad values", () => {
    expect(() => validateConfig({ ...defaultConfig(), publicPort: 0 })).toThrow(/publicPort/);
    expect(() => validateConfig({ ...defaultConfig(), publicPort: 70000 })).toThrow(/publicPort/);
  });

  test("docker-friendly configuration validates", () => {
    const cfg = validateConfig({
      ...defaultConfig(),
      host: "0.0.0.0",
      rejectNonLocalBind: false,
      publicHost: "localhost",
      publicPort: 5432,
    });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.publicHost).toBe("localhost");
    expect(cfg.publicPort).toBe(5432);
  });

  test("PostgreSQL server settings default sensibly and come from env and CLI", () => {
    const d = defaultConfig();
    expect(d.postgresUrl).toBeUndefined();
    expect(d.postgresDocker).toBe(true);
    expect(d.keepPostgres).toBe(false);
    expect(d.postgresImage).toBe("postgres:17-alpine");
    expect(d.namePrefix).toBe("litegres_");

    const fromEnv = loadConfig({
      env: {
        LITEGRES_POSTGRES_URL: "postgresql://u:p@db:5432/postgres",
        LITEGRES_POSTGRES_DOCKER: "false",
        LITEGRES_NAME_PREFIX: "ci_",
      },
      cli: {},
    });
    expect(fromEnv.postgresUrl).toBe("postgresql://u:p@db:5432/postgres");
    expect(fromEnv.postgresDocker).toBe(false);
    expect(fromEnv.namePrefix).toBe("ci_");

    const fromCli = loadConfig({
      env: { LITEGRES_NAME_PREFIX: "ci_" },
      cli: cliOverridesToConfig({ "postgres-url": "postgres://x@y/z", "name-prefix": "cli_", "keep-postgres": true }),
    });
    expect(fromCli.postgresUrl).toBe("postgres://x@y/z");
    expect(fromCli.namePrefix).toBe("cli_"); // CLI beats env
    expect(fromCli.keepPostgres).toBe(true);
  });

  test("PostgreSQL server settings are validated", () => {
    expect(() => validateConfig({ ...defaultConfig(), postgresUrl: "mysql://x" })).toThrow(/postgresUrl/);
    expect(() => validateConfig({ ...defaultConfig(), namePrefix: "Bad-Prefix" })).toThrow(/namePrefix/);
    expect(() => validateConfig({ ...defaultConfig(), namePrefix: "" })).toThrow(/namePrefix/);
  });
});
