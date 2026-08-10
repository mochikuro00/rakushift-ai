/**
 * 03_Push.gs — スプレッドシート → システム の書き戻し
 *
 *   入金消込        : 請求・入金シートの「入金日/入金額/入金方法/振込名義」
 *   代理店設定      : 顧客管理シートの「紹介者コード/代理店フィー種別/代理店フィー額/
 *                     請求先メール/支払サイト」
 *
 * 書き戻し後は必ず再同期し、システム側の確定値をシートに反映する
 * （どちらが正か曖昧な状態を残さないため）。
 */

var SNAPSHOT_SHEET = '_同期スナップショット';

// ---------------------------------------------------------------------
// 入金消込
// ---------------------------------------------------------------------

function pushPayments() {
  return guard_('入金の反映', function () {
    var sheet = readSheet_(SHEETS.INVOICES);
    if (sheet.rows.length === 0) {
      SpreadsheetApp.getUi().alert('請求・入金シートにデータがありません。先に「🔄 全データを同期」を実行してください。');
      return;
    }

    // 「入金明細」シートで要確認行に入れた請求番号も同じ操作で反映する。
    // シートの案内がこのメニューを指しているため、ここで拾わないと
    // 要確認の行を運営が解消する手段が無くなる。
    var assigned = pushBankAssignments_();

    var targets = [];
    sheet.rows.forEach(function (r) {
      var invoiceNo = str_(r['請求番号']).trim();
      var amount = num_(r['入金額']);
      var paidAt = ymd_(r['入金日']);
      if (!invoiceNo || amount <= 0 || !paidAt) return;
      // 既に入金済で金額も一致している行は送らない（無駄な更新を避ける）
      if (r['状態'] === '入金済' && amount === num_(r['請求額(税込)'])) return;
      targets.push({
        invoice_no: invoiceNo,
        paid_at: paidAt,
        paid_amount: amount,
        payment_method: str_(r['入金方法']).trim() || 'bank',
        payer_name: str_(r['振込名義']).trim()
      });
    });

    if (targets.length === 0) {
      syncAll_quiet_();
      SpreadsheetApp.getUi().alert(
        assigned.updated > 0
          ? ('入金明細の手動紐付けを ' + assigned.updated + ' 件反映しました。'
             + (assigned.failures.length ? '\n\n【失敗】\n' + assigned.failures.slice(0, 15).join('\n') : ''))
          : ('反映する入金がありません。\n\n'
             + '請求・入金シートの「入金日」と「入金額」、または入金明細シートの'
             + '「照合先請求番号」を入力してから実行してください。'
             + (assigned.failures.length ? '\n\n【失敗】\n' + assigned.failures.slice(0, 15).join('\n') : '')));
      return;
    }

    var ui = SpreadsheetApp.getUi();
    var preview = targets.slice(0, 10).map(function (t) {
      return '・' + t.invoice_no + '  ' + t.paid_at + '  ¥' + Number(t.paid_amount).toLocaleString();
    }).join('\n');
    if (ui.alert('入金の反映',
                 targets.length + ' 件の入金をシステムに反映します。\n\n' + preview
                 + (targets.length > 10 ? '\n… ほか ' + (targets.length - 10) + ' 件' : '')
                 + '\n\nよろしいですか？',
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    var updated = 0, failures = [];
    chunk_(targets, 100).forEach(function (batch) {
      var res = api_('/gas/invoices/payments', 'post', { rows: batch });
      updated += res.updated || 0;
      (res.results || []).forEach(function (r) {
        if (!r.success) failures.push(str_(r.invoice_no) + ': ' + str_(r.message));
      });
    });

    syncAll_quiet_();
    failures = assigned.failures.concat(failures);
    ui.alert('入金を反映しました。\n\n成功: ' + (updated + assigned.updated) + '件 / 失敗: '
             + failures.length + '件'
             + (assigned.updated ? '\n（うち入金明細からの手動紐付け ' + assigned.updated + '件）' : '')
             + (failures.length ? '\n\n【失敗】\n' + failures.slice(0, 15).join('\n') : ''));
  });
}

// ---------------------------------------------------------------------
// 代理店(紹介者)設定
// ---------------------------------------------------------------------

function pushAgencySettings() {
  return guard_('代理店設定の反映', function () {
    var sheet = readSheet_(SHEETS.CUSTOMERS);
    if (sheet.rows.length === 0) {
      SpreadsheetApp.getUi().alert('顧客管理シートにデータがありません。先に「🔄 全データを同期」を実行してください。');
      return;
    }

    var snapshot = loadSnapshot_()[SHEETS.CUSTOMERS] || {};
    var targets = [];
    sheet.rows.forEach(function (r) {
      var contractId = str_(r['契約ID']).trim();
      if (!contractId) return;
      if (!isEdited_(r, snapshot[contractId], CUSTOMER_EDITABLE)) return;   // 変更のない行は送らない
      targets.push({
        contract_id: contractId,
        // 空欄のまま送ることで「代理店の紐付けを解除」を表現する。
        // null は「変更しない」の意味になるため、ここで null に落としてはいけない。
        referrer_code: str_(r['紹介者コード']).trim(),
        agency_fee_type: FEE_TYPE_VALUE[str_(r['代理店フィー種別']).trim()] || null,
        agency_fee_amount: r['代理店フィー額'] === '' ? null : num_(r['代理店フィー額']),
        billing_email: str_(r['請求先メール']).trim() || null,
        payment_terms_days: r['支払サイト(日)'] === '' ? null : num_(r['支払サイト(日)']),
        // 請求サイクルの起算日。空欄なら変更しない
        billing_start_date: ymd_(r['請求開始日']) || null,
        // 振込名義 (' / ' 区切り)。入金の自動消込で使う
        payer_names: str_(r['振込名義'])
      });
    });

    var ui = SpreadsheetApp.getUi();
    if (targets.length === 0) {
      ui.alert('変更された行がありません。\n\n顧客管理シートの緑色の列（紹介者コード / 代理店フィー種別 / 代理店フィー額 / 請求先メール / 支払サイト）を編集してから実行してください。');
      return;
    }
    if (ui.alert('代理店設定の反映',
                 targets.length + ' 件の顧客設定をシステムに反映します。よろしいですか？',
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    var updated = 0, failures = [];
    chunk_(targets, 100).forEach(function (batch) {
      var res = api_('/gas/customers/agency', 'post', { rows: batch });
      updated += res.updated || 0;
      (res.results || []).forEach(function (r) {
        if (!r.success) failures.push(str_(r.contract_id) + ': ' + str_(r.message));
      });
    });

    syncAll_quiet_();
    ui.alert('代理店設定を反映しました。\n\n成功: ' + updated + '件 / 失敗: ' + failures.length + '件'
             + (failures.length ? '\n\n【失敗】\n' + failures.slice(0, 15).join('\n') : ''));
  });
}

// ---------------------------------------------------------------------
// 変更検出用スナップショット
//
// 控えるのは「同期がシートに書いたシステム側の値」であって、シートの現在値ではない。
// この区別が要で、これにより次の2つが同時に成り立つ:
//   - 書き戻し: シート ≠ 控え の行だけをシステムへ送る
//   - 自動同期: シートを作り直す前に未反映の編集を拾い、書き戻せる
// 控えをシートから取ると、同期で復元した編集が「編集なし」に見えて送られなくなる。
// ---------------------------------------------------------------------

var _snapshotStage = {};   // { シート名: { キー: { 列名: 値 } } }
var _restoredEdits = 0;    // 直近の同期で復元した未反映編集の件数

/** セル値を比較用の文字列に寄せる (日付列は Date で返るため揃える) */
function normCell_(v) {
  if (v instanceof Date) return ymd_(v);
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  return String(v).trim();
}

/** 控えと突き合わせて、編集された行かを判定する。控えが無い行は送る。 */
function isEdited_(r, prev, editable) {
  if (!prev) return true;
  for (var i = 0; i < editable.length; i++) {
    var c = editable[i];
    if (!(c in prev)) continue;
    if (normCell_(r[c]) !== prev[c]) return true;
  }
  return false;
}

/**
 * 前回の同期以降に運営が編集し、まだシステムへ反映していないセルを拾う。
 * 自動同期はシートを作り直すため、これを拾わないと編集が痕跡なく消える。
 * writeSheet_ を呼ぶ「前」に実行すること。
 */
function pendingEdits_(sheetName, keyCol, editable) {
  var prev = loadSnapshot_()[sheetName];
  if (!prev) return {};            // 控えが無い = 比較できないので触らない
  var out = {};
  readSheet_(sheetName).rows.forEach(function (r) {
    var key = normCell_(r[keyCol]);
    if (!key || !prev[key]) return;
    var diff = null;
    editable.forEach(function (c) {
      if (!(c in prev[key])) return;
      if (normCell_(r[c]) === prev[key][c]) return;
      if (!diff) diff = {};
      diff[c] = r[c];
    });
    if (diff) out[key] = diff;
  });
  return out;
}

/** 同期がこれから書く値を控える。writeSheet_ の「前」に実行すること。 */
function stageSnapshot_(sheetName, headers, rows, keyCol, editable) {
  var iKey = headers.indexOf(keyCol);
  var cols = editable.filter(function (c) { return headers.indexOf(c) >= 0; });
  var map = {};
  rows.forEach(function (row) {
    var key = normCell_(row[iKey]);
    if (!key) return;
    var o = {};
    cols.forEach(function (c) { o[c] = normCell_(row[headers.indexOf(c)]); });
    map[key] = o;
  });
  _snapshotStage[sheetName] = map;
}

/**
 * 拾っておいた未反映の編集をシートへ書き戻し、未反映と分かるよう色と注記を付ける。
 *
 * システム側が既に同じ値を持っている編集は書き戻さない。
 * 書き戻し (pushAgencySettings 等) の直後は必ず再同期が走るため、
 * これが無いと「今しがた反映した編集」が毎回「未反映」と警告されてしまう。
 */
function restorePendingEdits_(sh, headers, rows, keyCol, pending) {
  var keys = Object.keys(pending || {});
  if (keys.length === 0) return 0;

  var iKey = headers.indexOf(keyCol);
  var rowOf = {};
  for (var i = 0; i < rows.length; i++) rowOf[normCell_(rows[i][iKey])] = i;

  var n = 0;
  keys.forEach(function (key) {
    var idx = rowOf[key];
    if (idx === undefined) return;   // 同期後に消えた行は復元しない
    var restored = false;
    Object.keys(pending[key]).forEach(function (col) {
      var c = headers.indexOf(col);
      if (c < 0) return;
      if (normCell_(rows[idx][c]) === normCell_(pending[key][col])) return;   // 反映済み
      sh.getRange(idx + 2, c + 1)
        .setValue(pending[key][col])
        .setBackground('#fde68a')
        .setNote('システムへ未反映の編集です。\n書き戻しのメニューを実行するまでシステムには入りません。');
      restored = true;
    });
    if (restored) n++;
  });
  return n;
}

/** 同期の開始時に呼ぶ。控えと復元件数をリセットする。 */
function beginSnapshot_() {
  _snapshotStage = {};
  _restoredEdits = 0;
}

function countRestoredEdits_(n) { _restoredEdits += (n || 0); }
function restoredEdits_() { return _restoredEdits; }

/**
 * 控えを保存する。beginSnapshot_ → stageSnapshot_ → ここ、の順で呼ぶ。
 * 今回書き換えたシートの分だけを差し替える。突合チェックのように
 * 一部のシートしか作り直さない入口があるため、丸ごと置き換えてはいけない。
 */
function saveSnapshot_() {
  var merged = loadSnapshot_();
  Object.keys(_snapshotStage).forEach(function (sheetName) {
    merged[sheetName] = _snapshotStage[sheetName];
  });

  var rows = [];
  Object.keys(merged).forEach(function (sheetName) {
    var map = merged[sheetName];
    Object.keys(map).forEach(function (key) {
      rows.push([sheetName, key, JSON.stringify(map[key])]);
    });
  });

  var sh = getOrCreateSheet_(SNAPSHOT_SHEET);
  sh.clear();
  ensureGrid_(sh, 3, rows.length + 2);
  sh.getRange(1, 1, 1, 3).setValues([['シート', 'キー', '値']]);
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
  sh.hideSheet();
}

function loadSnapshot_() {
  var sh = ss_().getSheetByName(SNAPSHOT_SHEET);
  var map = {};
  if (!sh) return map;
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][0] || '').trim();
    var key  = String(values[i][1] || '').trim();
    if (!name || !key) continue;
    // 旧形式 (契約ID, fingerprint の2列) は3列目が無く JSON にならない。
    // 読み飛ばせば「控え無し」として扱われ、初回だけ全件が編集扱いになるだけで済む。
    var parsed;
    try { parsed = JSON.parse(values[i][2]); } catch (e) { continue; }
    if (!map[name]) map[name] = {};
    map[name][key] = parsed;
  }
  return map;
}

// ---------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------

function chunk_(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * ダイアログを出さずに再同期する (書き戻し直後・自動実行から呼ぶ)。
 * @return {number} 未反映のまま退避・復元した編集の行数
 */
function syncAll_quiet_() {
  beginSnapshot_();
  var month = targetMonth_();
  var data = api_('/gas/export?sheet=all&month=' + encodeURIComponent(month), 'get');
  var reconcile = data.reconcile || {};
  syncCustomers_(data.customers || [], reconcile);
  syncInquiries_(data.inquiries || [], reconcile);
  syncInvoices_(data.invoices || []);
  syncStripe_(data.stripe || {});
  syncReferrers_(data.referrers || []);
  syncAgency_(data.agency || []);
  syncBankTransactions_(data.bank || []);
  syncRefunds_(data.refunds || []);
  syncCancellations_(data.cancellations || []);
  syncReconcile_(reconcile);
  syncSummary_(data.summary || {}, data.stripe || {});
  saveSnapshot_();
  return restoredEdits_();
}
