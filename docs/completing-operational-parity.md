# Completing operational parity

This phase starts from main and preserves dry-run and provider-write switches.

## Acceptance criteria

- Split plans can span legal entities. Refund allocations are reserved before provider writes, conserve integer cents, and replay the original allocation. Fulfillment allocations conserve source quantities across partial deliveries.
- Sales-order, GPS, fulfillment, inventory and direct D365 checks persist structured attempts, including errors and discrepancies. A missing provider response is never a match.
- Direct D365 checks compare company routing, quantities and financial evidence. Automatic recovery requires conclusive provider evidence tied to the reserved action; age alone never authorizes a repeat write.
- Authenticated operational health reports dependency connectivity, inbox age, stale reconciliation attempts and uncertain action age. Restricted recovery operations validate their scope and retain an audit record.
- Battle Hub exposes history, health and recovery only through server-authorized endpoints.

## Release verification

Run unit and database migration tests, lint and builds. Review the final diff and fix findings before requesting review. Provider verification must record the actual environment and read-only probe outcome; configuration presence alone is insufficient. Production activation and deployment are separate from this PR.
