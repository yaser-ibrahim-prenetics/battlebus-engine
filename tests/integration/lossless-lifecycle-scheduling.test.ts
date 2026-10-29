import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FUNCTIONS_ROOT = join(__dirname, "../../src/inngest/functions");
const REQUIRED_LIFECYCLE_FUNCTIONS = [
  "process-order-cancellation.ts",
  "process-refund.ts",
  "process-shopify-fulfillment.ts",
  "process-gps-individual.ts",
  "process-shopify-order.ts",
  "process-subscription-order.ts",
];

describe("lossless lifecycle scheduling contract", () => {
  for (const filename of REQUIRED_LIFECYCLE_FUNCTIONS) {
    it(`${filename} paces work without discarding valid events`, () => {
      const source = readFileSync(join(FUNCTIONS_ROOT, filename), "utf8");
      expect(source).not.toMatch(/\brateLimit\s*:/);
      expect(source).toMatch(/\bconcurrency\s*:/);
      expect(source).toMatch(/\bthrottle\s*:/);
      expect(source).toMatch(/\bidempotency\s*:/);
    });
  }
});
