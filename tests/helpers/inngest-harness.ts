import { vi } from "vitest";

export interface StepRecord {
  name: string;
  result: any;
  error?: Error;
}

export interface EmittedEvent {
  name: string;
  data: any;
}

export interface HarnessResult {
  result: any;
  steps: StepRecord[];
  events: EmittedEvent[];
}

export function createInngestHarness() {
  const steps: StepRecord[] = [];
  const events: EmittedEvent[] = [];
  let waitEventResponses: Map<string, any> = new Map();

  function setWaitEventResponse(stepName: string, response: any) {
    waitEventResponses.set(stepName, response);
  }

  const step = {
    run: vi.fn(async (name: string, fn: () => Promise<any>) => {
      try {
        const result = await fn();
        steps.push({ name, result });
        return result;
      } catch (error) {
        steps.push({ name, result: undefined, error: error as Error });
        throw error;
      }
    }),

    waitForEvent: vi.fn(async (name: string, _opts: any) => {
      const response = waitEventResponses.get(name) ?? null;
      steps.push({ name, result: response });
      return response;
    }),

    sleep: vi.fn(async (name: string, _duration: string) => {
      steps.push({ name, result: "slept" });
    }),

    sendEvent: vi.fn(async (name: string, event: any) => {
      events.push(event);
      steps.push({ name, result: event });
    }),
  };

  const inngestSend = vi.fn(async (event: EmittedEvent | EmittedEvent[]) => {
    const evts = Array.isArray(event) ? event : [event];
    events.push(...evts);
  });

  const mockInngest = {
    send: inngestSend,
  };

  return {
    step,
    inngestSend,
    mockInngest,
    steps,
    events,
    setWaitEventResponse,
    getStepNames: () => steps.map((s) => s.name),
    getStepResult: (name: string) => steps.find((s) => s.name === name)?.result,
    getStepError: (name: string) => steps.find((s) => s.name === name)?.error,
    hasStep: (name: string) => steps.some((s) => s.name === name),
    reset: () => {
      steps.length = 0;
      events.length = 0;
      waitEventResponses.clear();
      step.run.mockClear();
      step.waitForEvent.mockClear();
      step.sleep.mockClear();
      inngestSend.mockClear();
    },
  };
}
