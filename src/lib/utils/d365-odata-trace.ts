/**
 * Structured D365 OData read logs (refund resolution, etc.).
 * Cloud Logging / Inngest: filter by `D365ODataTrace` or `RefundTraceLifecycle`.
 */
export type D365ODataTraceContext = {
  refundId?: string;
  shopifyOrderId?: string;
  inngestRunId?: string;
};

export function logD365ODataTrace(fields: D365ODataTraceContext & Record<string, unknown>): void {
  console.log(JSON.stringify({ msg: "D365ODataTrace", ...fields }));
}

export function logRefundTraceLifecycle(
  fields: D365ODataTraceContext & Record<string, unknown>
): void {
  console.log(JSON.stringify({ msg: "RefundTraceLifecycle", ...fields }));
}
