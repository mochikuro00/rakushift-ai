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

// 照合先請求番号は運営が要確認行を手で紐付けるための入力欄。
// 明細IDは書き戻し先を特定するために持つ (運営は触らない)。
var BANKTX_HEADERS = [
  '入金日', '金額', '振込名義', '摘要', '識別', '取込元', '照合状態', '照合先請求番号',
  'メモ', '照合日時', '明細ID'
];
var BANKTX_EDITABLE = ['照合先請求番号'];

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
    '↑ 銀行からダウンロードしたCSVを2行目以降に貼り付けてください。'
    + '銀行側の見出しごと貼っても、上の見出しに合わせてデータだけ貼っても取り込めます（列名は自動で判別します）。'
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
        // 検索条件は newer_than:7d のように期間で書くため、同じ通知メールが
        // 毎朝ヒットする。メッセージIDを識別子にして二重取込を止める。
        ref: m.getId(),
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
        // 添付CSVも同じメールが毎朝ヒットする。明細に取引番号が無い銀行のために
        // 「メッセージID#行番号」を識別子として補う。
        var parsed = parseBankCsv_(text);
        parsed.forEach(function (b, i) { b.ref = b.ref || (m.getId() + '#' + i); });
        rows = rows.concat(parsed);
      });
    });
  });
  return sendBankRows_(rows, 'mail');
}

// =====================================================================
// 取込 D: Drive フォルダに置かれたCSVを自動で読む
// =====================================================================

var PROP_DRIVE_DONE = 'IMPORTED_DRIVE_FILES';
var DRIVE_DONE_KEEP = 500;

/**
 * 指定フォルダのCSVを取り込む。
 *
 * 取り込み済みの目印はファイル名ではなくスクリプトプロパティに持つ。
 * このスクリプトのDrive権限は読み取り (drive.readonly) だけなので、
 * ファイル名の変更は必ず失敗し、目印として使えない。
 * 更新日時も鍵に含め、同じファイルが差し替えられたら読み直す。
 */
function importDriveTransactions_() {
  var folderId = str_(getSetting_('明細CSVのDriveフォルダID')).trim();
  if (!folderId) return { sent: 0, skipped: 0, disabled: true };

  var enc = str_(getSetting_('明細CSVの文字コード')).trim() || 'Shift_JIS';
  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (e) { return { sent: 0, skipped: 0, error: 'Driveフォルダを開けません: ' + e.message }; }

  var props = PropertiesService.getScriptProperties();
  var done = [];
  try { done = JSON.parse(props.getProperty(PROP_DRIVE_DONE) || '[]'); } catch (e) { done = []; }
  var seen = {};
  done.forEach(function (k) { seen[k] = true; });

  var rows = [], added = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (!/\.(csv|txt)$/i.test(f.getName())) continue;
    var key = f.getId() + '|' + f.getLastUpdated().getTime();
    if (seen[key]) continue;
    var text;
    try { text = f.getBlob().getDataAsString(enc); }
    catch (e) { try { text = f.getBlob().getDataAsString('UTF-8'); } catch (e2) { continue; } }
    // 取引番号を持たない明細のために、ファイル単位で一意な識別子を補う
    var parsed = parseBankCsv_(text);
    parsed.forEach(function (b, i) { b.ref = b.ref || (f.getId() + '#' + i); });
    rows = rows.concat(parsed);
    added.push(key);
  }
  var res = sendBankRows_(rows, 'csv');
  if (added.length) {
    // 送信できた分だけを済みにする。落ちた場合は次回また読む。
    props.setProperty(PROP_DRIVE_DONE,
                      JSON.stringify(done.concat(added).slice(-DRIVE_DONE_KEEP)));
  }
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

  // 見出し行を探す。
  //
  // 「入金貼付」シートには案内用のテンプレ見出し (入金日/入金額/…) が1行目に固定で入っており、
  // 運営はその下に銀行CSVを見出しごと貼る。先頭から探すとテンプレ側を掴んでしまい、
  // 列順の違う銀行CSVを取り違えて読む。後ろの行から探して、銀行の見出しを優先する。
  // 日付列と金額列の両方が取れた行だけを見出しとして採用する。
  var DATE_NAMES = ['入金日', '取引日', '入出金日', '勘定日', '取引年月日', '年月日', '日付'];
  // 「入金」は '入金日' にも部分一致してしまうため、より具体的な名前の後ろに置く
  var IN_NAMES   = ['入金金額', 'お預入金額', '預入金額', '入金額', '入金'];

  var head = -1, h = null, iDate = -1, iAmt = -1;
  for (var i = Math.min(table.length, 6) - 1; i >= 0; i--) {
    var cand = table[i].map(function (x) { return String(x).trim(); });
    var d = pickCol_(cand, DATE_NAMES);
    if (d < 0) continue;
    var a = pickCol_(cand, IN_NAMES);
    if (a < 0) a = pickCol_(cand, ['金額', '取引金額']);
    if (a < 0 || a === d) continue;      // 金額列が日付列と同じなら部分一致の誤判定
    head = i; h = cand; iDate = d; iAmt = a;
    break;
  }
  if (head < 0) return [];

  // 名義そのものを指す列を先に見る。'摘要' を先頭側に置くと、
  // 振込名義の列がある明細でも摘要を名義として拾ってしまう。
  var iName = pickCol_(h, ['振込名義', '振込依頼人', '振込人名', 'お取引内容', '取引内容', '内容', '摘要']);
  var iMemo = pickCol_(h, ['備考', 'メモ']);
  var iRef  = pickCol_(h, ['残高', '取引番号', '取引No', '照会番号']);

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

/**
 * 明細をまとめてAPIへ送る。
 *
 * 取引番号を持たない銀行のために、識別子が空の行には
 * 「この取込の中で同じ内容が何本目か」を振る。
 * 同日・同額・同名義の2本を別の入金として扱いつつ、
 * 同じCSVを貼り直しても同じ識別子になるので二重取込にならない。
 * (件数を毎回DBから数えると、貼り直すたびに番号がずれて指紋が別物になる)
 */
function sendBankRows_(rows, source) {
  if (!rows || rows.length === 0) return { sent: 0, skipped: 0 };

  var seq = {};
  rows.forEach(function (b) {
    if (str_(b.ref).trim()) return;
    var key = [b.paid_on, b.amount, str_(b.payer_name).trim(), str_(b.memo).trim()].join('|');
    seq[key] = (seq[key] || 0) + 1;
    b.ref = '#' + seq[key];
  });

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
    overPaid: res.over_paid || 0,
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
      + '⚠ 該当なし: ' + r.unmatched + '件'
      + (r.overPaid ? '\n⚠ 請求額を超える入金: ' + r.overPaid + '件（超過分は未充当）' : '');
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
  var deferred = Math.max(list.length - limit, 0);
  if (list.length > limit) list = list.slice(0, limit);

  var issuer = issuerInfo_();
  var autoSend = autoSendEnabled_();
  var created = [], sent = [], skipped = [];
  var start = Date.now();
  var i = 0;

  for (; i < list.length; i++) {
    // 実行時間の上限で強制終了されると督促の記録が残らず、
    // 回数上限(3回)の判定を素通りして毎朝同じ顧客に届いてしまう。
    if (Date.now() - start > MAIL_LOOP_BUDGET_MS) break;

    var x = list[i];
    var no = str_(x.invoice_no);
    var to = str_(x.billing_email).trim();
    if (!to) { skipped.push(no + ': 請求先メール未登録'); continue; }
    try {
      var subject = '【ラクシフトAI】お支払いのご確認のお願い（' + no + '）';
      var body = str_(x.company_name || x.shop_name) + ' 御中\n\n'
        + 'いつもラクシフトAIをご利用いただきありがとうございます。\n'
        + '下記のご請求につきまして、本日時点でご入金の確認がとれておりません。\n\n'
        + '─────────────────────\n'
        + '請求番号 : ' + no + '\n'
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
        sent.push(no);
      } else {
        GmailApp.createDraft(to, subject, body, { name: issuer.name });
      }
      created.push(no);
    } catch (e) {
      skipped.push(no + ': ' + e.message);
      continue;
    }

    // 送信の直後に1件ずつ記録する (まとめて記録すると途中終了で全件が再送になる)
    try {
      api_('/gas/invoices/mark-reminded', 'post', { invoice_nos: [no] });
    } catch (e) {
      skipped.push(no + ': 督促は出しましたが記録に失敗しました (' + e.message + ')');
    }
  }

  return { created: created, sent: sent, skipped: skipped,
           remaining: deferred + (list.length - i) };
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
      ymdhm_(x.matched_at),
      str_(x.id)
    ];
  });

  // 要確認行に入れた請求番号も、同期で消えないよう退避・復元する
  var pending = pendingEdits_(SHEETS.BANK, '明細ID', BANKTX_EDITABLE);
  stageSnapshot_(SHEETS.BANK, BANKTX_HEADERS, rows, '明細ID', BANKTX_EDITABLE);

  var sh = writeSheet_(SHEETS.BANK, BANKTX_HEADERS, rows, {
    editable: BANKTX_EDITABLE,
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
      .setValue(ng > 0 ? ('要確認 ' + ng + '件 — 請求番号を「照合先請求番号」に入れて'
                          + 'メニューの「💰 入金を手動で反映（消込）」を実行してください')
                       : 'すべて消込済み')
      .setFontWeight('bold');
  }

  countRestoredEdits_(
    restorePendingEdits_(sh, BANKTX_HEADERS, rows, '明細ID', pending));
}

/**
 * 「入金明細」シートで運営が手で紐付けた要確認行をシステムへ反映する。
 * @return {{updated:number, failures:string[]}}
 */
function pushBankAssignments_() {
  var sheet = readSheet_(SHEETS.BANK);
  var targets = [];
  sheet.rows.forEach(function (r) {
    var id = str_(r['明細ID']).trim();
    var no = str_(r['照合先請求番号']).trim();
    // 消込済みの行は触らない。再送すると入金が二重に加算される。
    if (!id || !no || str_(r['照合状態']).indexOf('⚠') !== 0) return;
    targets.push({ tx_id: id, invoice_no: no });
  });
  if (targets.length === 0) return { updated: 0, failures: [] };

  var updated = 0, failures = [];
  chunk_(targets, 100).forEach(function (batch) {
    var res = api_('/gas/payments/assign', 'post', { rows: batch });
    updated += res.updated || 0;
    (res.results || []).forEach(function (x) {
      if (!x.success) failures.push(str_(x.invoice_no) + ': ' + str_(x.message));
    });
  });
  return { updated: updated, failures: failures };
}
