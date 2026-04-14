export interface ReservationData {
  menu?: string;
  date?: string;
  time?: string;
  name?: string;
  phone?: string;
  lineUserId?: string;
}

export const MENUS = [
  'カット',
  'カラー',
  'パーマ',
  'トリートメント',
  'カット + カラー',
  'カット + パーマ',
] as const;

export type Menu = typeof MENUS[number];

export const TIME_SLOTS = [
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00',
  '18:00',
] as const;
