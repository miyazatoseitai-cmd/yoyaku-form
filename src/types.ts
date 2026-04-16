export interface ReservationData {
  menu?: string;
  date?: string;
  time?: string;
  name?: string;
  phone?: string;
  lineUserId?: string;
}

export interface MenuOption {
  /** サロンボードに登録されている正式名称（自動入力時に使用） */
  salonboardName: string;
  /** フォームに表示する名称 */
  label: string;
  /** 料金（円） */
  price: number;
}

export const MENUS: MenuOption[] = [
  { salonboardName: '【初回】整体体験　3,980円',              label: '整体体験（初回）',                  price: 3980 },
  { salonboardName: '【再来】整体　8,800円',                  label: '整体',                              price: 8800 },
  { salonboardName: '【回数券購入者用】整体　0円',             label: '整体（回数券）',                    price: 0    },
  { salonboardName: '【ダイエット】カウンセリング　1,980円',   label: 'ダイエットカウンセリング',           price: 1980 },
  { salonboardName: '【ダイエット】ダイエットコース購入者用　0円', label: 'ダイエットコース（購入者用）',  price: 0    },
];

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
