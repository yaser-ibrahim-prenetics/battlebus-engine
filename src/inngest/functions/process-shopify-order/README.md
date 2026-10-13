# Shopify order processing modules

`process-shopify-order.ts` is the orchestration entry point. It owns the Inngest
function definition and the order in which the workflow stages run. Functional
details live here so changes stay local and reviewable:

- `prepare-order.ts` repairs missing SKUs, validates the order, and resolves routing.
- `validation-failure.ts` parks rejected orders and reports their terminal state.
- `payment-accounting.ts` resolves Shopify payment and gift-card references.
- `d365-order.ts` creates, persists, confirms, and prepays a new D365 order.
- `fulfillment-split.ts` builds and applies per-segment Shopify fulfillment splits.
- `gps-order.ts` builds and dispatches the GPS order.
- `existing-d365-order.ts` recovers safely when D365 already contains the order.
- `complete-order.ts` handles GPS outcomes, backorders, Hub updates, and success.
- `failure-handler.ts` classifies and durably records terminal failures.
- `error-classification.ts` contains reusable error classification rules.
- `types.ts` contains the small shared contracts between stages.

Keep Inngest checkpoint IDs stable when moving code between modules. Renaming a
checkpoint changes retry memoization for in-flight runs.
