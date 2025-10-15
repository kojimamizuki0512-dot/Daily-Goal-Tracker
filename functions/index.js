/* eslint-disable */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

// Functions 共通設定（東京 / 余裕めのリソース）
setGlobalOptions({
  region: "asia-northeast1",
  timeoutSeconds: 300,
  memory: "1GiB",
});

// 実行モード
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

// ---- レポートHTML組み立て（フロントから渡すデータをそのまま使う） ----
function buildMonthlyHtml(payload) {
  const { monthId, monthGoal = 0, monthTotal = 0, rows = [] } = payload;

  const style = `
    <style>
      @page { size: A4; margin: 20mm 12mm; }
      body { font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP","Segoe UI",Roboto,Helvetica,Arial,sans-serif; margin:0; }
      h1 { font-size: 20px; margin: 20px 12px 12px; }
      .muted { color:#555; font-size:13px; line-height:1.6; padding:0 12px; }
      hr { border:none; border-top:1px solid #ddd; margin:12px 0 16px; }
      table { width:100%; border-collapse: collapse; font-size:13px; }
      th,td { text-align:left; padding:8px 6px; border-bottom:1px solid #eee; }
      th { background:#fafafa; font-weight:600; }
      .right { text-align:right; }
    </style>
  `;

  let rowsHtml = rows.map(r => `
    <tr>
      <td>${r.day}</td>
      <td class="right">${(r.goal||0).toLocaleString()}</td>
      <td class="right">${(r.total||0).toLocaleString()}</td>
      <td class="right">${r.pct||0}</td>
    </tr>
  `).join("");

  if (rows.length === 0) {
    rowsHtml = `<tr><td colspan="4" class="muted">今月のデータがありません。</td></tr>`;
  }

  const pct = monthGoal > 0 ? Math.floor((monthTotal || 0) / monthGoal * 100) : 0;

  return `
    <!doctype html>
    <html lang="ja"><head><meta charset="utf-8">${style}</head>
    <body>
      <h1>Daily Goal Tracker 月次レポート（${monthId}）</h1>
      <div class="muted">
        <div>今月の目標: ${Number(monthGoal||0).toLocaleString()} 円</div>
        <div>今月の合計: ${Number(monthTotal||0).toLocaleString()} 円</div>
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
    </body></html>
  `;
}

// ---- 生成API（Storage 不使用 / base64 返却） ----
exports.generateMonthlyPdf = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインが必要です。");

  // フロント側で既に集計済みのデータをそのまま受け取る
  const payload = request.data;
  if (!payload?.monthId) throw new HttpsError("invalid-argument", "monthId がありません。");

  try {
    const html = buildMonthlyHtml(payload);

    const executablePath = await chromium.executablePath();
    process.env.PUPPETEER_EXECUTABLE_PATH = executablePath;

    const browser = await puppeteer.launch({
      executablePath,
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
      args: [
        ...chromium.args,
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-gpu", "--disable-dev-shm-usage",
        "--single-process", "--no-zygote",
      ],
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    await page.goto(dataUrl, { waitUntil: ["load","domcontentloaded","networkidle0"] });
    await page.emulateMediaType("screen");

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", right: "12mm", bottom: "20mm", left: "12mm" },
    });

    await browser.close();

    const base64 = pdfBuffer.toString("base64");
    const filename = `DailyGoalTracker_${payload.monthId}.pdf`;
    return { base64, filename };
  } catch (err) {
    console.error("generateMonthlyPdf failed:", err);
    throw new HttpsError("internal", `PDF生成エラー: ${err?.message || String(err)}`);
  }
});
