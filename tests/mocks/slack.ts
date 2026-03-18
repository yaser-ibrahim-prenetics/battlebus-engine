import { vi } from "vitest";

export interface SlackMessage {
  channel: string;
  level: "info" | "warning" | "error" | "order";
  message: string;
}

let messages: SlackMessage[] = [];

export function resetMockSlack() {
  messages = [];
}

export function getSlackMessages() {
  return [...messages];
}

export const mockSlack = {
  sendInfoMessage: vi.fn(async (channel: string, message: string) => {
    messages.push({ channel, level: "info", message });
  }),
  sendWarningMessage: vi.fn(async (channel: string, message: string) => {
    messages.push({ channel, level: "warning", message });
  }),
  sendErrorMessage: vi.fn(async (channel: string, message: string) => {
    messages.push({ channel, level: "error", message });
  }),
  sendOrderMessage: vi.fn(async (channel: string, message: string) => {
    messages.push({ channel, level: "order", message });
  }),
};

export function setupSlackMock() {
  vi.doMock("@/lib/clients/slack", () => mockSlack);
}
