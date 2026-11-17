import { describe, expect, it } from "vitest";
import {
  FlagError,
  collectFlag,
  parseExitThreshold,
  parseFormats,
  parseNumberFlag,
  validateWinsReport,
} from "../src/index-flags.js";

describe("parseNumberFlag", () => {
  it("passes undefined/empty and valid numbers", () => {
    expect(parseNumberFlag("min-bytes", undefined)).toBeUndefined();
    expect(parseNumberFlag("min-bytes", "")).toBeUndefined();
    expect(parseNumberFlag("min-bytes", "1500")).toBe(1500);
    expect(parseNumberFlag("min-bytes", "0")).toBe(0);
  });
  it("rejects NaN, Infinity, negatives", () => {
    for (const v of ["abc", "Infinity", "-1", "NaN"]) {
      expect(() => parseNumberFlag("budget-route", v)).toThrow(FlagError);
    }
    expect(() => parseNumberFlag("budget-route", "x")).toThrow(/--budget-route/);
  });
});

describe("parseFormats / parseExitThreshold", () => {
  it("accepts allowlisted values", () => {
    expect(parseFormats("json, md")).toEqual(["json", "md"]);
    expect(parseExitThreshold("warning")).toBe("warning");
  });
  it("rejects others", () => {
    expect(() => parseFormats("json,xml")).toThrow(FlagError);
    expect(() => parseFormats("")).toThrow(FlagError);
    expect(() => parseExitThreshold("fatal")).toThrow(FlagError);
  });
});

describe("validateWinsReport", () => {
  it("accepts a report shape and rejects junk", () => {
    expect(validateWinsReport({ routes: [], wins: [] }, "x").wins).toEqual([]);
    expect(() => validateWinsReport({}, "x")).toThrow(FlagError);
    expect(() => validateWinsReport(null, "x")).toThrow(FlagError);
  });
});

describe("collectFlag", () => {
  it("collects every occurrence in both forms", () => {
    expect(collectFlag(["--url", "a", "--cwd", "x", "--url=b,c", "--url", "d"], "url")).toEqual(["a", "b,c", "d"]);
  });
  it("ignores other flags, missing values and everything after --", () => {
    expect(collectFlag(["--urls-file", "f", "--url", "--json", "--", "--url", "z"], "url")).toEqual([]);
    expect(collectFlag([], "url")).toEqual([]);
  });
});
