# Durable Slack notifications

The GCP deployment uses `SLACK_TRANSPORT=pubsub` and publishes to
`projects/battle-bus-509406/topics/battle-bus-slack-notifications` using the runtime
service account. No webhook credential is kept in Battle Bus. The independent
Slack service owns channel routing and delivery deduplication.

Notifications are awaited into `slack_notification_outbox` before publication.
Existing callers retain stable event-derived IDs. The first payload for each ID
is retained, so retries cannot replace an existing notification. A one-minute
Inngest function retries leased records after failures or process interruption.
Database failures are logged; notification failure does not fail the business
workflow. A database outage before enqueue therefore still needs operator attention.

Initial publication is paused using GitHub repository variable
`SLACK_PUBLISH_ENABLED=false` while IT request ITSDA-8367 is approved. The deployment
workflow defaults this flag to false. Enqueueing continues during the hold; draining
does not claim or consume retry attempts. Change the variable only after the service
has an approved webhook, and redeploy to resume publication. Review held notifications
before releasing them to avoid a burst of stale alerts.

The outbox retries transport failures up to ten observed attempts. An authorized
operator can replay selected `dead_letter` records after fixing the cause:

```sql
UPDATE public.slack_notification_outbox
SET status='pending', attempts=0, available_at=now(), lease_token=NULL, last_error=NULL
WHERE notification_id = '<reviewed-notification-id>' AND status='dead_letter';
```

Retain the original ID and payload. The consumer deduplicates an uncertain publication
that actually succeeded. Consumer `unknown` or stale `sending` outcomes must be checked
in Slack before any deliberate resend. Direct webhook mode remains available for
existing installations; it does not use this outbox. Kafka publication also uses
the durable outbox.

For validation, run migrations against an isolated database, then set
`SLACK_TEST_DATABASE_URL` when running the test suite. The PostgreSQL integration
test verifies immutable payloads, concurrent leases, retries, and published deduplication.

## Administrator test from Battle Hub

`POST /api/integration/slack/test` accepts the existing server-only Battle Bus API
credential. Battle Hub checks the user's verified Admin or Superadmin role before
calling it. The request accepts no custom message, channel or identifier.

The endpoint uses the same durable outbox and Pub/Sub publisher as business alerts.
It rejects tests while publication is disabled, the integration is simulated, or a
different transport is configured. A fixed `system` notification contains no customer
data and does not run any order, fulfillment or payment workflow. Tests still work
when business operations are in dry-run mode.

All callers share one notification ID per UTC minute. Database uniqueness and
consumer deduplication make repeated clicks and concurrent requests reuse that test.
A `202` response reports `queued` or `published` (accepted by Pub/Sub), never
confirmed Slack delivery. Persistence failures, disabled publishing and exhausted
retries return `503`. Check the configured Slack system channel for the returned
test ID to confirm delivery; that channel is currently `#battle-bus-test` in GCP.

Deploy this endpoint before the companion Hub test button. No new migrations,
webhook credentials or notification-service changes are required.
