import * as dynamics from "@/lib/clients/dynamics";
import * as slack from "@/lib/clients/slack";
import { saveOrderLines, type OrderLineRecord } from "@/lib/services/order-lines";
import {
  calculateOrderCost,
  toD365SalesOrderHeaderV3,
  toD365SalesOrderLines,
  toOrderLineRecords,
} from "@/lib/transformers/order";
import { SlackChannelEnum } from "@/lib/types/slack";
import { retryWithBackoff } from "@/lib/utils/constants";
import type { ShopifyOrderPayload } from "../../events";
import {
  isD365ItemNotFoundError,
  isNonRetryableOrderError,
  isServiceSkuItemNumber,
} from "./error-classification";
import type { OrderPaymentAccounting } from "./payment-accounting";
import type { OrderLinesSupabaseSyncLog, PublishStatus, StepTools } from "./types";

export async function createD365Order({
  step,
  order,
  shopifyOrderId,
  shopifyOrderName,
  warehouseName,
  dataAreaId,
  skipD365,
  paymentAccounting,
  publishStatus,
}: {
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyOrderName: string;
  warehouseName: string;
  dataAreaId: string;
  skipD365: boolean;
  paymentAccounting: OrderPaymentAccounting;
  publishStatus: PublishStatus;
}) {
  // ── Step: create D365 header ───────────────────────────────────
  await publishStatus("d365.create-header", "running", "Creating D365 sales order header");
  const headerResult = await step.run("d365-create-header", async () => {
    const headerRequest = toD365SalesOrderHeaderV3(order, warehouseName, dataAreaId, {
      paymentReference: paymentAccounting.paymentReference,
      giftCardApplications: paymentAccounting.giftCardApplications,
      giftCardPurchases: paymentAccounting.giftCardPurchases,
    });
    let d365Header;
    if (skipD365) {
      d365Header = { SalesOrderNumber: `SKIP-${shopifyOrderId}`, request: headerRequest };
    } else {
      d365Header = await retryWithBackoff(() => dynamics.createSalesOrderHeaderV3(headerRequest), {
        label: `D365 header ${shopifyOrderName}`,
      });
    }
    const salesOrderNo = d365Header.SalesOrderNumber;
    if (!salesOrderNo) {
      throw new Error(`[D365] Missing SalesOrderNumber for ${shopifyOrderName}`);
    }
    return { salesOrderNo };
  });
  const salesOrderNo = headerResult.salesOrderNo;
  await publishStatus("d365.create-header", "completed", `Header created: ${salesOrderNo}`, {
    d365OrderNumber: salesOrderNo,
  });

  // ── Step: create D365 lines (parallel per-line creation) ────────
  const lineItems = toD365SalesOrderLines(
    order,
    salesOrderNo,
    warehouseName,
    true,
    dataAreaId,
    paymentAccounting.giftCardCodes
  );
  lineItems.forEach((item) => {
    item.dataAreaId = dataAreaId;
  });
  await publishStatus("d365.create-lines", "running", `Creating ${lineItems.length} line items`, {
    totalLines: lineItems.length,
  });

  const linesResult = await step.run("d365-create-lines", async () => {
    const d365InventoryLotsBySku: Record<string, string> = {};

    if (skipD365) {
      return {
        d365InventoryLotsBySku,
        skippedItemNumbers: [] as string[],
        skippedServiceLines: [] as Array<{ itemNumber: string; error: string }>,
      };
    }

    const invalidLines = lineItems
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          typeof line.itemNumber !== "string" ||
          line.itemNumber.trim().length === 0 ||
          !Number.isFinite(line.quantity) ||
          line.quantity <= 0
      );
    if (invalidLines.length > 0) {
      const details = invalidLines.slice(0, 5).map(({ line, index }) => ({
        index,
        itemNumber: line.itemNumber,
        quantity: line.quantity,
        price: line.price,
      }));
      throw new Error(
        `[D365] Missing SKU/ItemNumber in create-d365-lines for ${shopifyOrderName} (${salesOrderNo}); ` +
          `invalidLines=${invalidLines.length}; details=${JSON.stringify(details)} ` +
          `(missing SKU/ItemNumber is non-retryable)`
      );
    }

    const lineResults = await Promise.all(
      lineItems.map((line) =>
        (async () => {
          try {
            const created = await retryWithBackoff(
              () => dynamics.createSalesOrderLine({ ...line, salesOrderNumber: salesOrderNo }),
              {
                label: `D365 line ${line.itemNumber}`,
                shouldRetry: (err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  return !isNonRetryableOrderError(msg);
                },
              }
            );
            const lot = created?.InventoryLotId ? String(created.InventoryLotId).trim() : "";
            return {
              skipped: false as const,
              itemNumber: line.itemNumber,
              inventoryLotId: lot,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (isServiceSkuItemNumber(line.itemNumber) && isD365ItemNotFoundError(msg)) {
              console.warn(
                `[D365] Skipping missing service SKU line ${line.itemNumber} for ${salesOrderNo}: ${msg}`
              );
              return {
                skipped: true as const,
                itemNumber: line.itemNumber,
                error: msg,
              };
            }
            throw err;
          }
        })()
      )
    );

    const skippedServiceLines = lineResults.filter((r) => r.skipped);
    for (const r of lineResults) {
      if (r.skipped) continue;
      const sku = String(r.itemNumber || "")
        .trim()
        .toUpperCase();
      const lot = "inventoryLotId" in r ? String(r.inventoryLotId || "").trim() : "";
      if (sku && lot) {
        d365InventoryLotsBySku[sku] = lot;
      }
    }
    if (Object.keys(d365InventoryLotsBySku).length > 0) {
      console.log(
        `[D365] Captured InventoryLotId per SKU for ${salesOrderNo}:`,
        d365InventoryLotsBySku
      );
    }

    return {
      d365InventoryLotsBySku,
      skippedItemNumbers: lineResults
        .filter((r) => r.skipped)
        .map((r) => r.itemNumber.toUpperCase()),
      skippedServiceLines: skippedServiceLines.map((s) => ({
        itemNumber: s.itemNumber,
        error: "error" in s ? s.error : "",
      })),
    };
  });

  const d365InventoryLotsBySku = linesResult.d365InventoryLotsBySku;
  const skippedItemNumbers = new Set(linesResult.skippedItemNumbers);

  if (linesResult.skippedServiceLines.length > 0) {
    await publishStatus(
      "d365.create-lines",
      "running",
      `Skipped ${linesResult.skippedServiceLines.length} missing service SKU lines`,
      {
        skippedServiceSkus: linesResult.skippedServiceLines.map(
          (s: { itemNumber: string }) => s.itemNumber
        ),
        skippedCount: linesResult.skippedServiceLines.length,
      }
    );
  }

  // ── Step: persist order lines to Supabase ────────────────────────
  let orderLinesSupabase: OrderLinesSupabaseSyncLog;
  if (skipD365) {
    orderLinesSupabase = {
      attempted: false,
      skipReason: "dynamics_sync_disabled",
      d365LineCount: lineItems.length,
      note: "ENABLE_DYNAMICS_SYNC off — order_lines upsert skipped",
    };
  } else {
    orderLinesSupabase = await step.run("supabase-persist-order-lines", async () => {
      // Persist all order lines (product + service) to Supabase so fulfillment
      // can replay shipping/tax lines to Dynamics. Lot IDs come from D365's
      // createSalesOrderLine response, captured in the previous step.
      const lineRecords: OrderLineRecord[] = toOrderLineRecords(
        order,
        salesOrderNo,
        warehouseName,
        dataAreaId
      )
        .filter((r) => !skippedItemNumbers.has(r.d365ItemNumber.toUpperCase()))
        .map((r) => ({
          shopify_order_id: String(shopifyOrderId),
          shopify_order_name: shopifyOrderName || order.name,
          shopify_line_item_id: r.shopifyLineItemId,
          shopify_sku: r.shopifySku,
          d365_item_number: r.d365ItemNumber,
          d365_sales_order_number: salesOrderNo,
          data_area_id: dataAreaId,
          quantity: r.quantity,
          price: r.price,
          // Lot ID from D365 createSalesOrderLine response — used at fulfillment time
          dynamics_inventory_lot_id: d365InventoryLotsBySku[r.d365ItemNumber.toUpperCase()] ?? null,
          is_service_line: r.isServiceLine,
        }));
      const saveResult = await saveOrderLines(lineRecords);
      const result: OrderLinesSupabaseSyncLog = {
        attempted: true,
        d365LineCount: lineItems.length,
        recordsPrepared: lineRecords.length,
        skippedD365ServiceLines: skippedItemNumbers.size,
        save: saveResult,
        preview: lineRecords.slice(0, 12).map((r) => ({
          shopify_line_item_id: r.shopify_line_item_id,
          d365_item_number: r.d365_item_number,
          hasLotId: !!r.dynamics_inventory_lot_id,
        })),
      };

      const flowStatus: "completed" | "failed" | "skipped" = saveResult.ok
        ? "completed"
        : saveResult.reason === "database_error"
          ? "failed"
          : "skipped";
      const flowMessage = saveResult.ok
        ? `Upserted ${saveResult.upsertedRowCount} row(s) to public.order_lines`
        : saveResult.reason === "no_database_client"
          ? "Skipped: PostgreSQL not configured on Battle Bus"
          : saveResult.reason === "empty_input"
            ? "Skipped: toOrderLineRecords returned 0 rows (nothing to persist)"
            : `Supabase upsert failed: ${saveResult.message}`;

      await publishStatus("supabase.order-lines", flowStatus, flowMessage, {
        saveResult,
        recordsPrepared: lineRecords.length,
        d365LinesCreated: lineItems.length,
        shopifyOrderId: String(shopifyOrderId),
        shopifyOrderName,
        salesOrderNumber: salesOrderNo,
        preview: result.preview,
      });

      return result;
    });
  }

  await publishStatus("d365.create-lines", "completed", `Created ${lineItems.length} line items`, {
    totalLines: lineItems.length,
  });

  // ── Step: confirm D365 order (with exponential backoff) ──────────
  await publishStatus("d365.confirm-order", "running", "Confirming D365 sales order");
  if (!skipD365) {
    await step.run("d365-confirm-order", async () => {
      const backoffMs = [500, 1000, 2000];

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await dynamics.confirmSalesOrder(salesOrderNo, dataAreaId);
          if (attempt > 1) {
            await publishStatus(
              "d365.confirm-order",
              "running",
              `Confirmed on attempt ${attempt}`,
              { attempt }
            );
          }
          break;
        } catch (error) {
          const isNotFoundError =
            error instanceof Error && error.message.includes("does not exist");
          if (isNotFoundError && attempt < 3) {
            const waitMs = backoffMs[attempt - 1];
            await publishStatus(
              "d365.confirm-order",
              "running",
              `Waiting ${waitMs}ms for D365 propagation (attempt ${attempt}/3)`,
              { attempt, maxAttempts: 3, waitMs }
            );
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          } else {
            throw error;
          }
        }
      }
    });
  }
  await publishStatus("d365.confirm-order", "completed", "D365 order confirmed");

  await publishStatus("create-d365-order", "completed", `D365 order created: ${salesOrderNo}`, {
    d365OrderNumber: salesOrderNo,
  });

  // ── Step: prepayment (spock-store: after confirm, if line cost > 0) ─
  const prepaymentAmount = calculateOrderCost(
    lineItems.map((line) => ({
      price: line.price,
      discount: line.discount,
      quantity: line.quantity,
    }))
  );

  if (!skipD365 && prepaymentAmount > 0) {
    await publishStatus(
      "d365.create-prepayment",
      "running",
      `Creating prepayment: $${prepaymentAmount.toFixed(2)}`,
      { amount: prepaymentAmount }
    );
    try {
      const depositCheck = await step.run("d365-create-prepayment", async () => {
        await retryWithBackoff(() => dynamics.createPrepayment(salesOrderNo, dataAreaId), {
          label: `d365-create-prepayment-${shopifyOrderName}-${salesOrderNo}`,
          maxAttempts: 3,
        });
        return dynamics.verifyDepositFulfillmentApplied(salesOrderNo, dataAreaId);
      });
      await publishStatus(
        "d365.create-prepayment",
        "completed",
        depositCheck.ok
          ? `Prepayment created: $${prepaymentAmount.toFixed(2)} (DepositFulfillment=Yes)`
          : `Prepayment posted but D365 did NOT flip header to deposit fulfillment ` +
              `(THK_DepositFulfillment=${depositCheck.depositFulfillment ?? "<empty>"}). ` +
              `Invoice will post as Standard, not Prepayment. ` +
              `Fix the customer/posting profile in D365 for the ordering account.`,
        {
          amount: prepaymentAmount,
          depositFulfillment: depositCheck.depositFulfillment,
          processingStatus: depositCheck.processingStatus,
          expectedInvoiceType: depositCheck.ok ? "Prepayment" : "Standard",
          salesOrderNumber: salesOrderNo,
          dataAreaId,
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isNumberSequenceError =
        errorMessage.includes("Number sequence") && errorMessage.includes("has been exceeded");

      await publishStatus(
        "d365.create-prepayment",
        "failed",
        `Prepayment failed: ${errorMessage}`,
        {
          amount: prepaymentAmount,
          error: isNumberSequenceError ? "number_sequence_exceeded" : errorMessage,
          salesOrderNumber: salesOrderNo,
        }
      );

      await slack.sendWarningMessage(
        SlackChannelEnum.SHOPIFY,
        isNumberSequenceError
          ? `⚠️ [D365] Number sequence exceeded for prepayment\nOrder: ${shopifyOrderName} (${salesOrderNo})\nError: ${errorMessage}\nAction Required: Extend number sequence U001-JBN in D365`
          : `⚠️ [D365] Prepayment creation failed for ${shopifyOrderName} (${salesOrderNo}): ${errorMessage}`
      );

      throw new Error(
        `[D365] Prepayment creation failed for ${shopifyOrderName} (${salesOrderNo}): ${errorMessage}`
      );
    }
  }

  return {
    salesOrderNo,
    lineItems,
    d365InventoryLotsBySku,
    orderLinesSupabase,
  };
}
