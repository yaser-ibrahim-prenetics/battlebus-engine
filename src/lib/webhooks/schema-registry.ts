const SCHEMA_VERSION_HEADERS = [
  "x-battle-webhook-schema-version",
  "x-webhook-schema-version",
] as const;

const webhookSchemas = {
  shopify: ["1.0"],
  loop: ["1.0"],
  gps: ["1.0"],
  gps_individual: ["1.0"],
  stord: ["1.0"],
  dynamics_inventory: ["1.0"],
  dynamics_fulfillment: ["1.0"],
} as const;

export type WebhookSource = keyof typeof webhookSchemas;

export class WebhookSchemaError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly schemaVersion: string
  ) {
    super(message);
    this.name = "WebhookSchemaError";
  }
}

function requestedVersion(headers: Record<string, string | null | undefined>): string | undefined {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  for (const header of SCHEMA_VERSION_HEADERS) {
    const value = normalized.get(header)?.trim();
    if (value) return value;
  }

  return undefined;
}

export function getCurrentWebhookSchemaVersion(source: string): string {
  const versions = webhookSchemas[source as WebhookSource];
  if (!versions) {
    throw new WebhookSchemaError(`Unsupported webhook source: ${source}`, source, "unknown");
  }
  return versions[versions.length - 1];
}

export function assertWebhookSchemaVersion(source: string, schemaVersion: string): void {
  const versions = webhookSchemas[source as WebhookSource] as readonly string[] | undefined;
  if (!versions?.includes(schemaVersion)) {
    throw new WebhookSchemaError(
      `Unsupported ${source} webhook schema version: ${schemaVersion}`,
      source,
      schemaVersion
    );
  }
}

export function resolveWebhookSchemaVersion(
  source: string,
  headers: Record<string, string | null | undefined>
): string {
  const version = requestedVersion(headers) ?? getCurrentWebhookSchemaVersion(source);
  assertWebhookSchemaVersion(source, version);
  return version;
}

export function assertWebhookPayload(payload: unknown, source: string, schemaVersion: string): void {
  assertWebhookSchemaVersion(source, schemaVersion);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WebhookSchemaError(
      `${source} webhook schema ${schemaVersion} requires an object payload`,
      source,
      schemaVersion
    );
  }
}

export function listWebhookSchemaVersions(): Record<string, readonly string[]> {
  return webhookSchemas;
}
