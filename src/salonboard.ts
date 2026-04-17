import { chromium, Browser, Page } from 'playwright-core';
import chromiumBin from '@sparticuz/chromium';
import { ReservationData } from './types';

const SALONBOARD_URL = 'https://salonboard.com/login/';

// ブラウザセッションを使い回す（ログインし直しを避ける）
let _browser: Browser | null = null;
let _page: Page | null = null;

async function getSession(): Promise<Page> {
  const email = process.env.SALONBOARD_EMAIL!;
  const password = process.env.SALONBOARD_PASSWORD!;

  // 既存セッションが生きているか確認
  if (_browser && _page) {
    try {
      const url = _page.url();
      if (!url.includes('/login/') && url.includes('salonboard.com')) {
        return _page; // セッション有効
      }
    } catch {
      // ページが壊れている場合は再作成
    }
  }

  // ブラウザを起動（または再起動）
  if (_browser) {
    try { await _browser.close(); } catch {}
  }

  const executablePath = await chromiumBin.executablePath();
  _browser = await chromium.launch({
    args: chromiumBin.args,
    executablePath,
    headless: true,
  });
  _page = await _browser.newPage();

  // ログイン
  await _page.goto(SALONBOARD_URL, { waitUntil: 'domcontentloaded' });
  await _page.fill('input[name="mailAddress"]', email);
  await _page.fill('input[name="password"]', password);
  await _page.click('button[type="submit"]');
  await _page.waitForNavigation({ waitUntil: 'domcontentloaded' });

  if (_page.url().includes('/login/')) {
    throw new Error('サロンボードへのログインに失敗しました。');
  }

  console.log('[SalonBoard] ログイン成功');
  return _page;
}

export interface AvailabilityResult {
  isClosed: boolean;
  bookedSlots: string[];
}

/** 指定日の空き状況を取得する */
export async function getAvailability(date: string): Promise<AvailabilityResult> {
  const email = process.env.SALONBOARD_EMAIL;
  const password = process.env.SALONBOARD_PASSWORD;
  if (!email || !password) return { isClosed: false, bookedSlots: [] };

  const [year, month, day] = date.split('-');
  const dateParam = `${year}${month}${day}`;

  try {
    const page = await getSession();

    await page.goto(
      `https://salonboard.com/KLP/schedule/salonSchedule/?date=${dateParam}`,
      { waitUntil: 'domcontentloaded' }
    );

    const { bookedTimes, isClosed } = await page.evaluate(() => {
      const times = new Set<string>();
      const bodyText = document.body.innerText || '';

      const closedKeywords = ['受付停止', '定休', '休業日', '臨時休業'];
      const hasClosedText = closedKeywords.some(k => bodyText.includes(k));

      document.querySelectorAll('td, div, span').forEach(el => {
        const text = (el as HTMLElement).innerText?.trim() || '';
        const match = text.match(/^(\d{1,2}:\d{2})/);
        if (match) {
          const parent = el.parentElement;
          const grandParent = parent?.parentElement;
          const bg = (el as HTMLElement).style?.backgroundColor
            || (parent as HTMLElement)?.style?.backgroundColor
            || (grandParent as HTMLElement)?.style?.backgroundColor;
          if (bg && bg !== '' && bg !== 'transparent') {
            const [h, m] = match[1].split(':');
            times.add(`${h.padStart(2, '0')}:${m}`);
          }
        }
      });

      document.querySelectorAll('[data-start], [data-time], [data-begin]').forEach(el => {
        const t = el.getAttribute('data-start')
          || el.getAttribute('data-time')
          || el.getAttribute('data-begin') || '';
        const match = t.match(/(\d{2}:\d{2})/);
        if (match) times.add(match[1]);
      });

      const hasTimeAxis = bodyText.includes('10:00') || bodyText.includes('11:00');

      return {
        bookedTimes: Array.from(times),
        isClosed: hasClosedText || !hasTimeAxis,
      };
    });

    console.log(`[SalonBoard] ${date} 休業日=${isClosed} 予約済み=`, bookedTimes);
    return { isClosed, bookedSlots: bookedTimes };
  } catch (err) {
    console.error('[SalonBoard] 空き時間取得エラー:', err);
    // セッションをリセット（次回再ログイン）
    _page = null;
    return { isClosed: false, bookedSlots: [] };
  }
}

export async function registerReservation(reservation: ReservationData): Promise<void> {
  if (!reservation.date || !reservation.time || !reservation.name || !reservation.menu) {
    throw new Error('予約データが不完全です');
  }

  // テストモード
  if (process.env.SALONBOARD_TEST === 'true') {
    console.log('[SalonBoard] テストモード: 登録をスキップ', reservation);
    return;
  }

  const page = await getSession();

  // 予約登録ページへ移動
  await page.goto('https://salonboard.com/CNT/draft/reservationAdd/', { waitUntil: 'domcontentloaded' });

  const [year, month, day] = reservation.date.split('-');
  const dateStr = `${year}/${month}/${day}`;
  const dateInput = page.locator('input[name="visitDate"], input[id*="visitDate"], input[placeholder*="日付"]').first();
  await dateInput.fill(dateStr);

  const timeInput = page.locator('select[name*="time"], input[name*="time"], select[id*="Time"]').first();
  await timeInput.fill(reservation.time);

  const menuSelect = page.locator('select[name*="menu"], select[id*="menu"]').first();
  if (await menuSelect.isVisible()) {
    await menuSelect.selectOption({ label: reservation.menu });
  }

  const nameInput = page.locator('input[name*="name"], input[id*="name"], input[placeholder*="氏名"], input[placeholder*="お名前"]').first();
  await nameInput.fill(reservation.name);

  if (reservation.phone) {
    const phoneInput = page.locator('input[name*="tel"], input[name*="phone"], input[placeholder*="電話"]').first();
    if (await phoneInput.isVisible()) {
      await phoneInput.fill(reservation.phone);
    }
  }

  const saveButton = page.locator('button[type="submit"], input[type="submit"], button:has-text("登録"), button:has-text("保存")').first();
  await saveButton.click();
  await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

  console.log(`[SalonBoard] 予約登録完了: ${reservation.name} 様 ${reservation.date} ${reservation.time}`);
}
