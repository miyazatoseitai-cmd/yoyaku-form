import { chromium } from 'playwright';
import { ReservationData } from './types';

const SALONBOARD_URL = 'https://salonboard.com/login/';

async function loginAndGetPage() {
  const email = process.env.SALONBOARD_EMAIL;
  const password = process.env.SALONBOARD_PASSWORD;

  if (!email || !password) {
    throw new Error('SALONBOARD_EMAIL または SALONBOARD_PASSWORD が設定されていません');
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(SALONBOARD_URL, { waitUntil: 'networkidle' });
  await page.fill('input[name="mailAddress"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle' });

  if (page.url().includes('/login/')) {
    await browser.close();
    throw new Error('サロンボードへのログインに失敗しました。');
  }

  return { browser, page };
}

/** 指定日の予約済み開始時間リストを取得する */
export async function getBookedSlots(date: string): Promise<string[]> {
  const email = process.env.SALONBOARD_EMAIL;
  const password = process.env.SALONBOARD_PASSWORD;
  if (!email || !password) return [];

  const [year, month, day] = date.split('-');
  const dateParam = `${year}${month}${day}`;

  let browser;
  try {
    const result = await loginAndGetPage();
    browser = result.browser;
    const page = result.page;

    // スケジュール画面に移動
    await page.goto(
      `https://salonboard.com/KLP/schedule/salonSchedule/?date=${dateParam}`,
      { waitUntil: 'networkidle' }
    );

    // 予約ブロックから開始時間を抽出
    const bookedTimes = await page.evaluate(() => {
      const times = new Set<string>();

      // 方法1: 時刻テキストを含む予約ブロックを探す
      // SalonBoardのスケジュール画面では予約ブロックの先頭に時刻が表示される
      document.querySelectorAll('td, div, span').forEach(el => {
        const text = (el as HTMLElement).innerText?.trim() || '';
        // "11:00" のような時刻で始まる予約ブロックを探す
        const match = text.match(/^(\d{1,2}:\d{2})/);
        if (match) {
          const parent = el.parentElement;
          const grandParent = parent?.parentElement;
          // 背景色が設定されている（予約ブロックらしい）要素を探す
          const bg = (el as HTMLElement).style?.backgroundColor
            || (parent as HTMLElement)?.style?.backgroundColor
            || (grandParent as HTMLElement)?.style?.backgroundColor;
          if (bg && bg !== '' && bg !== 'transparent') {
            // HH:MM 形式に正規化
            const [h, m] = match[1].split(':');
            times.add(`${h.padStart(2, '0')}:${m}`);
          }
        }
      });

      // 方法2: data属性から時刻を取得
      document.querySelectorAll('[data-start], [data-time], [data-begin]').forEach(el => {
        const t = el.getAttribute('data-start')
          || el.getAttribute('data-time')
          || el.getAttribute('data-begin') || '';
        const match = t.match(/(\d{2}:\d{2})/);
        if (match) times.add(match[1]);
      });

      return Array.from(times);
    });

    console.log(`[SalonBoard] ${date} の予約済み時間:`, bookedTimes);
    return bookedTimes;
  } catch (err) {
    console.error('[SalonBoard] 空き時間取得エラー:', err);
    return []; // エラー時は全スロット選択可能（安全側に倒す）
  } finally {
    if (browser) await browser.close();
  }
}

export async function registerReservation(reservation: ReservationData): Promise<void> {
  if (!reservation.date || !reservation.time || !reservation.name || !reservation.menu) {
    throw new Error('予約データが不完全です');
  }

  const { browser, page } = await loginAndGetPage();

  try {
    // 予約登録ページへ移動
    await page.goto('https://salonboard.com/CNT/draft/reservationAdd/', { waitUntil: 'networkidle' });

    // 日付入力
    const [year, month, day] = reservation.date.split('-');
    const dateStr = `${year}/${month}/${day}`;
    const dateInput = page.locator('input[name="visitDate"], input[id*="visitDate"], input[placeholder*="日付"]').first();
    await dateInput.fill(dateStr);

    // 時間入力
    const timeInput = page.locator('select[name*="time"], input[name*="time"], select[id*="Time"]').first();
    await timeInput.fill(reservation.time);

    // メニュー選択
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

    // 保存
    const saveButton = page.locator('button[type="submit"], input[type="submit"], button:has-text("登録"), button:has-text("保存")').first();
    await saveButton.click();
    await page.waitForNavigation({ waitUntil: 'networkidle' });

    console.log(`[SalonBoard] 予約登録完了: ${reservation.name} 様 ${reservation.date} ${reservation.time}`);
  } finally {
    await browser.close();
  }
}
