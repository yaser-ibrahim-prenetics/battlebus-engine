import { vi } from "vitest";

export interface CsPlatformCall {
  method: string;
  args: any[];
}

let calls: CsPlatformCall[] = [];

export function resetMockCsPlatform() {
  calls = [];
}

export function getCsPlatformCalls() {
  return [...calls];
}

export const mockCsPlatform = {
  sendOrderUpdate: vi.fn(async (...args: any[]) => {
    calls.push({ method: "sendOrderUpdate", args });
  }),
  sendOrderCancelled: vi.fn(async (...args: any[]) => {
    calls.push({ method: "sendOrderCancelled", args });
  }),
  sendOrderFulfilled: vi.fn(async (...args: any[]) => {
    calls.push({ method: "sendOrderFulfilled", args });
  }),
  sendOrderRefunded: vi.fn(async (...args: any[]) => {
    calls.push({ method: "sendOrderRefunded", args });
  }),
};

export function setupCsPlatformMock() {
  vi.doMock("@/lib/clients/cs-platform", () => mockCsPlatform);
}
