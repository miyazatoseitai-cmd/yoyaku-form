import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { registerReservation, getAvailability } from './salonboard';
import { MENUS, MenuOption, TIME_SLOTS } from './types';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// index.html の __LIFF_ID__ をサーバー側で差し替えて配信
app.get('/', (_req: Request, res: Response) => {
  const fs = require('fs');
  const filePath = path.join(__dirname, '..', 'public', 'index.html');
  let html = fs.readFileSync(filePath, 'utf-8');
  html = html.replace('__LIFF_ID__', process.env.LINE_LIFF_ID || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// メニューと時間スロットをフロントエンドに提供
app.get('/api/options', (_req: Request, res: Response) => {
  res.json({ menus: MENUS, timeSlots: Array.from(TIME_SLOTS) });
});

// 空き状況キャッシュ（10分間有効）
const availabilityCache = new Map<string, { result: { isClosed: boolean; bookedSlots: string[] }; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

// 今後N日分を事前取得してキャッシュ（バックグラウンド）
async function prefetchAvailability(days = 30) {
  console.log(`[事前取得] 今後${days}日分の空き状況を取得開始`);
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const date = d.toISOString().split('T')[0];
    // まだキャッシュにない日付だけ取得
    if (!availabilityCache.has(date) || availabilityCache.get(date)!.expiresAt < Date.now()) {
      try {
        const result = await getAvailability(date);
        availabilityCache.set(date, { result, expiresAt: Date.now() + CACHE_TTL_MS });
        console.log(`[事前取得] ${date} 完了`);
      } catch {
        // 個別の失敗は無視して続行
      }
    }
  }
  console.log('[事前取得] 完了');
}

// 指定日の予約済み時間を返す（時間チップの非活性化に使用）
app.get('/api/availability', async (req: Request, res: Response) => {
  const date = req.query.date as string;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ isClosed: false, bookedSlots: [] });
    return;
  }

  // キャッシュヒット確認
  const cached = availabilityCache.get(date);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[空き確認] キャッシュヒット: ${date}`);
    res.json(cached.result);
    return;
  }

  // キャッシュミス時はリアルタイム取得
  try {
    const result = await getAvailability(date);
    availabilityCache.set(date, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(result);
  } catch (err) {
    console.error('[空き確認エラー]', err);
    res.json({ isClosed: false, bookedSlots: [] });
  }
});

// 予約フォーム送信
app.post('/api/reserve', async (req: Request, res: Response) => {
  const { name, phone, menu, date, time, lineUserId } = req.body;

  if (!name || !phone || !menu || !date || !time) {
    res.status(400).json({ success: false, message: '全ての項目を入力してください。' });
    return;
  }

  // LINEユーザーIDをログに出力（オーナーID確認用）
  if (lineUserId) {
    console.log(`[LINE UserID] ${lineUserId}`);
  }

  // フォームのラベル名からサロンボードの正式名称に変換
  const menuOption = (MENUS as MenuOption[]).find((m) => m.label === menu);
  const salonboardMenu = menuOption ? menuOption.salonboardName : menu;

  // キャッシュから空き状況を確認（即時・追加遅延なし）
  const cached = availabilityCache.get(date);
  const bookedSlots = cached ? cached.result.bookedSlots : [];
  const isConflict = bookedSlots.includes(time);

  // お客様へのLINE通知（先に送信）
  if (lineUserId) {
    sendLineNotification(lineUserId, { name, menu, date, time }).catch((err) => {
      console.error('[LINE通知・お客様] 送信エラー:', err);
    });
  }

  // オーナーへの通知（競合情報付き）
  const ownerLineUserId = process.env.OWNER_LINE_USER_ID;
  if (ownerLineUserId) {
    sendOwnerNotification(ownerLineUserId, { name, phone, menu, date, time, isConflict }).catch((err) => {
      console.error('[LINE通知・オーナー] 送信エラー:', err);
    });
  }

  // サロンボードへの登録はバックグラウンドで試みる（失敗してもお客様には影響しない）
  registerReservation({ name, phone, menu: salonboardMenu, date, time }).catch((err) => {
    console.error('[サロンボード登録エラー]', err);
  });

  res.json({ success: true });
});

// オーナーへのLINE通知（競合確認付き）
async function sendOwnerNotification(
  userId: string,
  reservation: { name: string; phone: string; menu: string; date: string; time: string; isConflict: boolean }
): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が設定されていません');

  const [, month, day] = reservation.date.split('-');
  const dateLabel = `${parseInt(month)}月${parseInt(day)}日`;

  const conflictText = reservation.isConflict
    ? '⚠️ この時間はすでに予約が入っています！確認してください。'
    : '✅ この時間は空きがあります。';

  const message = {
    type: 'flex',
    altText: `【新規予約】${reservation.name} 様 ${dateLabel} ${reservation.time}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: reservation.isConflict ? '#c0392b' : '#27ae60',
        contents: [
          {
            type: 'text',
            text: reservation.isConflict ? '⚠️ 新規予約（競合あり）' : '✅ 新規予約',
            color: '#ffffff',
            weight: 'bold',
            size: 'md',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'お名前', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: `${reservation.name} 様`, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '電話番号', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: reservation.phone, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'メニュー', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: reservation.menu, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '日時', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: `${dateLabel} ${reservation.time}`, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: conflictText,
            size: 'sm',
            color: reservation.isConflict ? '#c0392b' : '#27ae60',
            wrap: true,
            margin: 'md',
            weight: 'bold',
          },
        ],
      },
    },
  };

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: userId, messages: [message] }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LINE API エラー: ${response.status} ${text}`);
  }
}

// LINE プッシュ通知送信
async function sendLineNotification(
  userId: string,
  reservation: { name: string; menu: string; date: string; time: string }
): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が設定されていません');

  // 日付を見やすい形式に変換（例：2026-04-18 → 4月18日）
  const [, month, day] = reservation.date.split('-');
  const dateLabel = `${parseInt(month)}月${parseInt(day)}日`;

  const message = {
    type: 'flex',
    altText: `【予約確定】${dateLabel} ${reservation.time} ${reservation.menu}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#b5707c',
        contents: [
          {
            type: 'text',
            text: '✅ ご予約が確定しました',
            color: '#ffffff',
            weight: 'bold',
            size: 'md',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'メニュー', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: reservation.menu, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '日時', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: `${dateLabel} ${reservation.time}`, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'お名前', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: `${reservation.name} 様`, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: 'ご来店をスタッフ一同お待ちしております。',
            size: 'xs',
            color: '#888888',
            wrap: true,
            margin: 'md',
          },
        ],
      },
    },
  };

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [message],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LINE API エラー: ${response.status} ${text}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`予約フォーム起動中: http://localhost:${PORT}`);
  // サーバー起動後に事前取得を開始（バックグラウンド）
  setTimeout(() => {
    prefetchAvailability(30).catch(err => console.error('[事前取得エラー]', err));
  }, 3000); // 起動から3秒後に開始
});
