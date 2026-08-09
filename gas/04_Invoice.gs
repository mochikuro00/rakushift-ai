/**
 * 04_Invoice.gs — 請求書の一括生成 と Gmail下書き作成
 *
 * 請求書払い / OEM の顧客について、
 *   1. 対象月の請求書をシステム側で一括生成
 *   2. 請求書PDFを組み立て、宛先・件名・本文込みで Gmail の「下書き」に入れる
 * 運営は下書きを確認してから送信するだけでよい。
 *
 * 下書きを作った請求書にはシステム側で印（下書き作成日時）が付き、
 * 二重に下書きが作られることはない。
 */

function generateInvoicesForMonth() {
  return guard_('請求書の一括生成', function () {
    var ui = SpreadsheetApp.getUi();
    var month = targetMonth_();
    if (ui.alert('請求書の一括生成',
                 month + ' の請求書を生成します。\n\n'
                 + '対象: 請求書払い・OEM代理店 の稼働中テナント\n'
                 + '（同じ月の請求書が既にある顧客はスキップされます）\n\nよろしいですか？',
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    var res = api_('/gas/invoices/generate', 'post', { month: month });
    syncAll_quiet_();
    var msg = '請求書を生成しました（' + str_(res.month || month) + '）\n\n'
      + '新規作成: ' + (res.created || 0) + '件\n'
      + '既存のためスキップ: ' + (res.skipped || 0) + '件';
    if (res.no_price_count > 0) {
      msg += '\n\n⚠ プラン未設定のため作成できなかった顧客: ' + res.no_price_count + '件\n'
           + (res.no_price_contracts || []).join(', ')
           + '\n運営コンソールでプランを設定してから再実行してください。';
    }
    ui.alert(msg);
  });
}

/**
 * 未送付の請求書について Gmail 下書きを作成する。
 * 対象: 対象月の請求のうち「下書き作成」が空 かつ 状態が入金済/無効でないもの。
 */
function createInvoiceDrafts() {
  return guard_('請求書の下書き作成', function () {
    var ui = SpreadsheetApp.getUi();
    var month = targetMonth_();
    var sheet = readSheet_(SHEETS.INVOICES);

    var targets = sheet.rows.filter(function (r) {
      if (str_(r['対象月']).slice(0, 7) !== month) return false;
      if (str_(r['下書き作成']).trim() !== '') return false;
      if (r['状態'] === '入金済' || r['状態'] === '無効') return false;
      return str_(r['請求番号']).trim() !== '';
    });

    if (targets.length === 0) {
      ui.alert('下書きを作成する請求書がありません。\n\n'
               + '対象月: ' + month + '\n'
               + '（すでに下書き済み、または請求書が未生成の可能性があります）');
      return;
    }

    var noEmail = targets.filter(function (r) { return !str_(r['請求先メール']).trim(); });
    if (ui.alert('請求書のGmail下書き作成',
                 targets.length + ' 件の請求書について、PDFを添付したGmail下書きを作成します。\n'
                 + (noEmail.length ? '\n⚠ 請求先メール未登録が ' + noEmail.length + ' 件あり、これらはスキップされます。\n' : '')
                 + '\n作成後、Gmailの「下書き」で内容を確認してから送信してください。\n\nよろしいですか？',
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    var issuer = issuerInfo_();
    var created = [], skipped = [];

    targets.forEach(function (r) {
      var to = str_(r['請求先メール']).trim();
      if (!to) { skipped.push(str_(r['請求番号']) + ': 請求先メール未登録'); return; }
      try {
        var pdf = buildInvoicePdf_(r, issuer);
        var subject = fillTemplate_(
          str_(getSetting_('請求書メール件名')) || '【ラクシフトAI】{対象月}分 ご請求書のご送付', r);
        var body = str_(getSetting_('請求書メール本文')) || defaultMailBody_(r, issuer);
        var options = { attachments: [pdf], name: issuer.name };
        var cc = str_(getSetting_('CC')).trim();
        if (cc) options.cc = cc;

        GmailApp.createDraft(to, subject, fillTemplate_(body, r), options);
        created.push(str_(r['請求番号']));
      } catch (e) {
        skipped.push(str_(r['請求番号']) + ': ' + e.message);
      }
    });

    if (created.length > 0) {
      api_('/gas/invoices/mark-drafted', 'post', { invoice_nos: created });
      syncAll_quiet_();
    }

    ui.alert('Gmail下書きを作成しました。\n\n'
             + '作成: ' + created.length + '件 / スキップ: ' + skipped.length + '件\n'
             + (skipped.length ? '\n【スキップ】\n' + skipped.slice(0, 15).join('\n') : '')
             + '\n\nGmailの「下書き」を開いて内容を確認のうえ送信してください。');
  });
}

// ---------------------------------------------------------------------
// 請求書PDF
// ---------------------------------------------------------------------

function issuerInfo_() {
  return {
    name: str_(getSetting_('自社名')) || 'ラクシフトAI',
    address: str_(getSetting_('自社住所')),
    tel: str_(getSetting_('自社電話')),
    regNo: str_(getSetting_('インボイス登録番号')),
    bank: str_(getSetting_('振込先'))
  };
}

function fillTemplate_(template, r) {
  return String(template)
    .replace(/\{対象月\}/g, str_(r['対象月']))
    .replace(/\{顧客名\}/g, str_(r['会社名']) || str_(r['顧客名']))
    .replace(/\{請求番号\}/g, str_(r['請求番号']))
    .replace(/\{金額\}/g, '¥' + Number(num_(r['請求額(税込)'])).toLocaleString())
    .replace(/\{支払期限\}/g, ymd_(r['支払期限']));
}

function defaultMailBody_(r, issuer) {
  return '{顧客名} 御中\n\n'
    + 'いつもラクシフトAIをご利用いただきありがとうございます。\n'
    + '{対象月}分のご請求書をお送りいたします。\n\n'
    + '─────────────────────\n'
    + '請求番号 : {請求番号}\n'
    + 'ご請求額 : {金額}（税込）\n'
    + 'お支払期限: {支払期限}\n'
    + '─────────────────────\n\n'
    + (issuer.bank ? 'お振込先:\n' + issuer.bank + '\n\n' : '')
    + '※ 恐れ入りますが、振込手数料は貴社にてご負担をお願いいたします。\n'
    + '※ 本メールと行き違いでお振込みいただいている場合は、何卒ご容赦ください。\n\n'
    + 'ご不明な点がございましたら、本メールにご返信ください。\n\n'
    + issuer.name + '\n'
    + (issuer.address ? issuer.address + '\n' : '')
    + (issuer.tel ? 'TEL: ' + issuer.tel + '\n' : '');
}

/** 請求書1件分のPDF (適格請求書の記載事項を満たす体裁) */
function buildInvoicePdf_(r, issuer) {
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var yen = function (n) { return '¥' + Number(num_(n)).toLocaleString(); };

  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + 'body{font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN","Meiryo",sans-serif;'
    + 'font-size:11pt;color:#111;margin:32px;}'
    + 'h1{font-size:22pt;letter-spacing:8px;text-align:center;margin:0 0 24px;}'
    + '.row{display:flex;justify-content:space-between;align-items:flex-start;}'
    + '.cust{font-size:14pt;font-weight:bold;border-bottom:2px solid #111;padding-bottom:4px;'
    + 'display:inline-block;min-width:280px;}'
    + '.meta td{padding:2px 4px;font-size:10pt;}'
    + '.total{font-size:18pt;font-weight:bold;border:2px solid #111;padding:10px 18px;'
    + 'display:inline-block;margin:18px 0;}'
    + 'table.items{width:100%;border-collapse:collapse;margin-top:12px;}'
    + 'table.items th{background:#1f2937;color:#fff;padding:8px;font-size:10pt;}'
    + 'table.items td{border:1px solid #cbd5e1;padding:8px;font-size:10pt;}'
    + '.right{text-align:right;}.center{text-align:center;}'
    + '.box{border:1px solid #cbd5e1;padding:12px;margin-top:20px;font-size:10pt;}'
    + '.note{font-size:9pt;color:#555;margin-top:16px;}'
    + '</style></head><body>'
    + '<h1>請 求 書</h1>'
    + '<div class="row"><div>'
    + '<div class="cust">' + esc(str_(r['会社名']) || str_(r['顧客名'])) + ' 御中</div>'
    + '<div style="margin-top:10px;font-size:10pt;">下記のとおりご請求申し上げます。</div>'
    + '</div><div><table class="meta">'
    + '<tr><td>請求番号</td><td>' + esc(r['請求番号']) + '</td></tr>'
    + '<tr><td>発行日</td><td>' + esc(ymd_(r['発行日'])) + '</td></tr>'
    + '<tr><td>支払期限</td><td>' + esc(ymd_(r['支払期限'])) + '</td></tr>'
    + '</table></div></div>'
    + '<div class="total">ご請求金額　' + yen(r['請求額(税込)']) + '（税込）</div>'
    + '<table class="items"><thead><tr>'
    + '<th>品目</th><th>対象月</th><th class="center">数量</th>'
    + '<th class="right">単価</th><th class="right">金額</th></tr></thead><tbody>'
    + '<tr><td>ラクシフトAI 利用料（' + esc(r['プラン']) + '）</td>'
    + '<td class="center">' + esc(r['対象月']) + '</td>'
    + '<td class="center">' + esc(r['数量']) + '</td>'
    + '<td class="right">' + yen(r['単価']) + '</td>'
    + '<td class="right">' + yen(num_(r['単価']) * num_(r['数量'])) + '</td></tr>'
    + '<tr><td colspan="4" class="right">小計（税抜）</td>'
    + '<td class="right">' + yen(r['小計(税抜)']) + '</td></tr>'
    + '<tr><td colspan="4" class="right">消費税（10%）</td>'
    + '<td class="right">' + yen(r['消費税']) + '</td></tr>'
    + '<tr><td colspan="4" class="right" style="font-weight:bold;">合計（税込）</td>'
    + '<td class="right" style="font-weight:bold;">' + yen(r['請求額(税込)']) + '</td></tr>'
    + '</tbody></table>'
    + (issuer.bank ? '<div class="box"><b>お振込先</b><br>' + esc(issuer.bank)
       + '<br><span class="note">※ 振込手数料は貴社にてご負担をお願いいたします。</span></div>' : '')
    + '<div class="box"><b>' + esc(issuer.name) + '</b><br>'
    + (issuer.address ? esc(issuer.address) + '<br>' : '')
    + (issuer.tel ? 'TEL: ' + esc(issuer.tel) + '<br>' : '')
    + (issuer.regNo ? '登録番号: ' + esc(issuer.regNo) : '')
    + '</div>'
    + '<div class="note">10%対象: ' + yen(r['小計(税抜)']) + '（消費税 ' + yen(r['消費税']) + '）</div>'
    + '</body></html>';

  return Utilities.newBlob(html, 'text/html', 'invoice.html')
    .getAs('application/pdf')
    .setName('請求書_' + str_(r['請求番号']) + '_' + (str_(r['会社名']) || str_(r['顧客名'])) + '.pdf');
}
