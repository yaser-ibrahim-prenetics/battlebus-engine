import { GoogleAuth } from "google-auth-library";
import { Kafka, logLevel, type Message, type Producer, type SASLOptions } from "kafkajs";
import { config } from "@/lib/config";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
let producer: Promise<Producer> | undefined;

const base64url = (value: string) => Buffer.from(value).toString("base64url");

/**
 * SASL OAUTHBEARER token for Google Cloud Managed Service for Apache Kafka: a JWT-shaped value
 * whose header names the GOOG_OAUTH2_TOKEN algorithm, whose payload names the principal, and
 * whose last segment is a Google access token for the runtime service account. No downloaded keys.
 */
export async function googleManagedKafkaToken(): Promise<string> {
  try {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const { client_email: email } = await auth.getCredentials();
    if (!token || !email) throw new Error("Missing credential");

    const now = Math.floor(Date.now() / 1000);
    const expiry = client.credentials.expiry_date
      ? Math.floor(client.credentials.expiry_date / 1000)
      : now + 3600;
    return [
      base64url(JSON.stringify({ typ: "JWT", alg: "GOOG_OAUTH2_TOKEN" })),
      base64url(
        JSON.stringify({ exp: expiry, iat: now, iss: "Google", scope: "kafka", sub: email })
      ),
      base64url(token),
    ].join(".");
  } catch {
    // Google auth errors can contain request headers. Never propagate those.
    throw new Error("Could not obtain the Kafka OAuth credential");
  }
}

function sasl(): SASLOptions | undefined {
  if (config.kafka.saslMechanism === "google-oauthbearer") {
    return {
      mechanism: "oauthbearer",
      oauthBearerProvider: async () => ({ value: await googleManagedKafkaToken() }),
    };
  }
  return undefined;
}

function getProducer(): Promise<Producer> {
  producer ??= (async () => {
    if (config.kafka.brokers.length === 0)
      throw new Error("KAFKA_BOOTSTRAP_SERVERS is not configured");
    const saslOptions = sasl();
    const kafka = new Kafka({
      clientId: "battle-bus",
      brokers: config.kafka.brokers,
      ssl: saslOptions !== undefined,
      sasl: saslOptions,
      logLevel: logLevel.WARN,
      logCreator:
        () =>
        ({ level, log }) => {
          const line = `[Kafka] ${log.message}`;
          if (level <= logLevel.ERROR) console.error(line);
          else console.warn(line);
        },
    });
    // idempotent: broker-side deduplication of producer retries within a session
    const created = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await created.connect();
    return created;
  })().catch((error: unknown) => {
    producer = undefined;
    throw error;
  });
  return producer;
}

/** Publishes messages and resolves once all in-sync replicas acknowledged them. */
export async function publishMessages(topic: string, messages: Message[]): Promise<void> {
  const connected = await getProducer();
  await connected.send({ topic, acks: -1, messages });
}

export async function disconnectProducer(): Promise<void> {
  const current = producer;
  producer = undefined;
  if (current) await (await current).disconnect();
}
