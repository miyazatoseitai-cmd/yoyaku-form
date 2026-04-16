import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { registerReservation } from './salonboard';
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
  res.json({ menus: MENUS, timeSlots: TIME_SLOTS });
});

// 予約フォーム送信
app.post('/api/reserve', async (req: Request, res: Response) => {
  const { name, phone, menu, date, time, lineUserId } = req.body;

  if (!name || !phone || !menu || !date || !time) {
    res.status(400).json({ success: false, message: '全ての項目を入力してください。' });
    return;
  }

  try {
    // サロンボードに予約登録
    await registerReservation({ name, phone, menu, date, time });

    // LINE通知を送信（LINEユーザーIDがある場合のみ）
    if (lineUserId) {
      sendLineNotification(lineUserId, { name, menu, date, time }).catch((err) => {
        console.error('[LINE通知] 送信エラー:', err);
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[予約エラー]', err);
    res.status(500).json({
      success: false,
      message: 'サロンボードへの登録に失敗しました。お手数ですが店舗にお電話ください。',
    });
  }
});

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
});
