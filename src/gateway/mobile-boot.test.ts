// Mobile boot profile (fork: A1) — single-switch resolution tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_BOOT_DISABLED,
  MOBILE_BOOT_ENV_VAR,
  MOBILE_SINGLE_OWNER_ENV_VAR,
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
        singleOwner: false,
      });
    },
  );

  it.each([undefined, "", "0", "false", "no", "off", "maybe"])(
    "keeps the profile disabled for value %s",
    (value) => {
      const env = value === undefined ? {} : { [MOBILE_BOOT_ENV_VAR]: value };
      expect(resolveMobileBootOptions(env)).toEqual({ enabled: false, singleOwner: false });
    },
  );

  it("reads process.env when no env is passed", () => {
    vi.stubEnv(MOBILE_BOOT_ENV_VAR, "1");
    expect(resolveMobileBootOptions()).toEqual({ enabled: true, singleOwner: false });
    vi.stubEnv(MOBILE_BOOT_ENV_VAR, "0");
    expect(resolveMobileBootOptions()).toEqual({ enabled: false, singleOwner: false });
  });

  it("never mutates the env it reads", () => {
    const env = { [MOBILE_BOOT_ENV_VAR]: "1", OTHER: "keep" };
    resolveMobileBootOptions(env);
    expect(env).toEqual({ [MOBILE_BOOT_ENV_VAR]: "1", OTHER: "keep" });
  });
});

describe("resolveMobileBootOptions single-owner (F2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables singleOwner only when BOTH switches are set", () => {
    expect(
      resolveMobileBootOptions({
        [MOBILE_BOOT_ENV_VAR]: "1",
        [MOBILE_SINGLE_OWNER_ENV_VAR]: "1",
      }),
    ).toEqual({ enabled: true, singleOwner: true });
  });

  it.each(["0", "false", "off", ""])("keeps singleOwner off when its own value is %s", (value) => {
    expect(
      resolveMobileBootOptions({
        [MOBILE_BOOT_ENV_VAR]: "1",
        [MOBILE_SINGLE_OWNER_ENV_VAR]: value,
      }),
    ).toEqual({ enabled: true, singleOwner: false });
  });

  it("ignores a lone OPENCLAW_MOBILE_SINGLE_OWNER=1 without A1", () => {
    expect(resolveMobileBootOptions({ [MOBILE_SINGLE_OWNER_ENV_VAR]: "1" })).toEqual({
      enabled: false,
      singleOwner: false,
    });
  });
});

describe("mobile boot constants", () => {
  it("uses OPENCLAW_MOBILE_BOOT as the single switch", () => {
    expect(MOBILE_BOOT_ENV_VAR).toBe("OPENCLAW_MOBILE_BOOT");
  });

  it("uses OPENCLAW_MOBILE_SINGLE_OWNER as the F2 switch", () => {
    expect(MOBILE_SINGLE_OWNER_ENV_VAR).toBe("OPENCLAW_MOBILE_SINGLE_OWNER");
  });

  it("defines the disabled profile as pure upstream behavior", () => {
    expect(MOBILE_BOOT_DISABLED).toEqual({ enabled: false, singleOwner: false });
  });
});
