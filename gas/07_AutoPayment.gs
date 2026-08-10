/**
 * 07_AutoPayment.gs — 入金消込と督促の自動化
 *
 * 運用から人手を無くすための最後の一手。
 *
 *   1. 入金明細の取込 (4経路。設定した経路だけが動く)
 *        A. 「入金明細」シートに貼る           … 貼るだけ
 *        B. 入金通知メールの本文を解析          … 完全自動
 *        C. 明細CSVがメール添付で届く           … 完全自動
 *        D. Driveフォルダに置かれたCSVを読む     … 置くだけ / RPA等と組める
 *   2. 金額と振込名義で未入金の請求書に自動照合し、消し込む
 *   3. 判断が割れるものだけ「要確認」に残して人に回す
 *   4. 期日を過ぎた未入金へ自動で督促
 *
 * 誤消込を出さないための線引き:
 *   - 金額が請求残額と完全一致し、名義も一致 → 消し込む
 *   - 名義が違っても、同額の未入金が1件だけ   → 消し込む
 *   - 同額の未入金が複数ある                  → 消し込まず要確認
 */

// 貼り付け専用シート。同期で上書きされる「入金明細」とは分ける。
//   入金明細 … システムの取込結果 (同期のたびに上書き。読み取り専用)
//   入金貼付 … 運営が銀行CSVを貼る場所 (取り込んだら自動で空になる)
var PAYMENT_PASTE_SHEET = '入金貼付';

var BANKTX_HEADERS = [
  '入金日', '金額', '振込名義', '摘要', '識別', '取込元', '照合状態', '照合先請求番号', 'メモ', '照合日時'
];

var MATCH_STATUS_LABEL = {
  pending: '未処理', matched: '消込済', ambiguous: '⚠ 要確認',
  unmatched: '⚠ 該当なし', ignored: '対象外'
};

// =====================================================================
// 取込 A: シートに貼った明細を送る
// =====================================================================

/**
 * 「入金明細」シートの未処理行をシステムへ取り込む。
 * 銀行のCSVをそのまま貼れるよう、列名の揺れをある程度吸収する。
 */
function importPastedTransactions_() {
  var sh = ss_().getSheetByName(PAYMENT_PASTE_SHEET);
  if (!sh) return { sent: 0, skipped: 0 };
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { sent: 0, skipped: 0 };

  // 銀行CSVをそのまま貼れるよう、見出し行の位置と列名の揺れを吸収する
  var rows = parseBankTable_(values);
  if (rows.length === 0) {
    return { sent: 0, skipped: 0,
             error: '貼り付けた内容から「日付」「入金額」の列を判別できませんでした' };
  }

  var res = sendBankRows_(rows, 'csv');
  // 取り込んだら空にする。残しておくと毎回読み直すうえ、貼り替え時に混ざる。
  if (res.sent > 0 || res.skipped > 0) clearPasteSheet_(sh);
  return res;
}

/** 貼り付けシートを見出しだけ残して空にする */
function clearPasteSheet_(sh) {
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
}

/** 貼り付けシートを用意する (見出しと使い方を書いておく) */
function setupPasteSheet_() {
  var sh = getOrCreateSheet_(PAYMENT_PASTE_SHEET);
  if (sh.getLastRow() > 0) return sh;
  ensureGrid_(sh, 6, 50);
  sh.getRange(1, 1, 1, 5).setValues([['入金日', '入金額', '振込名義', '摘要', '残高']])
    .setFontWeight('bold').setBackground('#0369a1').setFontColor('#ffffff');
  sh.getRange(3, 1).setValue(
    '↑ 銀行からダウンロードしたCSVを、この見出しごと貼り付けてください（列名が違っても自動で判別します）。'
    + '取り込むと自動で空になります。結果は「入金明細」シートに出ます。')
    .setFontColor('#6b7280');
  sh.setFrozenRows(1);
  return sh;
}

function pickCol_(head, names) {
  // 完全一致 → 部分一致 の順に探す (銀行ごとの列名ゆれを吸収)
  for (var i = 0; i < names.length; i++) {
    var idx = head.indexOf(names[i]);
    if (idx >= 0) return idx;
  }
  for (var j = 0; j < names.length; j++) {
    for (var k = 0; k < head.length; k++) {
      if (head[k] && head[k].indexOf(names[j]) >= 0) return k;
    }
  }
  return -1;
}

// =====================================================================
// 取込 B: 銀行の入金通知メールから自動で拾う
// =====================================================================

/**
 * Gmail から入金通知メールを探して明細を取り込む。
 * 検索条件と抽出パターンは「⚙️設定」で変えられる。
 * 銀行ごとに文面が違うため、既定では何もしない (検索条件が空なら実行しない)。
 */
function importMailTransactions_() {
  var query = str_(getSetting_('入金通知メールの検索条件')).trim();
  if (!query) return { sent: 0, skipped: 0, disabled: true };

  var amountRe = buildRe_(getSetting_('入金通知: 金額の抽出'), /([0-9,]+)\s*円/);
  var nameRe   = buildRe_(getSetting_('入金通知: 名義の抽出'), /振込人[：:\s]*(.+)/);
  var dateRe   = buildRe_(getSetting_('入金通知: 日付の抽出'), /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);

  var threads = GmailApp.search(query, 0, 50);
  var rows = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var body = m.getPlainBody();
      var am = body.match(amountRe);
      if (!am) return;
      var amount = num_(am[1]);
      if (amount <= 0) return;

      var nm = body.match(nameRe);
      var dm = body.match(dateRe);
      var paidOn = dm
        ? (dm[1] + '-' + ('0' + dm[2]).slice(-2) + '-' + ('0' + dm[3]).slice(-2))
        : Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd');

      rows.push({
        paid_on: paidOn,
        amount: amount,
        payer_name: nm ? str_(nm[1]).trim() : '',
        memo: m.getSubject(),
        source: 'mail'
      });
    });
  });
  if (rows.length === 0) return { sent: 0, skipped: 0 };

  var sent = 0, dup = 0;
  chunk_(rows, 200).forEach(function (batch) {
    var res = api_('/gas/payments/import', 'post', { rows: batch });
    sent += res.imported || 0;
    dup += res.duplicated || 0;
  });
  return { sent: sent, skipped: dup };
}

/** 設定に正規表現があればそれを使い、無ければ既定を使う */
function buildRe_(setting, fallback) {
  var s = str_(setting).trim();
  if (!s) return fallback;
  try { return new RegExp(s); } catch (e) { return fallback; }
}

// =====================================================================
// 自動消込
// =====================================================================

// =====================================================================
// 取込 C: メール添付のCSVを自動で読む (銀行が明細を送ってくる場合)
// =====================================================================

/**
 * 明細CSVが添付されたメールを探し、そのまま取り込む。
 * 「貼る」操作すら不要にするための経路。
 * 銀行CSVは Shift_JIS が多いので、文字コードは設定で切り替える。
 */
function importAttachmentTransactions_() {
  var query = str_(getSetting_('明細CSVメールの検索条件')).trim();
  if (!query) return { sent: 0, skipped: 0, disabled: true };

  var enc = str_(getSetting_('明細CSVの文字コード')).trim() || 'Shift_JIS';
  var rows = [];
  GmailApp.search(query, 0, 20).forEach(function (t) {
    t.getMessages().forEach(function (m) {
      m.getAttachments().forEach(function (att) {
        var name = String(att.getName() || '');
        if (!/\.(csv|txt)$/i.test(name)) return;
        var text;
        try { text = att.getDataAsString(enc); }
        catch (e) { try { text = att.getDataAsString('UTF-8'); } catch (e2) { return; } }
        rows = rows.concat(parseBankCsv_(text));
      });
    });
  });
  return sendBankRows_(rows, 'mail');
}

// =====================================================================
// 取込 D: Drive フォルダに置かれたCSVを自動で読む
// =====================================================================

/**
 * 指定フォルダのCSVを取り込む。取り込んだファイルは名前の先頭に「取込済_」を付け、
 * 次回以降は読み飛ばす (同じ明細は指紋で二重取込されないが、無駄な読み込みを避ける)。
 */
function importDriveTransactions_() {
  var folderId = str_(getSetting_('明細CSVのDriveフォルダID')).trim();
  if (!folderId) return { sent: 0, skipped: 0, disabled: true };

  var enc = str_(getSetting_('明細CSVの文字コード')).trim() || 'Shift_JIS';
  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (e) { return { sent: 0, skipped: 0, error: 'Driveフォルダを開けません: ' + e.message }; }

  var rows = [], done = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    if (/^取込済_/.test(name) || !/\.(csv|txt)$/i.test(name)) continue;
    var text;
    try { text = f.getBlob().getDataAsString(enc); }
    catch (e) { try { text = f.getBlob().getDataAsString('UTF-8'); } catch (e2) { continue; } }
    rows = rows.concat(parseBankCsv_(text));
    done.push(f);
  }
  var res = sendBankRows_(rows, 'csv');
  done.forEach(function (f) { try { f.setName('取込済_' + f.getName()); } catch (e) {} });
  return res;
}

/**
 * 銀行CSVを解析して明細の配列にする。
 * 銀行ごとに列名が違うため、見出し行から日付・金額・名義の列を推定する。
 * 出金行 (金額が負 or 出金列) は無視する。
 */
function parseBankCsv_(text) {
  var table;
  try { table = Utilities.parseCsv(text); } catch (e) { return []; }
  return parseBankTable_(table);
}

/** 二次元配列の銀行明細を解析する (CSVでも貼り付けでも同じ処理を通す) */
function parseBankTable_(table) {
  if (!table || table.length < 2) return [];

  // 見出し行を探す (先頭5行のうち、日付らしき列名を含む行)
  var head = -1;
  for (var i = 0; i < Math.min(table.length, 5); i++) {
    var joined = table[i].join(',');
    if (/日付|取引日|入出金日|勘定日|年月日/.test(joined)) { head = i; break; }
  }
  if (head < 0) return [];

  var h = table[head].map(function (x) { return String(x).trim(); });
  var iDate = pickCol_(h, ['入金日', '取引日', '入出金日', '勘定日', '日付', '取引年月日']);
  var iIn   = pickCol_(h, ['入金金額', 'お預入金額', '入金', '預入金額', '入金額']);
  var iAmt  = iIn >= 0 ? iIn : pickCol_(h, ['金額', '取引金額']);
  var iName = pickCol_(h, ['振込依頼人', 'お取引内容', '摘要', '内容', '振込人名', '取引内容']);
  var iMemo = pickCol_(h, ['備考', 'メモ']);
  var iRef  = pickCol_(h, ['残高', '取引番号', '取引No', '照会番号']);
  if (iDate < 0 || iAmt < 0) return [];

  var out = [];
  for (var r = head + 1; r < table.length; r++) {
    var row = table[r];
    if (!row || row.length === 0) continue;
    var d = ymd_(row[iDate]);
    var a = num_(row[iAmt]);
    if (!d || a <= 0) continue;      // 空行・出金行は無視
    out.push({
      paid_on: d,
      amount: a,
      payer_name: iName >= 0 ? str_(row[iName]).trim() : '',
      memo: iMemo >= 0 ? str_(row[iMemo]).trim() : '',
      // 残高や取引番号があれば取引の識別に使う。
      // 同日・同額・同名義の入金が2本あるとき、これが無いと1本に潰れる。
      ref: iRef >= 0 ? str_(row[iRef]).trim() : '',
      source: 'csv'
    });
  }
  return out;
}

/** 明細をまとめてAPIへ送る */
function sendBankRows_(rows, source) {
  if (!rows || rows.length === 0) return { sent: 0, skipped: 0 };
  var sent = 0, dup = 0;
  chunk_(rows, 200).forEach(function (batch) {
    batch.forEach(function (b) { if (source) b.source = b.source || source; });
    var res = api_('/gas/payments/import', 'post', { rows: batch });
    sent += res.imported || 0;
    dup += res.duplicated || 0;
  });
  return { sent: sent, skipped: dup };
}

/**
 * 取込 → 自動照合 まで一気に行う。トリガーからも呼べるよう UI に触れない。
 * @return {{imported:number, matched:number, ambiguous:number, unmatched:number}}
 */
function autoReconcile_core_() {
  var a = importPastedTransactions_();      // シートに貼った明細
  var b = importMailTransactions_();        // 入金通知メールの本文
  var c = importAttachmentTransactions_();  // メール添付のCSV
  var d = importDriveTransactions_();       // Driveフォルダのcsv
  var res = api_('/gas/payments/match', 'post', {});
  return {
    imported: (a.sent || 0) + (b.sent || 0) + (c.sent || 0) + (d.sent || 0),
    duplicated: (a.skipped || 0) + (b.skipped || 0) + (c.skipped || 0) + (d.skipped || 0),
    matched: res.matched || 0,
    ambiguous: res.ambiguous || 0,
    unmatched: res.unmatched || 0,
    matched_list: res.matched_list || [],
    ambiguous_list: res.ambiguous_list || [],
    importError: a.error || d.error || null
  };
}

/** メニュー: 入金を自動で消し込む */
function autoReconcilePayments() {
  return guard_('入金の自動消込', function () {
    var ui = SpreadsheetApp.getUi();
    var r = autoReconcile_core_();
    syncAll_quiet_();

    var msg = '入金の自動消込を実行しました。\n\n'
      + '取込: ' + r.imported + '件' + (r.duplicated ? '（取込済みを除く ' + r.duplicated + '件）' : '') + '\n'
      + '消込: ' + r.matched + '件\n'
      + '⚠ 要確認: ' + r.ambiguous + '件\n'
      + '⚠ 該当なし: ' + r.unmatched + '件';
    if (r.matched_list.length) {
      msg += '\n\n【消し込んだ入金】\n'
        + r.matched_list.slice(0, 15).map(function (x) {
            return '・' + str_(x.invoice_no) + '  ¥' + Number(num_(x.amount)).toLocaleString()
                   + '  ' + str_(x.payer_name);
          }).join('\n');
    }
    if (r.ambiguous + r.unmatched > 0) {
      msg += '\n\n「' + SHEETS.BANK + '」シートで要確認の行をご確認ください。';
    }
    if (r.importError) msg += '\n\n⚠ ' + r.importError;
    ui.alert(msg);
  });
}

// =====================================================================
// 自動督促
// =====================================================================

/**
 * 期日を過ぎた未入金に督促を送る。
 * 請求書の自動送信設定に合わせ、既定では下書きを作るだけにする。
 * @return {{created:string[], sent:string[], skipped:string[]}}
 */
function sendReminders_core_() {
  var list = api_('/gas/invoices/overdue', 'get').invoices || [];
  // 請求書の下書きと同じくGmailの1日あたり上限に当たらないよう分割する
  var limit = Math.max(1, num_(getSetting_('1回に作る下書きの上限')) || DRAFT_LIMIT_DEFAULT);
  var remaining = Math.max(list.length - limit, 0);
  if (list.length > limit) list = list.slice(0, limit);

  var issuer = issuerInfo_();
  var autoSend = autoSendEnabled_();
  var created = [], sent = [], skipped = [];

  list.forEach(function (x) {
    var to = str_(x.billing_email).trim();
    if (!to) { skipped.push(str_(x.invoice_no) + ': 請求先メール未登録'); return; }
    try {
      var subject = '【ラクシフトAI】お支払いのご確認のお願い（' + str_(x.invoice_no) + '）';
      var body = str_(x.company_name || x.shop_name) + ' 御中\n\n'
        + 'いつもラクシフトAIをご利用いただきありがとうございます。\n'
        + '下記のご請求につきまして、本日時点でご入金の確認がとれておりません。\n\n'
        + '─────────────────────\n'
        + '請求番号 : ' + str_(x.invoice_no) + '\n'
        + 'ご請求額 : ¥' + Number(num_(x.balance)).toLocaleString() + '（未入金分）\n'
        + 'お支払期限: ' + jpDate_(x.due_date) + '（' + num_(x.days_overdue) + '日経過）\n'
        + '─────────────────────\n\n'
        + (issuer.bank ? 'お振込先:\n' + issuer.bank + '\n\n' : '')
        + '※ 本メールと行き違いでお振込みいただいている場合は、何卒ご容赦ください。\n'
        + 'ご不明な点がございましたら、本メールにご返信ください。\n\n'
        + issuer.name + '\n'
        + (issuer.tel ? 'TEL: ' + issuer.tel + '\n' : '');

      if (autoSend) {
        GmailApp.sendEmail(to, subject, body, { name: issuer.name });
        sent.push(str_(x.invoice_no));
      } else {
        GmailApp.createDraft(to, subject, body, { name: issuer.name });
      }
      created.push(str_(x.invoice_no));
    } catch (e) {
      skipped.push(str_(x.invoice_no) + ': ' + e.message);
    }
  });

  if (created.length > 0) {
    api_('/gas/invoices/mark-reminded', 'post', { invoice_nos: created });
  }
  return { created: created, sent: sent, skipped: skipped, remaining: remaining };
}

/** メニュー: 期日超過に督促 */
function sendOverdueReminders() {
  return guard_('支払督促', function () {
    var ui = SpreadsheetApp.getUi();
    var list = api_('/gas/invoices/overdue', 'get').invoices || [];
    if (list.length === 0) { ui.alert('督促の対象はありません。'); return; }

    var willSend = autoSendEnabled_();
    if (ui.alert(willSend ? '督促メールの送信' : '督促メールの下書き作成',
                 list.length + ' 件の期日超過があります。\n\n'
                 + list.slice(0, 10).map(function (x) {
                     return '・' + str_(x.company_name || x.shop_name) + '  ¥'
                            + Number(num_(x.balance)).toLocaleString()
                            + '（' + num_(x.days_overdue) + '日経過）';
                   }).join('\n')
                 + (list.length > 10 ? '\n… ほか ' + (list.length - 10) + ' 件' : '')
                 + (willSend ? '\n\n⚠ 自動送信がONのため、顧客へ直接送信します。'
                             : '\n\n下書きを作成します。内容を確認してから送信してください。')
                 + '\n\nよろしいですか？',
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    var r = sendReminders_core_();
    syncAll_quiet_();
    ui.alert((r.sent.length ? '督促メールを送信しました。' : '督促の下書きを作成しました。') + '\n\n'
             + (r.sent.length ? '送信: ' + r.sent.length + '件' : '作成: ' + r.created.length + '件')
             + ' / スキップ: ' + r.skipped.length + '件'
             + (r.skipped.length ? '\n\n【スキップ】\n' + r.skipped.slice(0, 10).join('\n') : ''));
  });
}

// =====================================================================
// 入金明細シート
// =====================================================================

function syncBankTransactions_(list) {
  var rows = (list || []).map(function (x) {
    return [
      ymd_(x.paid_on),
      num_(x.amount),
      str_(x.payer_name),
      str_(x.memo),
      str_(x.ref),
      x.source === 'mail' ? 'メール' : (x.source === 'manual' ? '手動' : 'CSV'),
      MATCH_STATUS_LABEL[x.match_status] || str_(x.match_status),
      str_(x.matched_invoice_no),
      str_(x.match_note),
      ymdhm_(x.matched_at)
    ];
  });
  var sh = writeSheet_(SHEETS.BANK, BANKTX_HEADERS, rows, {
    headerColor: '#0369a1',
    numberFormats: { '金額': '#,##0', '入金日': 'yyyy-mm-dd' }
  });
  applyFilter_(sh, BANKTX_HEADERS.length, rows.length);

  // 要確認・該当なしを目立たせる
  var iSt = BANKTX_HEADERS.indexOf('照合状態');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][iSt]).indexOf('⚠') === 0) {
      sh.getRange(i + 2, 1, 1, BANKTX_HEADERS.length).setBackground('#fff7ed');
    }
  }
  if (rows.length > 0) {
    var ng = rows.filter(function (r) { return String(r[iSt]).indexOf('⚠') === 0; }).length;
    sh.getRange(rows.length + 2, 1)
      .setValue(ng > 0 ? ('要確認 ' + ng + '件 — 請求番号を「照合先請求番号」に入れて「入金を反映」してください')
                       : 'すべて消込済み')
      .setFontWeight('bold');
  }
}
