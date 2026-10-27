export const ORDER_ACCOUNTING_API_VERSION = "2026-07";
export const orderTransactionsQuery = `
  query OrderPaymentReferences($orderId: ID!) {
    order(id: $orderId) {
      transactions(first: 250) {
        id kind status gateway paymentId order { id }
      }
    }
  }
`;
