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
      SpreadsheetApp.getUi().alert('反映する入金がありません。\n\n「入金日」と「入金額」を入力してから実行してください。');
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
    ui.alert('入金を反映しました。\n\n成功: ' + updated + '件 / 失敗: ' + failures.length + '件'
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

    var snapshot = loadSnapshot_();
    var targets = [];
    sheet.rows.forEach(function (r) {
      var contractId = str_(r['契約ID']).trim();
      if (!contractId) return;
      var current = customerFingerprint_(r);
      if (snapshot[contractId] === current) return;   // 変更のない行は送らない
      targets.push({
        contract_id: contractId,
        // 空欄のまま送ることで「代理店の紐付けを解除」を表現する。
        // null は「変更しない」の意味になるため、ここで null に落としてはいけない。
        referrer_code: str_(r['紹介者コード']).trim(),
        agency_fee_type: FEE_TYPE_VALUE[str_(r['代理店フィー種別']).trim()] || null,
        agency_fee_amount: r['代理店フィー額'] === '' ? null : num_(r['代理店フィー額']),
        billing_email: str_(r['請求先メール']).trim() || null,
        payment_terms_days: r['支払サイト(日)'] === '' ? null : num_(r['支払サイト(日)'])
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
// ---------------------------------------------------------------------

function customerFingerprint_(r) {
  return [
    str_(r['紹介者コード']).trim(),
    str_(r['代理店フィー種別']).trim(),
    num_(r['代理店フィー額']),
    str_(r['請求先メール']).trim(),
    num_(r['支払サイト(日)'])
  ].join('|');
}

/** 同期直後の値を控えておき、次回の書き戻しで「変わった行」だけを送る */
function saveSnapshot_() {
  var sheet = readSheet_(SHEETS.CUSTOMERS);
  var rows = sheet.rows.map(function (r) {
    return [str_(r['契約ID']).trim(), customerFingerprint_(r)];
  }).filter(function (r) { return r[0]; });

  var sh = getOrCreateSheet_(SNAPSHOT_SHEET);
  sh.clear();
  ensureGrid_(sh, 2, rows.length + 2);
  sh.getRange(1, 1, 1, 2).setValues([['契約ID', 'fingerprint']]);
  if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
  sh.hideSheet();
}

function loadSnapshot_() {
  var sh = ss_().getSheetByName(SNAPSHOT_SHEET);
  var map = {};
  if (!sh) return map;
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0]) map[String(values[i][0]).trim()] = String(values[i][1]);
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

/** ダイアログを出さずに再同期する (書き戻し直後の反映用) */
function syncAll_quiet_() {
  var month = targetMonth_();
  var data = api_('/gas/export?sheet=all&month=' + encodeURIComponent(month), 'get');
  var reconcile = data.reconcile || {};
  syncCustomers_(data.customers || [], reconcile);
  syncInquiries_(data.inquiries || [], reconcile);
  syncInvoices_(data.invoices || []);
  syncStripe_(data.stripe || {});
  syncReferrers_(data.referrers || []);
  syncAgency_(data.agency || []);
  syncReconcile_(reconcile);
  syncSummary_(data.summary || {}, data.stripe || {});
  saveSnapshot_();
}
