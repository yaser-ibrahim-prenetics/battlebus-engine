"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Papa from "papaparse";

type ShopifyDetail = {
  body: any;
  topic?: string;
  hmac?: string;
  store?: string;
  eventId?: string;
  shopDomain?: string;
  shopifyOrderId?: number;
  shopifyOrderName?: string;
  [key: string]: any;
};

type CsvRow = {
  datetime: string;
  detail: string;
  taskid?: string;
  [key: string]: string | undefined;
};

type ReplayEvent = {
  index: number;
  timestamp: Date;
  detail: ShopifyDetail;
  raw: CsvRow;
};

type EventStatus = "pending" | "sending" | "sent" | "error";

type RecentItem = {
  index: number;
  datetime: string;
  topic: string;
  orderId: string;
  status: EventStatus;
  error?: string;
};

const MAX_RECENT = 200;

export default function ReplayPage() {
  const [csvUrl, setCsvUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loadingCsv, setLoadingCsv] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);

  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState<
    "idle" | "ready" | "running" | "paused" | "stopped" | "completed"
  >("idle");

  const [totalSent, setTotalSent] = useState(0);
  const [totalErrors, setTotalErrors] = useState(0);

  const [recent, setRecent] = useState<RecentItem[]>([]);

  const timeoutRef = useRef<number | null>(null);
  const abortRef = useRef(false);

  const reset = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = null;
    abortRef.current = false;
    setEvents([]);
    setCurrentIndex(0);
    setStatus("idle");
    setTotalSent(0);
    setTotalErrors(0);
    setRecent([]);
    setParseProgress(0);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const parseDateTime = (value: string): Date | null => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  };

  const loadCsv = useCallback(async () => {
    if (!csvUrl && !file) return;

    reset();
    setLoadingCsv(true);

    const rows: ReplayEvent[] = [];
    let index = 0;

    const handleRow = (row: CsvRow) => {
      if (!row.detail || !row.datetime) return;

      let detail: ShopifyDetail;
      try {
        detail = JSON.parse(row.detail) as ShopifyDetail;
      } catch {
        return;
      }

      const ts = parseDateTime(row.datetime);
      if (!ts) return;

      rows.push({
        index,
        timestamp: ts,
        detail,
        raw: row,
      });

      index += 1;
      if (index % 1000 === 0) {
        setParseProgress(index);
      }
    };

    const parsePromise = new Promise<void>((resolve, reject) => {
      const config: Papa.ParseConfig<CsvRow> = {
        header: true,
        skipEmptyLines: true,
        worker: true,
        step: (results, parser) => {
          if (abortRef.current) {
            parser.abort();
            return;
          }
          const row = results.data;
          handleRow(row);
        },
        complete: () => resolve(),
        error: (err) => reject(err),
      };

      if (file) {
        Papa.parse<CsvRow>(file, config);
      } else if (csvUrl) {
        Papa.parse<CsvRow>(csvUrl, { ...config, download: true });
      }
    });

    try {
      await parsePromise;
      if (abortRef.current) {
        setLoadingCsv(false);
        return;
      }

      rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      setEvents(rows);
      setStatus(rows.length > 0 ? "ready" : "idle");
      setParseProgress(rows.length);
    } catch (error) {
      console.error("Error parsing CSV", error);
      reset();
    } finally {
      setLoadingCsv(false);
    }
  }, [csvUrl, file, reset]);

  const recordRecent = useCallback((item: RecentItem) => {
    setRecent((prev) => {
      const next = [item, ...prev];
      if (next.length > MAX_RECENT) {
        return next.slice(0, MAX_RECENT);
      }
      return next;
    });
  }, []);

  const sendEvent = useCallback(
    async (event: ReplayEvent) => {
      const { detail, timestamp } = event;
      const topic = detail.topic || "orders/updated";
      const shopDomain = detail.shopDomain || "im8store.myshopify.com";
      const orderId =
        (detail.body && (detail.body.id || detail.body.order_id)) ?? "n/a";

      recordRecent({
        index: event.index,
        datetime: timestamp.toISOString(),
        topic,
        orderId: String(orderId),
        status: "sending",
      });

      try {
        const res = await fetch("/api/replay/shoot-webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic,
            shopDomain,
            hmac: detail.hmac,
            webhookId: detail.eventId || event.raw.taskid,
            apiVersion: detail.apiVersion,
            payload: detail.body,
          }),
        });

        const ok = res.ok;
        if (!ok) {
          setTotalErrors((prev) => prev + 1);
          recordRecent({
            index: event.index,
            datetime: timestamp.toISOString(),
            topic,
            orderId: String(orderId),
            status: "error",
            error: `HTTP ${res.status}`,
          });
        } else {
          setTotalSent((prev) => prev + 1);
          recordRecent({
            index: event.index,
            datetime: timestamp.toISOString(),
            topic,
            orderId: String(orderId),
            status: "sent",
          });
        }
      } catch (error: any) {
        setTotalErrors((prev) => prev + 1);
        recordRecent({
          index: event.index,
          datetime: timestamp.toISOString(),
          topic,
          orderId: String(orderId),
          status: "error",
          error: String(error?.message || error),
        });
      }
    },
    [recordRecent]
  );

  const scheduleNext = useCallback(() => {
    if (abortRef.current) return;
    if (status !== "running") return;

    setCurrentIndex((prevIndex) => {
      if (prevIndex >= events.length) {
        setStatus("completed");
        return prevIndex;
      }

      const currentEvent = events[prevIndex];
      const prevEvent = prevIndex === 0 ? null : events[prevIndex - 1];

      const delay =
        prevEvent == null
          ? 0
          : Math.max(
              0,
              currentEvent.timestamp.getTime() - prevEvent.timestamp.getTime()
            );

      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = window.setTimeout(async () => {
        await sendEvent(currentEvent);
        scheduleNext();
      }, delay);

      return prevIndex + 1;
    });
  }, [events, sendEvent, status]);

  const handleStart = () => {
    if (!events.length) return;
    abortRef.current = false;
    setStatus("running");
    scheduleNext();
  };

  const handlePause = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setStatus("paused");
  };

  const handleResume = () => {
    if (!events.length) return;
    setStatus("running");
    scheduleNext();
  };

  const handleStop = () => {
    abortRef.current = true;
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setStatus("stopped");
  };

  const total = events.length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-950 text-slate-50">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="relative z-10 max-w-5xl mx-auto px-6 py-10 space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-white via-indigo-200 to-purple-200">
            Shopify Webhook Replay
          </h1>
          <p className="text-sm text-indigo-200/70 max-w-2xl">
            Load a large CSV of recorded webhooks and replay them against Battle
            Bus, preserving the original time gaps. Optimised to run timing in
            the browser while Vercel functions send individual webhooks.
          </p>
        </header>

        <section className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2 bg-slate-900/60 border border-indigo-500/20 rounded-2xl p-5 space-y-4 backdrop-blur-xl">
            <h2 className="text-sm font-semibold text-slate-100">
              CSV Source
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Remote CSV URL (e.g. Vercel Blob, S3)
                </label>
                <input
                  type="url"
                  value={csvUrl}
                  onChange={(e) => setCsvUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-slate-400 mb-1">
                    Or upload CSV file
                  </label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) =>
                      setFile(e.target.files ? e.target.files[0] : null)
                    }
                    className="block w-full text-xs text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-indigo-600 file:text-white hover:file:bg-indigo-500"
                  />
                </div>

                <button
                  onClick={loadCsv}
                  disabled={loadingCsv || (!csvUrl && !file)}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-sm font-medium"
                >
                  {loadingCsv ? "Loading..." : "Load CSV"}
                </button>
              </div>

              {parseProgress > 0 && (
                <p className="text-xs text-slate-400">
                  Parsed rows:{" "}
                  <span className="font-mono text-indigo-300">
                    {parseProgress.toLocaleString()}
                  </span>
                </p>
              )}

              <p className="text-[11px] text-slate-500">
                Expected headers:{" "}
                <code className="font-mono text-indigo-300">
                  datetime
                </code>{" "}
                and{" "}
                <code className="font-mono text-indigo-300">
                  detail
                </code>{" "}
                (JSON payload with{" "}
                <code className="font-mono">body, topic, hmac, shopDomain</code>
                ).
              </p>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-emerald-500/20 rounded-2xl p-5 space-y-4 backdrop-blur-xl">
            <h2 className="text-sm font-semibold text-slate-100">Controls</h2>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleStart}
                disabled={status === "running" || !events.length}
                className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-sm font-medium"
              >
                Start
              </button>
              <button
                onClick={handlePause}
                disabled={status !== "running"}
                className="flex-1 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-sm font-medium"
              >
                Pause
              </button>
              <button
                onClick={handleResume}
                disabled={status !== "paused"}
                className="flex-1 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-sm font-medium"
              >
                Resume
              </button>
              <button
                onClick={handleStop}
                disabled={status === "idle" || status === "completed"}
                className="w-full px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 text-sm font-medium"
              >
                Stop
              </button>
            </div>

            <div className="border-t border-slate-800 pt-3 space-y-2 text-xs">
              <p className="flex justify-between">
                <span className="text-slate-400">Status</span>
                <span className="font-mono text-indigo-300">{status}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-slate-400">Total events</span>
                <span className="font-mono text-slate-100">
                  {total.toLocaleString()}
                </span>
              </p>
              <p className="flex justify-between">
                <span className="text-slate-400">Sent</span>
                <span className="font-mono text-emerald-300">
                  {totalSent.toLocaleString()}
                </span>
              </p>
              <p className="flex justify-between">
                <span className="text-slate-400">Errors</span>
                <span className="font-mono text-rose-300">
                  {totalErrors.toLocaleString()}
                </span>
              </p>
              <p className="flex justify-between">
                <span className="text-slate-400">Next index</span>
                <span className="font-mono text-slate-100">
                  {currentIndex.toLocaleString()}
                </span>
              </p>
            </div>
          </div>
        </section>

        <section className="bg-slate-950/60 border border-slate-800 rounded-2xl p-5 backdrop-blur-xl">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-100">
              Recent events
            </h2>
            <span className="text-[11px] text-slate-500">
              Showing last {Math.min(MAX_RECENT, recent.length)} of{" "}
              {recent.length.toLocaleString()}
            </span>
          </div>

          <div className="overflow-auto max-h-[360px] rounded-xl border border-slate-800 bg-slate-950/70">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-900/80 text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Datetime (UTC)
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Topic</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Order ID
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((item) => (
                  <tr
                    key={item.index + item.status + item.datetime}
                    className="border-t border-slate-900/60"
                  >
                    <td className="px-3 py-1.5 font-mono text-slate-400">
                      {item.index}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-slate-300">
                      {item.datetime}
                    </td>
                    <td className="px-3 py-1.5 text-indigo-300 font-mono">
                      {item.topic}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-slate-200">
                      {item.orderId}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold " +
                          (item.status === "sent"
                            ? "bg-emerald-500/10 text-emerald-300"
                            : item.status === "error"
                            ? "bg-rose-500/10 text-rose-300"
                            : item.status === "sending"
                            ? "bg-amber-500/10 text-amber-300"
                            : "bg-slate-700/40 text-slate-300")
                        }
                      >
                        {item.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-rose-300">
                      {item.error}
                    </td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-slate-500"
                    >
                      No events yet. Load a CSV and start replay to see
                      progress here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}