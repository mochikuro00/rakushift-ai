/**
 * 02_Sync.gs — システム → スプレッドシート の全データ同期
 *
 * 「売上管理から顧客管理、運営に関わるすべて」を1回の同期でシートに落とす。
 * 顧客リストは手入力せず、必ずシステム(/gas/export)から取得する。
 */

function syncAll() {
  return guard_('全データ同期', function () {
    var month = targetMonth_();
    var data = api_('/gas/export?sheet=all&month=' + encodeURIComponent(month), 'get');

    setupSettingsSheet_();
    var reconcile = data.reconcile || {};

    syncCustomers_(data.customers || [], reconcile);
    syncInquiries_(data.inquiries || [], reconcile);
    syncInvoices_(data.invoices || []);
    syncStripe_(data.stripe || {});
    syncReferrers_(data.referrers || []);
    syncAgency_(data.agency || []);
    syncReconcile_(reconcile);
    syncSummary_(data.summary || {}, data.stripe || {});
    saveSnapshot_();   // 次回の書き戻しで「編集された行」だけを送るための控え

    var msg = '同期が完了しました（対象月 ' + month + '）\n\n'
      + '顧客: ' + (data.customers || []).length + '件\n'
      + 'お問い合わせ: ' + (data.inquiries || []).length + '件\n'
      + '請求・入金: ' + (data.invoices || []).length + '件\n'
      + '紹介者(代理店): ' + (data.referrers || []).length + '件';
    if (data.errors && data.errors.length) {
      msg += '\n\n⚠ 一部取得できませんでした: ' + data.errors.join(' / ');
    }
    SpreadsheetApp.getUi().alert(msg);
  });
}

// ---------------------------------------------------------------------
// 顧客管理
// ---------------------------------------------------------------------

var CUSTOMER_HEADERS = [
  '契約ID', '店舗名', '会社名', '担当者名', '請求先メール', '電話', '担当電話', '住所',
  '請求区分', 'プラン', '月額(円)',
  '紹介者コード', '代理店名', '代理店フィー種別', '代理店フィー額', '代理店フィー(月額)',
  '契約状態', 'ライセンス', '解約申請日', '解約発効日', '支払サイト(日)',
  '直近請求月', '未入金件数', '未入金額', '入金累計', '最終入金日',
  '問い合わせ有無', '契約日', 'organization_id'
];

function syncCustomers_(customers, reconcile) {
  // 突合結果から「この顧客に対応する問い合わせがあるか」を引けるようにする
  var noInquiry = {};
  (reconcile.customers_without_inquiry || []).forEach(function (c) {
    noInquiry[c.contract_id] = true;
  });

  var rows = customers.map(function (c) {
    return [
      str_(c.contract_id),
      str_(c.shop_name),
      str_(c.company_name),
      str_(c.contact_name),
      str_(c.billing_email),
      str_(c.phone),
      str_(c.contact_phone),
      str_(c.address),
      CATEGORY_LABEL[c.billing_category] || str_(c.billing_category),
      PLAN_LABEL[c.plan] || str_(c.plan),
      num_(c.monthly_amount),
      str_(c.referrer_code),
      str_(c.referrer_name),
      FEE_TYPE_LABEL[c.agency_fee_type] || str_(c.agency_fee_type),
      num_(c.agency_fee_amount),
      num_(c.agency_fee_monthly),
      str_(c.subscription_status),
      str_(c.license_status),
      ymd_(c.cancel_requested_at),
      ymd_(c.cancel_effective_date),
      num_(c.payment_terms_days),
      str_(c.last_invoice_month).slice(0, 7),
      num_(c.unpaid_count),
      num_(c.unpaid_amount),
      num_(c.paid_total),
      ymd_(c.last_paid_at),
      noInquiry[c.contract_id] ? '⚠ 問い合わせ記録なし' : '有',
      ymd_(c.created_at),
      str_(c.organization_id)
    ];
  });

  // 代理店ごとに並べ、代理店別の確認・集計をしやすくする
  rows.sort(function (a, b) {
    var ra = a[11] || 'ZZZ', rb = b[11] || 'ZZZ';
    if (ra !== rb) return ra < rb ? -1 : 1;
    return String(a[1]) < String(b[1]) ? -1 : 1;
  });

  var sh = writeSheet_(SHEETS.CUSTOMERS, CUSTOMER_HEADERS, rows, {
    editable: CUSTOMER_EDITABLE,
    headerColor: '#1d4ed8',
    numberFormats: {
      '月額(円)': '#,##0', '代理店フィー額': '#,##0', '代理店フィー(月額)': '#,##0',
      '未入金額': '#,##0', '入金累計': '#,##0',
      '支払サイト(日)': '0', '未入金件数': '0'
    }
  });

  applyFilter_(sh, CUSTOMER_HEADERS.length, rows.length);
  applyDropdown_(sh, CUSTOMER_HEADERS.indexOf('代理店フィー種別') + 1, rows.length,
                 Object.keys(FEE_TYPE_VALUE));

  // 代理店フィーの月額合計を見出しに出す (最終計算の確認用)
  if (rows.length > 0) {
    var feeCol = CUSTOMER_HEADERS.indexOf('代理店フィー(月額)') + 1;
    sh.getRange(rows.length + 2, feeCol - 1).setValue('代理店フィー合計').setFontWeight('bold');
    sh.getRange(rows.length + 2, feeCol)
      .setFormula('=SUM(' + colLetter_(feeCol) + '2:' + colLetter_(feeCol) + (rows.length + 1) + ')')
      .setFontWeight('bold').setNumberFormat('#,##0');
  }
}

// ---------------------------------------------------------------------
// お問い合わせ (フォーム項目を全件・全カラム)
// ---------------------------------------------------------------------

/** DBカラム → 日本語見出し。ここに無いカラムはカラム名のまま末尾に追加される */
var INQUIRY_LABELS = {
  id: 'ID',
  created_at: '受付日時',
  company_name: '会社名',
  business_name: '事業者名',
  contact_name: '担当者名',
  email: 'メールアドレス',
  phone: '電話番号',
  contact_phone: '担当者電話',
  company_address: '住所',
  plan_summary: '希望プラン',
  light_plan_count: 'Pro希望店舗数',
  standard_plan_count: 'Standard希望店舗数',
  premium_plan_count: 'Premium希望店舗数',
  preferred_days: '希望日程',
  preferred_time: '希望時間帯',
  schedule_summary: '日程まとめ',
  referrer_code: '紹介者コード',
  message: 'お問い合わせ内容',
  status: '対応状況',
  handled_by: '対応者',
  handled_at: '対応日時',
  internal_notes: '社内メモ',
  updated_at: '更新日時'
};

/** 見出しの並び順 (ここに無いカラムはこの後ろに自動追加) */
var INQUIRY_ORDER = [
  'created_at', 'company_name', 'business_name', 'contact_name', 'email', 'phone',
  'contact_phone', 'company_address', 'plan_summary', 'standard_plan_count',
  'light_plan_count', 'premium_plan_count', 'preferred_days', 'preferred_time',
  'schedule_summary', 'referrer_code', 'message', 'status', 'handled_by',
  'handled_at', 'internal_notes', 'updated_at', 'id'
];

var INQUIRY_DATE_KEYS = { created_at: 1, handled_at: 1, updated_at: 1 };

function syncInquiries_(inquiries, reconcile) {
  // 突合結果 (契約に至ったか) を各問い合わせに付ける
  var matched = {};
  (reconcile.inquiries || []).forEach(function (q) {
    matched[q.inquiry_id] = q;
  });

  // 実際に返ってきたカラムを全部拾う (フォーム項目が増えても自動で列が増える)
  var keys = INQUIRY_ORDER.slice();
  inquiries.forEach(function (q) {
    Object.keys(q).forEach(function (k) {
      if (keys.indexOf(k) < 0) keys.push(k);
    });
  });
  keys = keys.filter(function (k) {
    return inquiries.length === 0 || inquiries.some(function (q) { return k in q; });
  });

  var headers = keys.map(function (k) { return INQUIRY_LABELS[k] || k; })
    .concat(['契約済み', '契約ID', '照合方法']);

  var rows = inquiries.map(function (q) {
    var row = keys.map(function (k) {
      if (INQUIRY_DATE_KEYS[k]) return ymdhm_(q[k]);
      var v = q[k];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
    var m = matched[q.id] || {};
    row.push(m.matched_contract_id ? '契約済み' : '⚠ 未契約');
    row.push(str_(m.matched_contract_id));
    row.push(str_(m.match_by));
    return row;
  });

  var sh = writeSheet_(SHEETS.INQUIRIES, headers, rows, { headerColor: '#7c3aed' });
  applyFilter_(sh, headers.length, rows.length);

  // 未契約の行を色付け (対応漏れの検出)
  var statusCol = headers.indexOf('契約済み') + 1;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][statusCol - 1] !== '契約済み') {
      sh.getRange(i + 2, 1, 1, headers.length).setBackground('#fff7ed');
    }
  }
}

// ---------------------------------------------------------------------
// 請求・入金 (売上管理の元帳)
// ---------------------------------------------------------------------

var INVOICE_HEADERS = [
  '請求番号', '対象月', '契約ID', '顧客名', '会社名', '請求先メール', '請求区分', 'プラン',
  '発行日', '支払期限', '数量', '単価', '小計(税抜)', '消費税', '請求額(税込)',
  '状態', '入金日', '入金額', '残額', '入金方法', '振込名義',
  '紹介者コード', '代理店フィー', '下書き作成', '送付日時', '備考'
];

function syncInvoices_(invoices) {
  var rows = invoices.map(function (v) {
    var total = num_(v.total), paid = num_(v.paid_amount);
    return [
      str_(v.invoice_no),
      str_(v.billing_month).slice(0, 7),
      str_(v.contract_id),
      str_(v.shop_name),
      str_(v.company_name),
      str_(v.billing_email),
      CATEGORY_LABEL[v.billing_category] || str_(v.billing_category),
      PLAN_LABEL[v.plan] || str_(v.plan),
      ymd_(v.issue_date),
      ymd_(v.due_date),
      num_(v.qty),
      num_(v.unit_price),
      num_(v.subtotal),
      num_(v.tax),
      total,
      STATUS_LABEL[v.status] || str_(v.status),
      ymd_(v.paid_at),
      paid,
      total - paid,
      str_(v.payment_method),
      str_(v.payer_name),
      str_(v.referrer_code),
      num_(v.agency_fee),
      ymdhm_(v.email_draft_at),
      ymdhm_(v.sent_at),
      str_(v.note)
    ];
  });

  var sh = writeSheet_(SHEETS.INVOICES, INVOICE_HEADERS, rows, {
    editable: INVOICE_EDITABLE,
    headerColor: '#047857',
    numberFormats: {
      '発行日': 'yyyy-mm-dd', '支払期限': 'yyyy-mm-dd', '入金日': 'yyyy-mm-dd',
      '数量': '0', '単価': '#,##0', '小計(税抜)': '#,##0', '消費税': '#,##0',
      '請求額(税込)': '#,##0', '入金額': '#,##0', '残額': '#,##0', '代理店フィー': '#,##0'
    }
  });
  applyFilter_(sh, INVOICE_HEADERS.length, rows.length);
  applyDropdown_(sh, INVOICE_HEADERS.indexOf('入金方法') + 1, rows.length,
                 ['bank', 'cash', 'stripe', 'offset']);

  // 期日超過の未入金を赤く
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  for (var i = 0; i < rows.length; i++) {
    var status = rows[i][15], due = rows[i][9];
    if (status !== '入金済' && status !== '無効' && due && due < today) {
      sh.getRange(i + 2, 1, 1, INVOICE_HEADERS.length).setBackground('#fef2f2');
    }
  }
}

// ---------------------------------------------------------------------
// Stripe 決済履歴
// ---------------------------------------------------------------------

var STRIPE_HEADERS = [
  '決済日', '状態', '顧客(店舗)', '契約ID', '金額', '通貨', 'プラン', '紹介者コード',
  '再試行回数', '次回再試行', 'メールアドレス', '請求書URL', 'Stripe請求ID'
];

function syncStripe_(stripe) {
  var all = (stripe.paid || []).concat(stripe.unpaid || []);
  all.sort(function (a, b) { return (b.date || 0) - (a.date || 0); });

  var rows = all.map(function (p) {
    return [
      p.date ? Utilities.formatDate(new Date(p.date * 1000), 'Asia/Tokyo', 'yyyy-MM-dd') : '',
      p.status === 'paid' ? '決済済み' : (p.status === 'uncollectible' ? '回収不能' : '支払い待ち/失敗'),
      str_(p.shop_name),
      str_(p.contract_id),
      num_(p.amount),
      String(p.currency || '').toUpperCase(),
      PLAN_LABEL[p.plan] || str_(p.plan),
      str_(p.referrer_code),
      num_(p.attempt_count),
      p.next_attempt ? Utilities.formatDate(new Date(p.next_attempt * 1000), 'Asia/Tokyo', 'yyyy-MM-dd') : '',
      str_(p.customer_email),
      str_(p.invoice_url),
      str_(p.invoice_id)
    ];
  });

  var sh = writeSheet_(SHEETS.STRIPE, STRIPE_HEADERS, rows, {
    headerColor: '#4f46e5',
    numberFormats: { '金額': '#,##0', '再試行回数': '0' }
  });
  applyFilter_(sh, STRIPE_HEADERS.length, rows.length);
  if (!stripe.configured) {
    sh.getRange(1, STRIPE_HEADERS.length + 2)
      .setValue('※ Stripe が未設定のため取得できていません').setFontColor('#b91c1c');
  }
}

// ---------------------------------------------------------------------
// 紹介者(代理店)マスタ
// ---------------------------------------------------------------------

var REFERRER_HEADERS = [
  '紹介者コード', '紹介者名', '紹介法人名', 'メール', '電話',
  '報酬タイプ', '料率(%)', '固定額', '振込口座', '有効',
  '紹介件数', '課金中件数', '月額売上', '月額報酬(概算)', '登録日', '備考'
];

function syncReferrers_(referrers) {
  var rows = (referrers || []).map(function (r) {
    return [
      str_(r.code), str_(r.name), str_(r.company_name), str_(r.email), str_(r.phone),
      r.commission_type === 'fixed' ? '固定額' : '料率(%)',
      num_(r.commission_rate), num_(r.commission_amount), str_(r.bank_account),
      r.active === false ? '停止' : '有効',
      num_(r.tenant_count), num_(r.paying_count), num_(r.monthly_revenue),
      num_(r.monthly_commission), ymd_(r.created_at), str_(r.note)
    ];
  });
  var sh = writeSheet_(SHEETS.REFERRERS, REFERRER_HEADERS, rows, {
    headerColor: '#b45309',
    numberFormats: {
      '料率(%)': '0.##', '固定額': '#,##0', '紹介件数': '0', '課金中件数': '0',
      '月額売上': '#,##0', '月額報酬(概算)': '#,##0'
    }
  });
  applyFilter_(sh, REFERRER_HEADERS.length, rows.length);
}

// ---------------------------------------------------------------------
// 代理店フィー (月次確定 = 請求台帳ベースの最終計算)
// ---------------------------------------------------------------------

var AGENCY_HEADERS = [
  '対象月', '紹介者コード', '紹介者名', '紹介法人名', '報酬タイプ', '料率(%)', '固定額',
  '振込口座', '対象顧客数', '請求額合計', '入金額合計', 'フィー合計',
  '支払対象(入金済)', '保留(未入金)'
];

function syncAgency_(agency) {
  var rows = (agency || []).map(function (a) {
    return [
      str_(a.month), str_(a.referrer_code), str_(a.referrer_name), str_(a.company_name),
      a.commission_type === 'fixed' ? '固定額' : '料率(%)',
      num_(a.commission_rate), num_(a.commission_amount), str_(a.bank_account),
      num_(a.client_count), num_(a.billed_amount), num_(a.paid_amount),
      num_(a.fee_total), num_(a.fee_payable), num_(a.fee_pending)
    ];
  });
  var sh = writeSheet_(SHEETS.AGENCY, AGENCY_HEADERS, rows, {
    headerColor: '#a16207',
    numberFormats: {
      '料率(%)': '0.##', '固定額': '#,##0', '対象顧客数': '0',
      '請求額合計': '#,##0', '入金額合計': '#,##0',
      'フィー合計': '#,##0', '支払対象(入金済)': '#,##0', '保留(未入金)': '#,##0'
    }
  });

  if (rows.length > 0) {
    var last = rows.length + 2;
    sh.getRange(last, 1).setValue('合計').setFontWeight('bold');
    [10, 11, 12, 13, 14].forEach(function (col) {
      sh.getRange(last, col)
        .setFormula('=SUM(' + colLetter_(col) + '2:' + colLetter_(col) + (rows.length + 1) + ')')
        .setFontWeight('bold').setNumberFormat('#,##0');
    });
  }
}

// ---------------------------------------------------------------------
// 突合チェック
// ---------------------------------------------------------------------

var RECONCILE_HEADERS = ['区分', '対象', '会社名/店舗名', '担当者', 'メール', '電話',
                         '紹介者コード', '契約ID', '日付', '対応の目安'];

function syncReconcile_(reconcile) {
  var rows = [];

  (reconcile.inquiries || []).forEach(function (q) {
    if (!q.is_orphan) return;
    rows.push(['⚠ 未契約の問い合わせ', 'お問い合わせ',
               str_(q.company_name) || str_(q.business_name), str_(q.contact_name),
               str_(q.email), str_(q.phone), str_(q.referrer_code), '',
               ymdhm_(q.created_at),
               '契約に至っていません。対応状況（' + str_(q.inquiry_status) + '）を確認してください。']);
  });

  (reconcile.customers_without_inquiry || []).forEach(function (c) {
    rows.push(['⚠ 問い合わせ記録なしの顧客', '顧客',
               str_(c.shop_name) + (c.company_name ? '（' + c.company_name + '）' : ''), '',
               str_(c.billing_email), '', str_(c.referrer_code), str_(c.contract_id),
               ymd_(c.created_at),
               'フォーム経由でない契約です。手動発行なら問題ありません。']);
  });

  (reconcile.referrer_mismatch || []).forEach(function (m) {
    rows.push(['⚠ 紹介者コード不一致', '顧客', str_(m.shop_name), '', '', '',
               '問合せ:' + str_(m.inquiry_referrer) + ' / 顧客:' + str_(m.customer_referrer),
               str_(m.contract_id), '',
               '代理店フィーの付け漏れ・誤付与の可能性があります。どちらが正しいか確認してください。']);
  });

  var sh = writeSheet_(SHEETS.RECONCILE, RECONCILE_HEADERS, rows, { headerColor: '#be123c' });
  if (rows.length === 0) {
    sh.getRange(2, 1).setValue('✅ 抜け・不一致はありません').setFontWeight('bold').setFontColor('#047857');
  }
  applyFilter_(sh, RECONCILE_HEADERS.length, rows.length);
}

// ---------------------------------------------------------------------
// 売上サマリー
// ---------------------------------------------------------------------

var SUMMARY_HEADERS = ['対象月', '請求件数', '請求額', '入金額', '未入金額',
                       '入金済件数', '未入金件数', '代理店フィー', '支払対象フィー(入金済)',
                       '請求書払い', 'OEM代理店', 'Stripe(台帳)'];

function syncSummary_(summary, stripe) {
  var months = (summary && summary.months) || [];
  var rows = months.map(function (m) {
    var cat = m.by_category || {};
    return [
      str_(m.month), num_(m.count), num_(m.billed), num_(m.paid), num_(m.unpaid),
      num_(m.paid_count), num_(m.unpaid_count), num_(m.agency_fee), num_(m.agency_fee_payable),
      num_((cat.invoice || {}).billed), num_((cat.oem || {}).billed), num_((cat.stripe || {}).billed)
    ];
  });
  var sh = writeSheet_(SHEETS.SUMMARY, SUMMARY_HEADERS, rows, {
    headerColor: '#0f766e',
    numberFormats: {
      '請求件数': '0', '入金済件数': '0', '未入金件数': '0',
      '請求額': '#,##0', '入金額': '#,##0', '未入金額': '#,##0',
      '代理店フィー': '#,##0', '支払対象フィー(入金済)': '#,##0',
      '請求書払い': '#,##0', 'OEM代理店': '#,##0', 'Stripe(台帳)': '#,##0'
    }
  });

  // Stripe 実績は Stripe API が正なので参考値として併記する
  var paidSum = (stripe.paid || []).reduce(function (s, p) { return s + num_(p.amount); }, 0);
  var unpaidSum = (stripe.unpaid || []).reduce(function (s, p) { return s + num_(p.amount); }, 0);
  var base = rows.length + 3;
  sh.getRange(base, 1).setValue('Stripe実績（直近100件・参考）').setFontWeight('bold');
  sh.getRange(base + 1, 1, 2, 2).setValues([
    ['決済済み合計', paidSum],
    ['未決済合計', unpaidSum]
  ]);
  sh.getRange(base + 1, 2, 2, 1).setNumberFormat('#,##0');
}

// ---------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------

function applyFilter_(sheet, colCount, rowCount) {
  var existing = sheet.getFilter();
  if (existing) existing.remove();
  if (rowCount > 0) sheet.getRange(1, 1, rowCount + 1, colCount).createFilter();
}

function applyDropdown_(sheet, col, rowCount, values) {
  if (col <= 0 || rowCount <= 0) return;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true).setAllowInvalid(false).build();
  sheet.getRange(2, col, rowCount, 1).setDataValidation(rule);
}

function colLetter_(col) {
  var s = '';
  while (col > 0) {
    var m = (col - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    col = Math.floor((col - m) / 26);
  }
  return s;
}
