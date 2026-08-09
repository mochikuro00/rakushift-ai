/**
 * 00_Config.gs — 共通設定 / API クライアント / シート書き込みユーティリティ
 *
 * ラクシフトAI 運営管理スプレッドシート
 *   顧客・お問い合わせ・売上(請求/入金)・紹介者(代理店)・代理店フィー・突合を
 *   1つのスプレッドシートに集約する。
 *
 * システム(Railway API)との通信はすべてこのファイルの api_() を通す。
 * Supabase の service_role キーはスプレッドシートに置かない。
 */

/** Railway API のベースURL */
var API_BASE = 'https://rakushift-ai-production.up.railway.app';

/** APIキーは ScriptProperties に保存する (シートには書かない) */
var PROP_API_KEY = 'GAS_API_KEY';

/** シート名 */
var SHEETS = {
  SETTINGS:  '⚙️設定',
  CUSTOMERS: '顧客管理',
  INQUIRIES: 'お問い合わせ',
  INVOICES:  '請求・入金',
  STRIPE:    'Stripe決済',
  REFERRERS: '紹介者マスタ',
  AGENCY:    '代理店フィー',
  RECONCILE: '突合チェック',
  SUMMARY:   '売上サマリー'
};

/** 顧客管理シートで運営が編集してよい列 (ここを直してから「代理店設定を反映」) */
var CUSTOMER_EDITABLE = ['紹介者コード', '代理店フィー種別', '代理店フィー額', '請求先メール', '支払サイト(日)'];

/** 請求・入金シートで運営が編集してよい列 (ここを直してから「入金を反映」) */
var INVOICE_EDITABLE = ['入金日', '入金額', '入金方法', '振込名義'];

var FEE_TYPE_LABEL = { inherit: '紹介者マスタ準拠', fixed: '固定額', percent: '料率(%)', none: '対象外' };
var FEE_TYPE_VALUE = { '紹介者マスタ準拠': 'inherit', '固定額': 'fixed', '料率(%)': 'percent', '対象外': 'none' };
var CATEGORY_LABEL = { stripe: 'Stripe', oem: 'OEM代理店', invoice: '請求書払い' };
var STATUS_LABEL = {
  draft: '下書き', issued: '未入金', sent: '送付済/未入金',
  partial: '一部入金', paid: '入金済', 'void': '無効'
};
var PLAN_LABEL = { standard: 'Standard', pro: 'Pro', premium: 'Premium', oem: 'OEM代理店' };

// =====================================================================
// API クライアント
// =====================================================================

function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty(PROP_API_KEY);
  if (!key) {
    throw new Error('APIキーが未設定です。メニュー「ラクシフト運営」→「初期設定（APIキー登録）」を実行してください。');
  }
  return key;
}

/**
 * Railway API 呼び出し。
 * @param {string} path  '/gas/export' など
 * @param {string} method 'get' | 'post'
 * @param {Object} payload POST時のbody
 */
function api_(path, method, payload) {
  var options = {
    method: method || 'get',
    headers: { 'x-gas-key': getApiKey_() },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var res = UrlFetchApp.fetch(API_BASE + path, options);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code === 403) {
    throw new Error('APIキーが拒否されました。運営管理画面の設定と一致しているか確認してください。');
  }
  if (code >= 400) {
    throw new Error('API エラー (' + code + '): ' + text.slice(0, 300));
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('APIの応答を解釈できませんでした: ' + text.slice(0, 200));
  }
}

// =====================================================================
// シート ユーティリティ
// =====================================================================

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getOrCreateSheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
  }
  return sh;
}

/**
 * ヘッダー + 明細をシートに書き込む (全置換)。
 * 既存の行はクリアされるため、運営の手入力はシステムへ反映してから同期すること。
 */
/** 新規シートは既定 1000行 × 26列しかないため、書き込む前に広げておく */
function ensureGrid_(sheet, needCols, needRows) {
  var maxCols = sheet.getMaxColumns();
  if (maxCols < needCols) sheet.insertColumnsAfter(maxCols, needCols - maxCols);
  var maxRows = sheet.getMaxRows();
  if (maxRows < needRows) sheet.insertRowsAfter(maxRows, needRows - maxRows);
}

function writeSheet_(name, headers, rows, opts) {
  opts = opts || {};
  var sh = getOrCreateSheet_(name);
  sh.clear();
  ensureGrid_(sh, headers.length + 2, rows.length + 10);  // 合計行・注記の書き込み分に余裕を持たせる
  if (sh.getFrozenRows() !== 1) sh.setFrozenRows(1);

  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold')
    .setBackground(opts.headerColor || '#1f2937')
    .setFontColor('#ffffff')
    .setVerticalAlignment('middle');

  // 書式は setValues の「前」に当てる。
  // 後から当てても手遅れで、'2026-08' や '2026-08-01' はスプレッドシートに
  // 日付として取り込まれてしまい、読み戻したときに文字列比較が成立しなくなる
  // (対象月での絞り込みが常に0件になる)。数値列以外は明示的に文字列書式にする。
  var numberFormats = opts.numberFormats || {};
  if (rows.length > 0) {
    for (var ci = 0; ci < headers.length; ci++) {
      sh.getRange(2, ci + 1, rows.length, 1)
        .setNumberFormat(numberFormats[headers[ci]] || '@');
    }
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // 編集可能な列に薄い色を付け、運営がどこを触ってよいか一目で分かるようにする
  (opts.editable || []).forEach(function (colName) {
    var idx = headers.indexOf(colName);
    if (idx < 0) return;
    sh.getRange(1, idx + 1).setBackground('#0f766e');
    if (rows.length > 0) sh.getRange(2, idx + 1, rows.length, 1).setBackground('#ecfdf5');
  });

  sh.autoResizeColumns(1, headers.length);
  // 自動調整で広がりすぎるのを抑える
  for (var c = 1; c <= headers.length; c++) {
    if (sh.getColumnWidth(c) > 260) sh.setColumnWidth(c, 260);
  }
  return sh;
}

/** シートを見出し行付きで読み取り、{列名: 値} の配列にする */
function readSheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return { headers: [], rows: [] };
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { headers: values[0] || [], rows: [] };
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    var empty = true;
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[i][j];
      if (values[i][j] !== '' && values[i][j] !== null) empty = false;
    }
    if (!empty) { obj.__row = i + 1; rows.push(obj); }
  }
  return { headers: headers, rows: rows };
}

// =====================================================================
// 値の整形
// =====================================================================

function num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  var n = Number(String(v).replace(/[,¥\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function str_(v) { return (v === null || v === undefined) ? '' : String(v); }

/** ISO文字列 / Date → 'yyyy-MM-dd' (空なら '') */
function ymd_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  // セルの書式によっては '2026/08/09' の形で入ってくるため ISO に寄せる
  var s = String(v).trim().replace(/\//g, '-');
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** ISO文字列 / Date → 'yyyy-MM-dd HH:mm' */
function ymdhm_(v) {
  if (!v) return '';
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

/** 対象月 'yyyy-MM'。設定シートに指定があればそれ、無ければ今月 */
function targetMonth_() {
  var v = getSetting_('対象月');
  if (v) {
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM');
    var s = String(v).trim();
    if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  }
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
}

// =====================================================================
// 設定シート
// =====================================================================

var SETTING_DEFAULTS = [
  ['対象月', '', '請求書生成・代理店フィー集計の対象月 (yyyy-MM)。空欄なら今月。'],
  ['自社名', '株式会社リンクデザイン', '請求書の発行者名'],
  ['自社住所', '', '請求書に印字する住所'],
  ['自社電話', '', '請求書に印字する電話番号'],
  ['インボイス登録番号', '', '適格請求書発行事業者の登録番号 (T+13桁)'],
  ['振込先', '', '例: ○○銀行 ○○支店 普通 1234567 カ)リンクデザイン'],
  ['請求書メール件名', '【ラクシフトAI】{対象月}分 ご請求書のご送付', '{対象月}{顧客名}{請求番号}{金額}{支払期限} が差し込まれます'],
  ['請求書メール本文', '', '空欄なら既定の本文を使用。同じ差し込みタグが使えます。'],
  ['CC', '', '請求書メールのCC (カンマ区切り)']
];

function getSetting_(key) {
  var sh = ss_().getSheetByName(SHEETS.SETTINGS);
  if (!sh) return '';
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) return values[i][1];
  }
  return '';
}

function setupSettingsSheet_() {
  var sh = ss_().getSheetByName(SHEETS.SETTINGS);
  var existing = {};
  if (sh) {
    var vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) existing[String(vals[i][0]).trim()] = vals[i][1];
  }
  var rows = SETTING_DEFAULTS.map(function (d) {
    return [d[0], (existing[d[0]] !== undefined && existing[d[0]] !== '') ? existing[d[0]] : d[1], d[2]];
  });
  writeSheet_(SHEETS.SETTINGS, ['項目', '値', '説明'], rows,
              { editable: ['値'], headerColor: '#334155' });
}
