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

  test("data-plane port range defaults to OS-assigned ports", () => {
    const cfg = defaultConfig();
    expect(cfg.dataPlanePortBase).toBe(49152);
    expect(cfg.dataPlanePortCount).toBe(0);
    expect(cfg.publicHost).toBeUndefined();
    expect(cfg.publicPortBase).toBeUndefined();
  });

  test("data-plane port range can be configured via env and CLI", () => {
    const fromEnv = loadConfig({
      env: {
        LITEGRES_DATA_PLANE_PORT_BASE: "50000",
        LITEGRES_DATA_PLANE_PORT_COUNT: "16",
        LITEGRES_PUBLIC_HOST: "localhost",
        LITEGRES_PUBLIC_PORT_BASE: "50000",
      },
      cli: {},
    });
    expect(fromEnv.dataPlanePortBase).toBe(50000);
    expect(fromEnv.dataPlanePortCount).toBe(16);
    expect(fromEnv.publicHost).toBe("localhost");
    expect(fromEnv.publicPortBase).toBe(50000);

    const fromCli = loadConfig({
      env: {},
      cli: cliOverridesToConfig({
        "data-plane-port-base": 51000,
        "data-plane-port-count": 8,
        "public-host": "127.0.0.1",
        "public-port-base": 52000,
      }),
    });
    expect(fromCli.dataPlanePortBase).toBe(51000);
    expect(fromCli.dataPlanePortCount).toBe(8);
    expect(fromCli.publicHost).toBe("127.0.0.1");
    expect(fromCli.publicPortBase).toBe(52000);
  });

  test("data-plane port range validation rejects bad values", () => {
    expect(() => validateConfig({ ...defaultConfig(), dataPlanePortBase: 0 })).toThrow(/dataPlanePortBase/);
    expect(() => validateConfig({ ...defaultConfig(), dataPlanePortCount: -1 })).toThrow(/dataPlanePortCount/);
    expect(() =>
      validateConfig({ ...defaultConfig(), dataPlanePortBase: 65000, dataPlanePortCount: 1000 }),
    ).toThrow(/65535/);
    // control port overlapping the data-plane range is rejected
    expect(() =>
      validateConfig({ ...defaultConfig(), port: 49152, dataPlanePortBase: 49152, dataPlanePortCount: 32 }),
    ).toThrow(/overlaps/);
    expect(() => validateConfig({ ...defaultConfig(), publicPortBase: 70000 })).toThrow(/publicPortBase/);
  });

  test("docker-friendly configuration validates", () => {
    const cfg = validateConfig({
      ...defaultConfig(),
      host: "0.0.0.0",
      rejectNonLocalBind: false,
      dataPlanePortBase: 49152,
      dataPlanePortCount: 32,
      publicHost: "localhost",
    });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.dataPlanePortCount).toBe(32);
    expect(cfg.publicHost).toBe("localhost");
  });
});
