import { vi } from "vitest";

export interface SlackMessage {
  channel: string;
  level: "info" | "warning" | "error" | "order";
  message: string;
  id: string;
}

let messages: SlackMessage[] = [];

export function resetMockSlack() {
  messages = [];
}

export function getSlackMessages() {
  return [...messages];
}

const record =
  (level: SlackMessage["level"]) => async (channel: string, message: string, id: string) => {
    messages.push({ channel, level, message, id });
  };

export const mockSlack = {
  sendInfoMessage: vi.fn(record("info")),
  sendWarningMessage: vi.fn(record("warning")),
  sendErrorMessage: vi.fn(record("error")),
  sendOrderMessage: vi.fn(record("order")),
  slackNotificationId: vi.fn((scope: string | undefined, purpose: string, ...parts: unknown[]) =>
    [scope ?? "unscoped", purpose, ...parts.filter((p) => p !== undefined && p !== null && p !== "")]
      .map(String)
      .join(":")
  ),
};

export function setupSlackMock() {
  vi.doMock("@/lib/clients/slack", () => mockSlack);
}
