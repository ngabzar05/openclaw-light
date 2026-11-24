// Mobile boot profile (fork: A1) — single-switch resolution tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_BOOT_DISABLED,
  MOBILE_BOOT_ENV_VAR,
  resolveMobileBootOptions,
} from "./mobile-boot.js";

describe("resolveMobileBootOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["1", "true", "yes", "on", "TRUE", "Yes"])(
    "enables the profile for truthy value %s",
    (value) => {
      expect(resolveMobileBootOptions({ [MOBILE_BOOT_ENV_VAR]: value })).toEqual({
        enabled: true,
      });
    },
  );

  it.each([undefined, "", "0", "false", "no", "off", "maybe"])(
    "keeps the profile disabled for value %s",
    (value) => {
      const env = value === undefined ? {} : { [MOBILE_BOOT_ENV_VAR]: value };
      expect(resolveMobileBootOptions(env)).toEqual({ enabled: false });
    },
  );

  it("reads process.env when no env is passed", () => {
    vi.stubEnv(MOBILE_BOOT_ENV_VAR, "1");
    expect(resolveMobileBootOptions()).toEqual({ enabled: true });
    vi.stubEnv(MOBILE_BOOT_ENV_VAR, "0");
    expect(resolveMobileBootOptions()).toEqual({ enabled: false });
  });

  it("never mutates the env it reads", () => {
    const env = { [MOBILE_BOOT_ENV_VAR]: "1", OTHER: "keep" };
    resolveMobileBootOptions(env);
    expect(env).toEqual({ [MOBILE_BOOT_ENV_VAR]: "1", OTHER: "keep" });
  });
});

describe("mobile boot constants", () => {
  it("uses OPENCLAW_MOBILE_BOOT as the single switch", () => {
    expect(MOBILE_BOOT_ENV_VAR).toBe("OPENCLAW_MOBILE_BOOT");
  });

  it("defines the disabled profile as pure upstream behavior", () => {
    expect(MOBILE_BOOT_DISABLED).toEqual({ enabled: false });
  });
});
