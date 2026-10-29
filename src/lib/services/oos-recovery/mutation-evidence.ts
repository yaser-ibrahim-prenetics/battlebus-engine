import type * as dynamics from "@/lib/clients/dynamics";
import type * as gps from "@/lib/clients/gps";
import {
  hasThkInvoiceVoucherPosted,
  isThkWarehouseOrSiteDimensionWarning,
} from "@/lib/helpers/d365-thk-fulfilment";

export type OosMutationEvidenceCodec<T> = {
  encode: (result: T) => unknown;
  decode: (evidence: unknown) => T;
};

export const stringMutationEvidenceCodec: OosMutationEvidenceCodec<string> = {
  encode: (value) => ({ value }),
  decode: (evidence) => {
    const value = (evidence as { value?: unknown })?.value;
    if (typeof value !== "string" || !value.trim()) throw new Error("Invalid string evidence");
    return value;
  },
};

type GpsOutboundOrderResult = Awaited<ReturnType<typeof gps.createOutboundOrder>>;

export const gpsOutboundOrderEvidenceCodec: OosMutationEvidenceCodec<GpsOutboundOrderResult> = {
  encode: (value) => ({ orderNo: value.response.data?.[0]?.orderNo }),
  decode: (evidence) => {
    const orderNo = (evidence as { orderNo?: unknown })?.orderNo;
    if (typeof orderNo !== "string" || !orderNo.trim()) {
      throw new Error("Invalid GPS order evidence");
    }
    return { response: { data: [{ orderNo }] }, request: {} } as GpsOutboundOrderResult;
  },
};

type D365FulfillmentResult = Awaited<ReturnType<typeof dynamics.createFulfilment>>;

function normalizedD365ReplayMessage(message: string): string {
  const signals: string[] = [];
  if (isThkWarehouseOrSiteDimensionWarning(message)) {
    signals.push("Dimension warehouse is still specified");
  }
  if (hasThkInvoiceVoucherPosted(message)) {
    signals.push("Number of vouchers posted to the journal: 1");
  }
  return signals.length ? signals.join(";") : "FULFILMENT_ACCEPTED";
}

export const d365FulfillmentEvidenceCodec: OosMutationEvidenceCodec<D365FulfillmentResult> = {
  encode: (value) => ({
    response: {
      status: value.response.status,
      Message: normalizedD365ReplayMessage(value.response.Message),
      Result: "FULFILMENT_ACCEPTED",
      $id: "replayed",
    },
  }),
  decode: (evidence) => {
    const response = (evidence as { response?: unknown })?.response as
      | { status?: unknown; Message?: unknown; Result?: unknown; $id?: unknown }
      | undefined;
    if (
      response?.status !== 1 ||
      typeof response.Message !== "string" ||
      typeof response.Result !== "string" ||
      typeof response.$id !== "string"
    ) {
      throw new Error("Invalid D365 fulfillment evidence");
    }
    return { response, request: {} } as D365FulfillmentResult;
  },
};

type DepositInvoiceResult = Awaited<
  ReturnType<typeof dynamics.assertDepositShipmentInvoicingComplete>
>;

export const depositInvoiceEvidenceCodec: OosMutationEvidenceCodec<DepositInvoiceResult> = {
  encode: (value) => ({
    verified: value.verified,
    processingStatus:
      typeof value.processingStatus === "string"
        ? value.processingStatus.trim().slice(0, 128)
        : null,
  }),
  decode: (evidence) => {
    const value = evidence as { verified?: unknown; processingStatus?: unknown };
    if (
      value?.verified !== true ||
      (value.processingStatus !== null && typeof value.processingStatus !== "string")
    ) {
      throw new Error("Invalid deposit invoice evidence");
    }
    return value as DepositInvoiceResult;
  },
};
