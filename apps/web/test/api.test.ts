// Unit tests for the fragment/token helpers and the cache-busting reload.
// window and history are stubbed per test: these helpers only ever touch
// location.href, location.replace and history.replaceState.

import { afterEach, describe, expect, test } from "bun:test";
import { dropReloadParam, reloadForBuild, tokenFromFragment } from "../src/lib/api.ts";

interface Stub {
  replaced: string[];
  pushed: string[];
}

function stubBrowser(href: string): Stub {
  const stub: Stub = { replaced: [], pushed: [] };
  const url = new URL(href);
  (globalThis as unknown as Record<string, unknown>)["window"] = {
    location: {
      href,
      hash: url.hash,
      pathname: url.pathname,
      search: url.search,
      replace: (u: string) => stub.replaced.push(u),
    },
  };
  (globalThis as unknown as Record<string, unknown>)["history"] = {
    replaceState: (_s: unknown, _t: string, u: string) => stub.pushed.push(u),
  };
  return stub;
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)["window"];
  delete (globalThis as unknown as Record<string, unknown>)["history"];
});

describe("tokenFromFragment", () => {
  test("reads the token the server prints in the fragment", () => {
    expect(tokenFromFragment("#abc123_-XY")).toBe("abc123_-XY");
  });

  test("reads a token given without the leading hash", () => {
    expect(tokenFromFragment("abc123")).toBe("abc123");
  });

  test("returns empty for a route fragment, which is not a token", () => {
    expect(tokenFromFragment("#/review")).toBe("");
    expect(tokenFromFragment("#/reflections/some-pattern")).toBe("");
  });

  test("returns empty for no fragment at all", () => {
    expect(tokenFromFragment("")).toBe("");
    expect(tokenFromFragment("#")).toBe("");
  });
});

describe("reloadForBuild", () => {
  test("reloads with the new build as the cache-busting param", () => {
    const stub = stubBrowser("http://localhost:8766/#/review");
    reloadForBuild("deadbeef");
    expect(stub.replaced).toHaveLength(1);
    const url = new URL(stub.replaced[0]!);
    expect(url.searchParams.get("r")).toBe("deadbeef");
  });

  test("keeps the route fragment, so the reload lands on the same pane", () => {
    const stub = stubBrowser("http://localhost:8766/#/review");
    reloadForBuild("deadbeef");
    expect(new URL(stub.replaced[0]!).hash).toBe("#/review");
  });

  test("falls back to a timestamp when there is no build hash", () => {
    const stub = stubBrowser("http://localhost:8766/");
    reloadForBuild(null);
    expect(Number(new URL(stub.replaced[0]!).searchParams.get("r"))).toBeGreaterThan(0);
  });

  test("replaces an older r param instead of appending a second one", () => {
    const stub = stubBrowser("http://localhost:8766/?r=old#/loop");
    reloadForBuild("new");
    expect(stub.replaced[0]).toContain("r=new");
    expect(stub.replaced[0]).not.toContain("r=old");
  });
});

describe("dropReloadParam", () => {
  test("takes r back out of the visible URL and keeps the route", () => {
    const stub = stubBrowser("http://localhost:8766/?r=deadbeef#/review");
    dropReloadParam();
    expect(stub.pushed).toEqual(["/#/review"]);
  });

  test("does nothing when there is no r param", () => {
    const stub = stubBrowser("http://localhost:8766/#/review");
    dropReloadParam();
    expect(stub.pushed).toEqual([]);
  });
});
