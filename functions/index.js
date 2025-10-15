/* eslint-disable */
const admin = require("firebase-admin");

// ★ v2 API を使用
const { onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

admin.initializeApp();

// ★ デフォルトオプション（東京）
setGlobalOptions({ region: "asia-northeast1", timeoutSeconds: 120, memory: "512MiB" });

const BUCKET = admin.storage().bucket();   // {projectId}.appspot.com

// Firestoreから当月データを集計してHTMLを作る
async function buildMonthlyHtml(uid, monthId) {
  const db = admin.firestore();
  // months/{YYYY-MM}
  const monthSnap = await db.doc(`users/${uid}/months/${monthId}`).get();
  const month = monthSnap.exists ? monthSnap.data() : { monthGoal: 0, monthTotal: 0 };
  // days/*
  const daysSnaps = await db.collection(`users/${uid}/days`).get();
  const rows = [];
  daysSnaps.forEach((doc) => {
    if (doc.id.startsWith(monthId)) {
      const d = doc.data();
      const goal = d.goal || 0;
      const total = d.total || 0;
      const pct = goal > 0 ? Math.floor((total / goal) * 100) : 0;
      rows.push({ day: doc.id, goal, total, pct });
    }
  });
  rows.sort((a, b) => a.day.localeCompare(b.day));

  const style = `
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Noto Sans JP", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 32px; }
      h1 { font-size: 20px; margin: 0 0 12px; }
      .muted { color:#555; font-size: 13px; line-height:1.6; }
      hr { border: none; border-top: 1px solid #ddd; margin: 12px 0 16px; }
      table { width:100%; border-collapse: collapse; font-size:13px; }
      th, td { text-align:left; padding:8px 6px; border-bottom:1px solid #eee; }
      th { background:#fafafa; font-weight:600; }
      .right { text-align:right; }
    </style>
  `;

  let rowsHtml = rows.map(r =>
    `<tr>
      <td>${r.day}</td>
      <td class="right">${r.goal.toLocaleString()}</td>
      <td class="right">${r.total.toLocaleString()}</td>
      <td class="right">${r.pct}</td>
    </tr>`).join("");

  if (rows.length === 0) {
    rowsHtml = `<tr><td colspan="4" class="muted">今月のデータがありません。</td></tr>`;
  }

  const pct = (month.monthGoal || 0) > 0
    ? Math.floor((month.monthTotal || 0) / (month.monthGoal || 1) * 100)
    : 0;

  const html = `
    <!doctype html>
    <html lang="ja">
    <head><meta charset="utf-8">${style}</head>
    <body>
      <h1>Daily Goal Tracker 月次レポート（${monthId}）</h1>
      <div class="muted">
        <div>今月の目標: ${(month.monthGoal || 0).toLocaleString()} 円</div>
        <div>今月の合計: ${(month.monthTotal || 0).toLocaleString()} 円</div>
        <div>達成率: ${pct}%</div>
        <div>対象月: ${monthId}</div>
      </div>
      <hr/>
      <table>
        <thead>
          <tr>
            <th>日付</th>
            <th class="right">日目標(円)</th>
            <th class="right">日合計(円)</th>
            <th class="right">達成率(%)</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </body>
    </html>
  `;
  return html;
}

async function getSignedUrl(file) {
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 60 * 60 * 1000, // 1h
  });
  return url;
}

// ★ v2 の onCall を使ってエクスポート
exports.generateMonthlyPdf = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("unauthenticated");
  }
  const monthId = typeof request.data?.monthId === "string" ? request.data.monthId : null;
  if (!monthId) {
    throw new Error("invalid-argument: monthId required");
  }

  const html = await buildMonthlyHtml(uid, monthId);

  // Puppeteer（@sparticuz/chromium）
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: ["domcontentloaded"] });
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "20mm", right: "12mm", bottom: "20mm", left: "12mm" },
  });
  await browser.close();

  const path = `reports/${uid}/${monthId}.pdf`;
  const file = BUCKET.file(path);
  await file.save(pdfBuffer, {
    contentType: "application/pdf",
    resumable: false,
    metadata: { cacheControl: "private, max-age=0" },
  });

  const url = await getSignedUrl(file);
  return { url, path };
});
