import { describe, it, expect } from "vitest";
import {
  isCli,
  normalizeCli,
  isClaudeCli,
  isBedrockCli,
  isPersonalClaudeCli,
  isLocalClaudeCli,
  DEFAULT_CLI,
  CLI_VALUES,
} from "../../lib/clis";

describe("isCli", () => {
  it("returns true for valid CLI values", () => {
    for (const cli of CLI_VALUES) {
      expect(isCli(cli)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isCli("claude")).toBe(false);
    expect(isCli("gpt-4")).toBe(false);
    expect(isCli("")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(isCli(null)).toBe(false);
    expect(isCli(42)).toBe(false);
    expect(isCli(undefined)).toBe(false);
  });
});

describe("normalizeCli", () => {
  it("maps legacy 'claude' to 'claude-bedrock'", () => {
    expect(normalizeCli("claude")).toBe("claude-bedrock");
  });

  it("passes through valid CLI values unchanged", () => {
    for (const cli of CLI_VALUES) {
      expect(normalizeCli(cli)).toBe(cli);
    }
  });

  it("falls back to DEFAULT_CLI for unknown values", () => {
    expect(normalizeCli("unknown")).toBe(DEFAULT_CLI);
    expect(normalizeCli(null)).toBe(DEFAULT_CLI);
    expect(normalizeCli(undefined)).toBe(DEFAULT_CLI);
  });

  it("uses provided fallback for unknown values", () => {
    expect(normalizeCli("bad", "codex")).toBe("codex");
  });
});

describe("isClaudeCli", () => {
  it("returns true for all claude variants", () => {
    expect(isClaudeCli("claude-bedrock")).toBe(true);
    expect(isClaudeCli("claude-personal")).toBe(true);
    expect(isClaudeCli("claude-local")).toBe(true);
    expect(isClaudeCli("claude")).toBe(true); // legacy alias
  });

  it("returns false for codex", () => {
    expect(isClaudeCli("codex")).toBe(false);
  });
});

describe("isBedrockCli / isPersonalClaudeCli / isLocalClaudeCli", () => {
  it("isBedrockCli matches only bedrock", () => {
    expect(isBedrockCli("claude-bedrock")).toBe(true);
    expect(isBedrockCli("claude-personal")).toBe(false);
    expect(isBedrockCli("claude")).toBe(true); // legacy maps to bedrock
  });

  it("isPersonalClaudeCli matches only personal", () => {
    expect(isPersonalClaudeCli("claude-personal")).toBe(true);
    expect(isPersonalClaudeCli("claude-bedrock")).toBe(false);
  });

  it("isLocalClaudeCli matches only local", () => {
    expect(isLocalClaudeCli("claude-local")).toBe(true);
    expect(isLocalClaudeCli("claude-bedrock")).toBe(false);
  });
});
