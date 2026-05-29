import { describe, expect, it } from "vitest";
import { buildThkFulfilmentRequestBody } from "../d365-thk-fulfilment";
import {
  getServiceSkuOverridesByDataArea,
  getRefundSku,
  getReturnConfig,
} from "../warehouse";

const u001RefundSku = getServiceSkuOverridesByDataArea()["U001"].refund;
const h007RefundSku = getServiceSkuOverridesByDataArea()["H007"].refund;

const baseLine = {
  itemNumber: u001RefundSku,
  quantity: -1 as const,
  shippingSiteId: "Prenetics",
  trackingNumber: "",
  lotId: "U001-REFUND-LOT-1",
};

describe("buildThkFulfilmentRequestBody — U001 refund lane", () => {
  it("omits Warehouse/Location on shipment fulfilment", () => {
    const stordReturn = getReturnConfig("STORD ATL Location");
    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "U001",
      type: "shipment",
      salesOrderNumber: "U001-SO-570601",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: "IM8-FG-000196",
          quantity: 1,
          shippingSiteId: "Prenetics",
          shippingWarehouseId: stordReturn.shippingWarehouseId,
          shippingWarehouseLocationId: stordReturn.shippingWarehouseLocationId,
          trackingNumber: "TRACK-001",
          lotId: "U001-1912685",
        },
      ],
    });

    expect(body._dataContract.Type).toBe("shipment");
    expect(body._dataContract.Lines).toHaveLength(1);
    expect(body._dataContract.Lines[0]).toEqual({
      ItemNumber: "IM8-FG-000196",
      Quantity: 1,
      Site: "Prenetics",
      TrackingNumber: "TRACK-001",
      Lotid: "U001-1912685",
    });
    expect(body._dataContract.Lines[0]).not.toHaveProperty("Warehouse");
    expect(body._dataContract.Lines[0]).not.toHaveProperty("Location");
  });

  it("sends empty Warehouse/Location on return fulfilment (spock-store U001 parity)", () => {
    const returnCfg = getReturnConfig("STORD ATL Location");
    expect(getRefundSku("STORD ATL Location", "U001")).toBe(u001RefundSku);
    expect(returnCfg.shippingWarehouseId).toBe("USOPS-WH05-Q");

    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "U001",
      type: "return",
      salesOrderNumber: "U001-SO-570601",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          ...baseLine,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
        },
      ],
    });

    expect(body._dataContract.Type).toBe("return");
    expect(body._dataContract.Lines[0]).toMatchObject({
      ItemNumber: u001RefundSku,
      Quantity: -1,
      Site: "Prenetics",
      Lotid: "U001-REFUND-LOT-1",
      Warehouse: "",
      Location: "",
    });
  });

  it("GPS US return profile resolves to USOPS-WH04-Q with empty strings on wire", () => {
    const returnCfg = getReturnConfig("GPS Warehouse");
    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "U001",
      type: "return",
      salesOrderNumber: "U001-SO-597892",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          ...baseLine,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
        },
      ],
    });

    expect(returnCfg.shippingWarehouseId).toBe("USOPS-WH04-Q");
    expect(body._dataContract.Lines[0]).toMatchObject({
      Warehouse: "",
      Location: "",
    });
  });
});

describe("buildThkFulfilmentRequestBody — H007 refund lane", () => {
  it("omits Warehouse/Location on shipment fulfilment", () => {
    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "H007",
      type: "shipment",
      salesOrderNumber: "H007-SO-124123",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: "IM8-FG-000242",
          quantity: 1,
          shippingSiteId: "Prenetics",
          shippingWarehouseId: "OPS-WH01",
          shippingWarehouseLocationId: "Primary",
          trackingNumber: "TRACK-H007",
          lotId: "H007-392014",
        },
      ],
    });

    expect(body._dataContract.Lines[0]).not.toHaveProperty("Warehouse");
    expect(body._dataContract.Lines[0]).not.toHaveProperty("Location");
  });

  it("includes return warehouse on GPS UK refund fulfilment", () => {
    const returnCfg = getReturnConfig("GPS UK Warehouse");
    expect(getRefundSku("GPS UK Warehouse", "H007")).toBe(h007RefundSku);
    expect(returnCfg.shippingWarehouseId).toBe("OPS-WH02-Q");

    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "H007",
      type: "return",
      salesOrderNumber: "H007-SO-124123",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: h007RefundSku,
          quantity: -1,
          shippingSiteId: returnCfg.shippingSiteId,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
          trackingNumber: "",
          lotId: "H007-REFUND-LOT-1",
        },
      ],
    });

    expect(body._dataContract.Lines[0]).toMatchObject({
      ItemNumber: h007RefundSku,
      Quantity: -1,
      Warehouse: "OPS-WH02-Q",
      Location: "Return",
    });
  });

  it("includes return warehouse on HK refund fulfilment (OPS-WH01 / Return)", () => {
    const returnCfg = getReturnConfig("HK Warehouse");
    expect(returnCfg.shippingWarehouseId).toBe("OPS-WH01");
    expect(returnCfg.shippingWarehouseLocationId).toBe("Return");

    const body = buildThkFulfilmentRequestBody({
      dataAreaId: "H007",
      type: "return",
      salesOrderNumber: "H007-SO-124123",
      confirmedShippedDate: "2026-05-28",
      lines: [
        {
          itemNumber: h007RefundSku,
          quantity: -1,
          shippingSiteId: returnCfg.shippingSiteId,
          shippingWarehouseId: returnCfg.shippingWarehouseId,
          shippingWarehouseLocationId: returnCfg.shippingWarehouseLocationId,
          trackingNumber: "",
          lotId: "H007-REFUND-LOT-2",
        },
      ],
    });

    expect(body._dataContract.Lines[0]).toMatchObject({
      Warehouse: "OPS-WH01",
      Location: "Return",
    });
  });
});
