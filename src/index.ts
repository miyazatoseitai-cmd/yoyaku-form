import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { getAvailability } from './salonboard';
import { MENUS, TIME_SLOTS } from './types';

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

// 予約の一時保存（確定通知送信まで保持）
interface PendingReservation {
  name: string;
  phone: string;
  menu: string;
  date: string;
  time: string;
  lineUserId: string;
  dateLabel: string;
  createdAt: number;
}
const pendingReservations = new Map<string, PendingReservation>();

// 今後N日分を事前取得してキャッシュ（バックグラウンド）
async function prefetchAvailability(days = 30) {
  console.log(`[事前取得] 今後${days}日分の空き状況を取得開始`);
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const date = d.toISOString().split('T')[0];
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

// 指定日の予約済み時間を返す
app.get('/api/availability', async (req: Request, res: Response) => {
  const date = req.query.date as string;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ isClosed: false, bookedSlots: [] });
    return;
  }

  const cached = availabilityCache.get(date);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.result);
    return;
  }

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

  console.log(`[LINE UserID] ${lineUserId}`);

  // 日付ラベル生成
  const [, month, day] = date.split('-');
  const dateLabel = `${parseInt(month)}月${parseInt(day)}日`;

  // キャッシュから空き状況を確認
  const cached = availabilityCache.get(date);
  const bookedSlots = cached ? cached.result.bookedSlots : [];
  const isConflict = bookedSlots.includes(time);

  // 予約を一時保存（IDで管理）
  const reservationId = crypto.randomUUID();
  if (lineUserId) {
    pendingReservations.set(reservationId, {
      name, phone, menu, date, time, lineUserId, dateLabel,
      createdAt: Date.now(),
    });
    // 24時間後に自動削除
    setTimeout(() => pendingReservations.delete(reservationId), 24 * 60 * 60 * 1000);
  }

  // お客様へ「受付完了」通知
  if (lineUserId) {
    sendReceiptNotification(lineUserId, { name, menu, dateLabel, time }).catch((err) => {
      console.error('[LINE通知・受付] 送信エラー:', err);
    });
  }

  // オーナーへ通知（競合情報＋確定通知ボタン）
  const ownerLineUserId = process.env.OWNER_LINE_USER_ID;
  if (ownerLineUserId) {
    sendOwnerNotification(ownerLineUserId, {
      name, phone, menu, dateLabel, time, isConflict, reservationId: lineUserId ? reservationId : null,
    }).catch((err) => {
      console.error('[LINE通知・オーナー] 送信エラー:', err);
    });
  }

  res.json({ success: true });
});

// 確定通知編集ページ
app.get('/confirm/:id', (req: Request, res: Response) => {
  const reservation = pendingReservations.get(req.params.id);
  if (!reservation) {
    res.status(404).send('<p style="font-family:sans-serif;padding:24px">この予約は見つかりません（期限切れの可能性があります）</p>');
    return;
  }

  const template = `【予約確定のご連絡】

${reservation.name} 様

以下の内容でご予約が確定しました。

📋 ${reservation.menu}
📅 ${reservation.dateLabel}（${reservation.time}）

ご来店をスタッフ一同お待ちしております。
変更・キャンセルはLINEまたはお電話でご連絡ください。`;

  const fs = require('fs');
  const filePath = path.join(__dirname, '..', 'public', 'confirm-template.html');
  let html = fs.readFileSync(filePath, 'utf-8');
  html = html
    .replace('__RESERVATION_ID__', req.params.id)
    .replace('__NAME__', reservation.name)
    .replace('__TEMPLATE__', template);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// 確定通知送信API
app.post('/api/confirm', async (req: Request, res: Response) => {
  const { reservationId, message } = req.body;
  const reservation = pendingReservations.get(reservationId);

  if (!reservation) {
    res.status(404).json({ success: false, message: '予約が見つかりません' });
    return;
  }

  try {
    await sendConfirmNotification(reservation.lineUserId, message);
    pendingReservations.delete(reservationId);
    res.json({ success: true });
  } catch (err) {
    console.error('[確定通知エラー]', err);
    res.status(500).json({ success: false, message: '送信に失敗しました' });
  }
});

// お客様へ「受付完了」通知
async function sendReceiptNotification(
  userId: string,
  reservation: { name: string; menu: string; dateLabel: string; time: string }
): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が設定されていません');

  const message = {
    type: 'flex',
    altText: `【受付完了】${reservation.dateLabel} ${reservation.time} のご予約を受け付けました`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#b5707c',
        contents: [{
          type: 'text',
          text: '📋 ご予約を受け付けました',
          color: '#ffffff',
          weight: 'bold',
          size: 'md',
        }],
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
            { type: 'text', text: `${reservation.dateLabel} ${reservation.time}`, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: 'お名前', color: '#aaaaaa', size: 'sm', flex: 2 },
            { type: 'text', text: `${reservation.name} 様`, size: 'sm', flex: 3, weight: 'bold' },
          ]},
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '内容を確認後、確定のご連絡をお送りします。しばらくお待ちください。',
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages: [message] }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LINE API エラー: ${response.status} ${text}`);
  }
}

// オーナーへのLINE通知（競合確認＋確定通知ボタン）
async function sendOwnerNotification(
  userId: string,
  reservation: { name: string; phone: string; menu: string; dateLabel: string; time: string; isConflict: boolean; reservationId: string | null }
): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が設定されていません');

  const baseUrl = process.env.BASE_URL || 'https://yoyaku-form-z92k.onrender.com';
  const conflictText = reservation.isConflict
    ? '⚠️ この時間はすでに予約が入っています！お客様に個別連絡してください。'
    : '✅ この時間は空きがあります。サロンボードに登録後、確定通知を送ってください。';

  const bodyContents: object[] = [
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
      { type: 'text', text: `${reservation.dateLabel} ${reservation.time}`, size: 'sm', flex: 3, weight: 'bold' },
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
  ];

  // 空きありの場合のみ「確定通知を送る」ボタンを追加
  if (!reservation.isConflict && reservation.reservationId) {
    bodyContents.push({
      type: 'button',
      style: 'primary',
      color: '#b5707c',
      margin: 'md',
      action: {
        type: 'uri',
        label: '確定通知を送る',
        uri: `${baseUrl}/confirm/${reservation.reservationId}`,
      },
    });
  }

  const message = {
    type: 'flex',
    altText: `【新規予約】${reservation.name} 様 ${reservation.dateLabel} ${reservation.time}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: reservation.isConflict ? '#c0392b' : '#27ae60',
        contents: [{
          type: 'text',
          text: reservation.isConflict ? '⚠️ 新規予約（競合あり）' : '✅ 新規予約',
          color: '#ffffff',
          weight: 'bold',
          size: 'md',
        }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: bodyContents,
      },
    },
  };

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages: [message] }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LINE API エラー: ${response.status} ${text}`);
  }
}

// お客様へ確定通知（テキスト自由入力）
async function sendConfirmNotification(userId: string, messageText: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が設定されていません');

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: messageText }],
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
  setTimeout(() => {
    prefetchAvailability(30).catch(err => console.error('[事前取得エラー]', err));
  }, 3000);
});
