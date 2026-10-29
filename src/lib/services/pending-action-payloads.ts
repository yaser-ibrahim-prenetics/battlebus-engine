type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function withoutUndefined(values: UnknownRecord): UnknownRecord {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function cancellationPendingActionData(eventData: UnknownRecord): UnknownRecord {
  const order = asRecord(eventData.orderJson);
  const shippingAddress = asRecord(order.shipping_address);
  const countryCode = shippingAddress.country_code;

  return withoutUndefined({
    shopifyOrderId: eventData.shopifyOrderId,
    shopifyOrderName: eventData.shopifyOrderName,
    cancelReason: eventData.cancelReason,
    shopifyStore: eventData.shopifyStore,
    orderJson: withoutUndefined({
      financial_status: order.financial_status,
      cancelled_at: order.cancelled_at,
      shipping_address: countryCode === undefined ? undefined : { country_code: countryCode },
    }),
  });
}

export function fulfillmentPendingActionData(eventData: UnknownRecord): UnknownRecord {
  const order = asRecord(eventData.orderJson);
  const shippingAddress = asRecord(order.shipping_address);
  const lineItems = Array.isArray(order.line_items)
    ? order.line_items.map((value) => {
        const line = asRecord(value);
        return withoutUndefined({ id: line.id, sku: line.sku });
      })
    : undefined;
  const fulfillments = Array.isArray(eventData.fulfillments)
    ? eventData.fulfillments.map((value) => {
        const fulfillment = asRecord(value);
        const fulfillmentLines = Array.isArray(fulfillment.line_items)
          ? fulfillment.line_items.map((lineValue) => {
              const line = asRecord(lineValue);
              return withoutUndefined({
                id: line.id,
                quantity: line.quantity,
                sku: line.sku,
                price: line.price,
              });
            })
          : undefined;
        return withoutUndefined({
          id: fulfillment.id,
          status: fulfillment.status,
          created_at: fulfillment.created_at,
          tracking_company: fulfillment.tracking_company,
          tracking_number: fulfillment.tracking_number,
          location_id: fulfillment.location_id,
          note: fulfillment.note,
          line_items: fulfillmentLines,
        });
      })
    : undefined;

  return withoutUndefined({
    shopifyOrderId: eventData.shopifyOrderId,
    shopifyOrderName: eventData.shopifyOrderName,
    shopifyStore: eventData.shopifyStore,
    orderJson: withoutUndefined({
      id: order.id,
      name: order.name,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      shipping_address:
        shippingAddress.country_code === undefined
          ? undefined
          : { country_code: shippingAddress.country_code },
      line_items: lineItems,
    }),
    fulfillments,
    fromGpsSync: eventData.fromGpsSync === true ? true : undefined,
    gpsOrderId: eventData.fromGpsSync === true ? eventData.gpsOrderId : undefined,
    runSequence: Array.isArray(eventData.runSequence) ? eventData.runSequence : undefined,
    oosRecoveryReplay: eventData.oosRecoveryReplay === true ? true : undefined,
    oosRecoveryAttemptToken:
      eventData.oosRecoveryReplay === true ? eventData.oosRecoveryAttemptToken : undefined,
  });
}
