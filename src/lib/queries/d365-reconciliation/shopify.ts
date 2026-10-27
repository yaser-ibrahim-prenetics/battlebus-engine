export const paidOrdersQuery = `query ReconcilePaidOrders($search: String!, $cursor: String) {
  orders(first: 250, after: $cursor, sortKey: CREATED_AT, query: $search) {
    pageInfo { hasNextPage endCursor }
    nodes { name createdAt cancelledAt displayFinancialStatus }
  }
}`;
export const fulfillmentEventsQuery = `query ReconcileFulfillmentEvents($search: String!, $cursor: String) {
  events(first: 250, after: $cursor, sortKey: CREATED_AT, query: $search) {
    pageInfo { hasNextPage endCursor }
    nodes { createdAt ... on BasicEvent { action subjectType subject { ... on Order { name } } } }
  }
}`;
