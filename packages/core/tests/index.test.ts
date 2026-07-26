import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_NAME } from "../src/index.ts";

describe("@sarvamhack/core", () => {
  it("exports its package name", () => {
    expect(CORE_PACKAGE_NAME).toBe("@sarvamhack/core");
  });
});
