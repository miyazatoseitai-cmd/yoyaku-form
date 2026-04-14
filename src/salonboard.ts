import { chromium } from 'playwright';
import { ReservationData } from './types';

const SALONBOARD_URL = 'https://salonboard.com/login/';

export async function registerReservation(reservation: ReservationData): Promise<void> {
  const email = process.env.SALONBOARD_EMAIL;
  const password = process.env.SALONBOARD_PASSWORD;

  if (!email || !password) {
    throw new Error('SALONBOARD_EMAIL または SALONBOARD_PASSWORD が設定されていません');
  }
  if (!reservation.date || !reservation.time || !reservation.name || !reservation.menu) {
    throw new Error('予約データが不完全です');
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // ログイン
    await page.goto(SALONBOARD_URL, { waitUntil: 'networkidle' });
    await page.fill('input[name="mailAddress"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle' });

    // ダッシュボードに遷移できたか確認
    const currentUrl = page.url();
    if (currentUrl.includes('/login/')) {
      throw new Error('サロンボードへのログインに失敗しました。認証情報を確認してください。');
    }

    // 予約登録ページへ移動
    // ※ サロンボードのUI構造に合わせてセレクタを調整が必要
    await page.goto('https://salonboard.com/CNT/draft/reservationAdd/', { waitUntil: 'networkidle' });

    // 日付入力（YYYY-MM-DD形式をMM/DD/YYYY形式に変換して入力）
    const [year, month, day] = reservation.date.split('-');
    const dateStr = `${year}/${month}/${day}`;
    const dateInput = page.locator('input[name="visitDate"], input[id*="visitDate"], input[placeholder*="日付"]').first();
    await dateInput.fill(dateStr);

    // 時間入力
    const timeInput = page.locator('select[name*="time"], input[name*="time"], select[id*="Time"]').first();
    await timeInput.fill(reservation.time);

    // メニュー選択（テキストで検索して選択）
    const menuSelect = page.locator('select[name*="menu"], select[id*="menu"]').first();
    if (await menuSelect.isVisible()) {
      await menuSelect.selectOption({ label: reservation.menu });
    }

    // 顧客名入力
    const nameInput = page.locator('input[name*="name"], input[id*="name"], input[placeholder*="氏名"], input[placeholder*="お名前"]').first();
    await nameInput.fill(reservation.name);

    // 電話番号入力
    if (reservation.phone) {
      const phoneInput = page.locator('input[name*="tel"], input[name*="phone"], input[placeholder*="電話"]').first();
      if (await phoneInput.isVisible()) {
        await phoneInput.fill(reservation.phone);
      }
    }

    // 保存ボタンをクリック
    const saveButton = page.locator('button[type="submit"], input[type="submit"], button:has-text("登録"), button:has-text("保存")').first();
    await saveButton.click();
    await page.waitForNavigation({ waitUntil: 'networkidle' });

    console.log(`[SalonBoard] 予約登録完了: ${reservation.name} 様 ${reservation.date} ${reservation.time}`);
  } finally {
    await browser.close();
  }
}
