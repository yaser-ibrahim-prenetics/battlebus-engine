import { describe, expect, it } from "vitest";

import { getAssociatedOrderLink } from "../order-linkage";

describe("getAssociatedOrderLink", () => {
  it("extracts associated order tags", () => {
    expect(getAssociatedOrderLink({ tags: "vip, im8-1234, newsletter" })).toEqual({
      orderName: "IM8-1234",
      relationship: "associated",
    });
  });

  it("normalizes replacement order tags", () => {
    expect(getAssociatedOrderLink({ tags: "replacement-IM8-9876" })).toEqual({
      orderName: "IM8-9876",
      relationship: "replacement",
    });
  });

  it("ignores unrelated tags", () => {
    expect(getAssociatedOrderLink({ tags: "subscription, vip" })).toBeNull();
  });
});
