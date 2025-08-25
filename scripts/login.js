// scripts/login.js
// 登录逻辑：使用 Playwright (Chromium) 打开登录页 -> 填写账号密码 -> 点击登录
// - 出现“Verify you are human”或 Turnstile/CAPTCHA 相关元素则直接标记为失败并上报 Telegram
// - 登录成功与否都会截图上传为 artifact，方便排查
// 环境变量（通过 GitHub Secrets 注入）：
//   LUNES_USERNAME, LUNES_PASSWORD
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { chromium } from '@playwright/test';
import fs from 'fs';

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';

// Telegram 通知
async function notifyTelegram({ ok, stage, msg, screenshotPath }) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.log('[WARN] TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 未设置，跳过通知');
      return;
    }

    const text = [
      `🔔 Lunes 自动登录：${ok ? '✅ 成功' : '❌ 失败'}`,
      `阶段：${stage}`,
      msg ? `信息：${msg}` : '',
      `时间：${new Date().toISOString()}`
    ].filter(Boolean).join('\n');

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    // 若有截图，再发一张
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', `Lunes 自动登录截图（${stage}）`);
      form.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'screenshot.png');
      await fetch(photoUrl, { method: 'POST', body: form });
    }
  } catch (e) {
    console.log('[WARN] Telegram 通知失败：', e.message);
  }
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 }
  });
  const page = await context.newPage();

  const screenshot = (name) => `./${name}.png`;

  try {
    // 1) 打开登录页
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // 快速检测“人机验证”页面文案
    const humanCheckText = await page.locator('text=/Verify you are human|需要验证|安全检查|review the security/i').first();
    if (await humanCheckText.count()) {
      const sp = screenshot('01-human-check');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyTelegram({
        ok: false,
        stage: '打开登录页',
        msg: '检测到人机验证页面（Cloudflare/Turnstile），自动化已停止。',
        screenshotPath: sp
      });
      process.exitCode = 2;
      return;
    }

    // 2) 等待输入框可见（根据 name 属性更稳）
    const userInput = page.locator('input[name="username"]');
    const passInput = page.locator('input[name="password"]');

    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passInput.waitFor({ state: 'visible', timeout: 30_000 });

    // 填充账户信息（不要用 .fill 前先清空）
    await userInput.click({ timeout: 10_000 });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await userInput.fill(username, { timeout: 10_000 });

    await passInput.click({ timeout: 10_000 });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await passInput.fill(password, { timeout: 10_000 });

    // 3) 点击登录按钮（type=submit）
    const loginBtn = page.locator('button[type="submit"]');
    await loginBtn.waitFor({ state: 'visible', timeout: 15_000 });
    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    await Promise.all([
      // 有的站会局部刷新，不一定跳转；因此用 networkidle 做个兜底
      page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {}),
      loginBtn.click({ timeout: 10_000 })
    ]);

    // 4) 判定是否登录成功
    //   - 尝试判断：是否出现“Dashboard”、“Logout”、“My Account”等关键词（按你实际站点调整）
    //   - 或者 URL 是否从 /auth/login 跳转走了
    const spAfter = screenshot('03-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    const successHint = await page.locator('text=/Dashboard|Logout|Sign out|控制台|面板/i').first().count();
    const stillOnLogin = /\/auth\/login/i.test(url);

    if (!stillOnLogin || successHint > 0) {
      await notifyTelegram({
        ok: true,
        stage: '登录结果',
        msg: `判断为成功。当前 URL：${url}`,
        screenshotPath: spAfter
      });
      console.log('[OK] 登录成功或疑似成功：', url);
      process.exitCode = 0;
      return;
    }

    // 若还在登录页，进一步检测错误提示
    const errorMsgNode = page.locator('text=/Invalid|incorrect|错误|失败|无效/i');
    const hasError = await errorMsgNode.count();
    const errorMsg = hasError ? await errorMsgNode.first().innerText().catch(() => '') : '';

    await notifyTelegram({
      ok: false,
      stage: '登录结果',
      msg: errorMsg ? `仍在登录页，疑似失败（${errorMsg}）` : '仍在登录页，疑似失败（未捕获到错误提示）',
      screenshotPath: spAfter
    });
    console.log('[FAIL] 登录失败或未通过验证；仍在登录页：', url);
    process.exitCode = 1;
  } catch (e) {
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch {}
    await notifyTelegram({
      ok: false,
      stage: '异常',
      msg: e?.message || String(e),
      screenshotPath: fs.existsSync(sp) ? sp : undefined
    });
    console.error('[ERROR]', e);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
