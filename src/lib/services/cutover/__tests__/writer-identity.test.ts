import { beforeEach, expect, it, vi } from "vitest";
import { queryDatabase } from "@/lib/db/database";
import { assertReplayWriterIdentity } from "../evidence";
vi.mock("@/lib/db/database", () => ({ queryDatabase: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it.each([
  { replay_writer: false, runtime_writer: true },
  { replay_writer: true, runtime_writer: true },
  { replay_writer: false, runtime_writer: false },
])("rejects an unisolated writer: %j", async (identity) => {
  vi.mocked(queryDatabase).mockResolvedValue({ rows: [identity] } as never);
  await expect(assertReplayWriterIdentity()).rejects.toThrow("isolated replay-writer");
});
it("accepts only a dedicated replay identity", async () => {
  vi.mocked(queryDatabase).mockResolvedValue({
    rows: [{ replay_writer: true, runtime_writer: false }],
  } as never);
  await expect(assertReplayWriterIdentity()).resolves.toBeUndefined();
});
