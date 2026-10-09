import { describe, expect, it } from "vitest";
import { pagePath } from "../src/google";
import { alpha2 } from "../src/iso3";

describe("pagePath", () => {
  it("turns this site's URLs into dashboard paths, on any scheme and on www", () => {
    expect(pagePath("https://example.com/", "example.com")).toEqual({ path: "/", local: true });
    expect(pagePath("https://www.example.com/pricing?x=1", "example.com")).toEqual({ path: "/pricing?x=1", local: true });
    expect(pagePath("http://example.com/a/b", "example.com")).toEqual({ path: "/a/b", local: true });
  });
  it("keeps the host for other hosts in a domain property", () => {
    expect(pagePath("https://blog.example.com/post", "example.com")).toEqual({ path: "blog.example.com/post", local: false });
  });
  it("passes through things that aren't URLs", () => {
    expect(pagePath("not a url", "example.com")).toEqual({ path: "not a url", local: false });
  });
});

describe("alpha2", () => {
  it("maps Search Console's alpha-3 country codes", () => {
    expect(alpha2("gbr")).toBe("GB");
    expect(alpha2("usa")).toBe("US");
    expect(alpha2("ind")).toBe("IN");
    expect(alpha2("deu")).toBe("DE");
    expect(alpha2("xkk")).toBe("XK");
  });
  it("returns empty for unknown codes", () => {
    expect(alpha2("zzz")).toBe("");
  });
});
