export const segmentFields = `
  id
  lineItems(first: 250) {
    nodes { id remainingQuantity lineItem { id } }
    pageInfo { hasNextPage }
  }
`;
export const fulfillmentOrderForSplitQuery = `query FulfillmentOrderForSplit($id: ID!) {
  fulfillmentOrder(id: $id) { ${segmentFields} }
}`;
export const splitFulfillmentOrderMutation = `mutation SplitOrderSegment($splits: [FulfillmentOrderSplitInput!]!) {
  fulfillmentOrderSplit(fulfillmentOrderSplits: $splits) {
    fulfillmentOrderSplits {
      fulfillmentOrder { ${segmentFields} }
      remainingFulfillmentOrder { ${segmentFields} }
    }
    userErrors { field message }
  }
}`;
export const fulfillmentSegmentsQuery = `query FulfillmentSegments($id: ID!) {
  fulfillment(id: $id) {
    fulfillmentOrders(first: 250) { nodes { id } pageInfo { hasNextPage } }
  }
}`;
