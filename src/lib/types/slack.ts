export interface ISlackAttachment {
  fallback: string;
  color: string;
  title: string;
  text: string;
  footer: string;
  footer_icon?: string;
  ts: number;
  fields?: Array<{ title: string; value: string; short?: boolean }>;
}

export enum SlackChannelEnum {
  ORDER = 'order',
  GENERAL = 'general',
  EUROPA = 'europa',
  SYSTEM = 'sytem',
  SHOPIFY = 'shopify',
  SHOPIFY_LOW = 'shopifylow',
  PRIVE = 'prive',
  LOOP = 'loop',
  DYNAMICS = 'dynamics',
  EXTENSIV = 'extensiv',
  CIRCLE_DNA = 'circledna',
  CIRCLE_DNA_ORDER = 'circlednaorder',
  GPS = 'gps',
  GPS_LOW = 'gpslow',
  STORD = 'stord',
}
