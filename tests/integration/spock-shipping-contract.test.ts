import { describe, expect, it } from "vitest";
import { selectShippingChannel } from "@/lib/domain/orders/shipping";
// @ts-expect-error Local Node-only reference loader deliberately has no runtime app import.
import {
  loadShippingReference,
  readWorkflowRegistry,
  checkProcessorCoverage,
} from "../../scripts/cutover/spock-source.mjs";

const repository = process.env.SPOCK_REFERENCE_DIR;
describe.skipIf(!repository)(
  "pinned Spock shipping component contract (not workflow certification)",
  () => {
    it("keeps every non-Europa processor in the cutover inventory", () => {
      expect(() => checkProcessorCoverage(repository, readWorkflowRegistry())).not.toThrow();
      const incomplete = readWorkflowRegistry();
      incomplete.workflows = incomplete.workflows.filter(
        (w: { task: string }) => w.task !== "gps-individual"
      );
      expect(() => checkProcessorCoverage(repository, incomplete)).toThrow(
        "Untracked Spock capability"
      );
    });
    it("compares both production decisions for the same inputs", () => {
      const reference = loadShippingReference(repository, readWorkflowRegistry().spockRevision);
      for (const tags of [
        null,
        "",
        "normal",
        "expedited shipping",
        " EXPRESS, Expedited Shipping , vip",
        "not expedited shipping",
        "expedited shipping,expedited shipping",
      ]) {
        for (const isUkWarehouse of [true, false]) {
          expect(
            selectShippingChannel({
              tags,
              isUkWarehouse,
              standardChannel: isUkWarehouse ? "RS-RM-UK" : "IM8-GLOBAL-STANDARD",
              expeditedChannel: "RS-DPDZONE1",
            })
          ).toBe(reference(tags, isUkWarehouse ? "GPS UK Warehouse" : "GPS Warehouse"));
        }
      }
    });
  }
);
