import { vi } from "vitest";

export const mockPaypal = {
  isEnabled: vi.fn(() => false),
  syncTrackingBatch: vi.fn(async () => ({
    tracker_identifiers: [],
    errors: [],
  })),
};

export function setupPaypalMock() {
  vi.doMock("@/lib/clients/paypal", () => mockPaypal);
}
