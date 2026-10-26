import { queryDatabase } from '@/lib/db/database';
import type { SlackNotification } from '@/lib/clients/slack';
import { enqueueNotificationSQL } from '@/lib/sql/slack-notifications/enqueue';
import { claimNotificationsSQL } from '@/lib/sql/slack-notifications/claim';
import { completeNotificationSQL, retryNotificationSQL } from '@/lib/sql/slack-notifications/finish';

type Publisher = (notification: SlackNotification) => Promise<void>;
type Claimed = {
  notification_id: string;
  payload: SlackNotification;
  lease_token: string;
  attempts: number;
};

export async function enqueueSlackNotification(notification: SlackNotification): Promise<void> {
  if (!notification.id || notification.id.length > 1024) throw new Error('Invalid Slack notification ID');
  await queryDatabase(enqueueNotificationSQL, [notification.id, JSON.stringify(notification)]);
}

export async function drainSlackNotifications(publish: Publisher, id?: string) {
  const { rows } = await queryDatabase<Claimed>(claimNotificationsSQL, [id ? 1 : 20, id ?? null]);
  let published = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await publish(row.payload);
      await queryDatabase(completeNotificationSQL, [row.notification_id, row.lease_token]);
      published++;
    } catch {
      // Do not persist credentials, endpoint URLs, or payloads from provider errors.
      await queryDatabase(retryNotificationSQL, [row.notification_id, row.lease_token]);
      console.error(`[SlackOutbox] Publication failed id=${row.notification_id} attempt=${row.attempts}`);
      failed++;
    }
  }
  return { claimed: rows.length, published, failed };
}
