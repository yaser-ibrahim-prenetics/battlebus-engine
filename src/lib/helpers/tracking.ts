export function mapGpsCarrierToShopify(gpsCarrier: string): string {
  const carrierMap: Record<string, string> = {
    "FEDEX-IP": "FedEx",
    "FEDEX-GROUND": "FedEx",
    FEDEX: "FedEx",
    "UPS-GROUND": "UPS",
    UPS: "UPS",
    USPS: "USPS",
    "DHL-EXPRESS": "DHL Express",
    DHL: "DHL Express",
    "SF-EXPRESS": "SF Express",
    SF: "SF Express",
    GPS: "Other",
  };
  return carrierMap[(gpsCarrier || "").toUpperCase()] || gpsCarrier;
}

export function getTrackingUrl(carrier: string, trackingNumber: string): string {
  const carrierLower = (carrier || "").toLowerCase();
  if (carrierLower.includes("fedex"))
    return `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}`;
  if (carrierLower.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (carrierLower.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  if (carrierLower.includes("dhl"))
    return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
  if (carrierLower.includes("sf"))
    return `https://www.sf-express.com/en/dynamic_function/waybill/#search/bill-number/${trackingNumber}`;
  return `https://track.aftership.com/${trackingNumber}`;
}
