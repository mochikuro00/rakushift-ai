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
  return guard_('請求書の作成', function () {
    var ui = SpreadsheetApp.getUi();
    if (ui.alert('請求書の作成',
                 '本日時点で請求日を迎えた顧客の請求書を作成します。\n\n'
                 + '対象: 請求書払い・OEM代理店 の稼働中テナント\n'
                 + '各顧客の契約日から1ヶ月ごとの応当日が基準です。\n'
                 + '（同じ期間の請求書が既にある顧客はスキップされます）\n\n'
                 + '※ 過去に遡って請求書が作られることはありません。\n\nよろしいですか？',
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    var res = generateInvoices_core_();
    var msg = '請求書を作成しました（基準日: ' + str_(res.asof || '本日') + '）\n\n'
      + '新規作成: ' + (res.created || 0) + '件\n'
      + '既に請求済みのためスキップ: ' + (res.skipped || 0) + '件';
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
    var sheet = readSheet_(SHEETS.INVOICES);

    var targets = sheet.rows.filter(function (r) {
      if (str_(r['下書き作成']).trim() !== '') return false;
      if (r['状態'] === '入金済' || r['状態'] === '無効') return false;
      return str_(r['請求番号']).trim() !== '';
    });

    if (targets.length === 0) {
      ui.alert('下書きを作成する請求書がありません。\n\n'
               + '（すべて下書き済み、入金済み、または請求書が未生成です）');
      return;
    }

    var noEmail = targets.filter(function (r) { return !str_(r['請求先メール']).trim(); });
    var willSend = autoSendEnabled_();
    var head = willSend
      ? ('⚠ 自動送信が「はい」になっています。\n\n'
         + targets.length + ' 件の請求書を、顧客へ直接メール送信します。\n'
         + '下書きではありません。送信後は取り消せません。\n')
      : (targets.length + ' 件の請求書について、PDFを添付したGmail下書きを作成します。\n');
    var tail = willSend
      ? '\n本当に送信しますか？'
      : '\n作成後、Gmailの「下書き」で内容を確認してから送信してください。\n\nよろしいですか？';
    if (ui.alert(willSend ? '請求書メールの送信（自動送信ON）' : '請求書のGmail下書き作成',
                 head
                 + (noEmail.length ? '\n⚠ 請求先メール未登録が ' + noEmail.length + ' 件あり、これらはスキップされます。\n' : '')
                 + tail,
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    var r2 = createDrafts_core_();
    var sentN = (r2.sent || []).length;
    var restMsg = r2.remaining > 0
      ? ('\n\n※ 上限のため ' + r2.remaining + ' 件を残しました。もう一度実行するか、翌日の自動実行で処理されます。')
      : '';

    ui.alert((sentN > 0 ? '請求書メールを送信しました。' : 'Gmail下書きを作成しました。') + '\n\n'
             + (sentN > 0 ? '送信: ' + sentN + '件' : '作成: ' + r2.created.length + '件')
             + ' / スキップ: ' + r2.skipped.length + '件\n'
             + (r2.skipped.length ? '\n【スキップ】\n' + r2.skipped.slice(0, 15).join('\n') : '')
             + (sentN > 0 ? '' : '\n\nGmailの「下書き」を開いて内容を確認のうえ送信してください。')
             + restMsg);
  });
}


// ---------------------------------------------------------------------
// 実処理 (UI に触れない = 時間主導トリガーからも呼べる)
//   トリガー実行中は SpreadsheetApp.getUi() が例外になるため、
//   確認ダイアログを伴う「メニュー版」と処理本体を分けている。
// ---------------------------------------------------------------------

/**
 * 請求日を迎えた顧客の請求書を作る。基準日は常にサーバ側の「今日」。
 * 月を渡して遡らせることはしない (過去期間の請求書ができてしまうため)。
 */
function generateInvoices_core_() {
  var res = api_('/gas/invoices/generate', 'post', {});
  syncAll_quiet_();
  return res;
}

/**
 * 対象月の未下書き請求書について Gmail 下書きを作る。
 * @return {{created: string[], skipped: string[], targets: number}}
 */
function createDrafts_core_() {
  var sheet = readSheet_(SHEETS.INVOICES);
  // 対象は「まだ下書きを作っていない請求書」すべて。月では絞らない。
  //   月で絞ると、月末に作った請求書を翌月に処理したとき対象から外れ、
  //   下書きが永久に作られないまま残る (例: 8/31生成 → 9/1に実行 → 対象外)。
  var targets = sheet.rows.filter(function (r) {
    if (str_(r['下書き作成']).trim() !== '') return false;
    if (r['状態'] === '入金済' || r['状態'] === '無効') return false;
    return str_(r['請求番号']).trim() !== '';
  });

  // 一度に大量の下書きを作ると Gmail の1日あたり上限に当たる。
  // 溜まっている場合は分割し、残りは翌日の自動実行で処理する。
  var limit = Math.max(1, num_(getSetting_('1回に作る下書きの上限')) || DRAFT_LIMIT_DEFAULT);
  var deferred = Math.max(targets.length - limit, 0);
  if (targets.length > limit) targets = targets.slice(0, limit);

  var issuer = issuerInfo_();
  var autoSend = autoSendEnabled_();
  var created = [], skipped = [], sent = [];
  var start = Date.now();
  var i = 0;

  for (; i < targets.length; i++) {
    // 実行時間の上限で強制終了されると、送信済みでも記録が残らず翌朝再送になる。
    // 自動送信ONなら顧客に二重で届くため、余裕を持って自分から打ち切る。
    if (Date.now() - start > MAIL_LOOP_BUDGET_MS) break;

    var r = targets[i];
    var no = str_(r['請求番号']);
    var to = str_(r['請求先メール']).trim();
    if (!to) { skipped.push(no + ': 請求先メール未登録'); continue; }

    var didSend = false;
    try {
      var pdf = buildInvoicePdf_(r, issuer);
      var subject = fillTemplate_(
        str_(getSetting_('請求書メール件名')) || '【ラクシフトAI】{対象月}分 ご請求書のご送付', r);
      var body = str_(getSetting_('請求書メール本文')) || defaultMailBody_(r, issuer);
      var options = { attachments: [pdf], name: issuer.name };
      var cc = str_(getSetting_('CC')).trim();
      if (cc) options.cc = cc;

      if (autoSend) {
        GmailApp.sendEmail(to, subject, fillTemplate_(body, r), options);
        didSend = true;
        sent.push(no);
      } else {
        GmailApp.createDraft(to, subject, fillTemplate_(body, r), options);
      }
      created.push(no);
    } catch (e) {
      skipped.push(no + ': ' + e.message);
      continue;
    }

    // 送信・下書きの直後に1件ずつ記録する。まとめて最後に記録すると、
    // 途中で止まったとき1件も記録されず、処理済みの全件が翌朝再送される。
    try {
      api_('/gas/invoices/mark-drafted', 'post', { invoice_nos: [no] });
      if (didSend) api_('/gas/invoices/mark-sent', 'post', { invoice_nos: [no] });
    } catch (e) {
      skipped.push(no + ': ' + (didSend ? '送信済みだが' : '下書き作成済みだが')
                   + '記録に失敗しました。再実行前に確認してください (' + e.message + ')');
    }
  }

  if (created.length > 0) syncAll_quiet_();
  return { created: created, skipped: skipped, sent: sent,
           targets: targets.length, remaining: deferred + (targets.length - i) };
}

// ---------------------------------------------------------------------
// 請求書PDF
// ---------------------------------------------------------------------

function issuerInfo_() {
  return {
    name: str_(getSetting_('自社名')) || 'ラクシフトAI',
    zip: str_(getSetting_('自社郵便番号')),
    address: str_(getSetting_('自社住所')),
    tel: str_(getSetting_('自社電話')),
    regNo: str_(getSetting_('インボイス登録番号')),
    bank: str_(getSetting_('振込先'))
  };
}

/** 「はい」なら自動送信。既定は下書きのみ。 */
function autoSendEnabled_() {
  return isOn_(getSetting_('請求書を自動送信する'));
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

/**
 * 請求書1件分のPDF。適格請求書(インボイス)の記載事項を満たす。
 *
 * レイアウトは table 組みにしている。Google の HTML→PDF 変換は
 * flexbox/grid を正しく解釈せず、display:flex に頼ると体裁が崩れるため。
 */
function buildInvoicePdf_(r, issuer) {
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var yen = function (n) { return Number(num_(n)).toLocaleString(); };
  var br  = function (s) { return esc(s).replace(/\n/g, '<br>'); };

  var total    = num_(r['請求額(税込)']);
  var tax      = num_(r['消費税']);
  var subtotal = num_(r['小計(税抜)']);
  // 税率は請求書の金額から出す。10%固定にすると、軽減税率や税率改定の際に
  // 内訳の見出しだけが実際の税額と食い違い、適格請求書として成立しなくなる。
  var taxRate  = subtotal > 0 ? Math.round(tax / subtotal * 100) : 10;
  var qty      = num_(r['数量']) || 1;
  var unit     = Math.round(total / qty);        // 単価は税込 (運用ルール)
  var itemName = str_(getSetting_('品目名')) || 'システム利用料';
  var period   = invoicePeriodLabel_(r);
  var custName = customerDisplayName_(r);

  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + '@page{size:A4;margin:14mm;}'
    + 'body{font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif;'
    +      'font-size:9.5pt;color:#111;margin:0;}'
    + 'h1{font-size:20pt;letter-spacing:10px;text-align:center;margin:0 0 26px;font-weight:600;}'
    + 'table{border-collapse:collapse;}'
    + '.head{width:100%;}'
    + '.head td{vertical-align:top;}'
    + '.cust{font-size:13pt;font-weight:600;border-bottom:1px solid #111;padding-bottom:5px;}'
    + '.issuer{font-size:9pt;line-height:1.7;}'
    + '.meta{font-size:9pt;margin-top:14px;}'
    + '.meta td{padding:1px 0;}'
    + '.meta td.k{padding-right:14px;color:#333;}'
    + '.amount{width:100%;border:1px solid #999;margin:22px 0 8px;}'
    + '.amount td{padding:12px 16px;}'
    + '.amount .lbl{font-size:12pt;font-weight:600;}'
    + '.amount .val{font-size:16pt;font-weight:600;}'
    + '.items{width:100%;margin-top:14px;}'
    + '.items th{font-size:8.5pt;font-weight:600;color:#333;border-bottom:1px solid #333;'
    +           'padding:5px 6px;text-align:left;}'
    + '.items td{font-size:9pt;padding:7px 6px;border-bottom:1px solid #e5e5e5;}'
    + '.sum{width:52%;margin-left:48%;margin-top:10px;}'
    + '.sum td{padding:5px 6px;font-size:9pt;border-bottom:1px solid #e5e5e5;}'
    + '.sum tr.tot td{font-size:12pt;font-weight:600;border-bottom:none;border-top:1px solid #333;}'
    + '.bd{margin-top:8px;}'
    + '.bd .cap{font-size:8.5pt;color:#333;padding-bottom:4px;}'
    + '.bd th,.bd td{font-size:8.5pt;border:1px solid #d5d5d5;padding:4px 10px;text-align:right;}'
    + '.bd th{background:#fafafa;font-weight:500;text-align:center;}'
    + '.sec{margin-top:20px;}'
    + '.sec .t{font-size:9pt;color:#333;margin-bottom:5px;}'
    + '.sec .b{border:1px solid #d5d5d5;padding:11px 13px;font-size:9pt;line-height:1.7;}'
    + '.r{text-align:right;}.c{text-align:center;}'
    + '</style></head><body>'

    + '<h1>請求書</h1>'

    + '<table class="head"><tr>'
    + '<td style="width:52%;padding-right:24px;">'
    +   '<div class="cust">' + esc(custName) + '　御中</div>'
    +   '<div style="margin-top:12px;font-size:9pt;">下記のとおりご請求申し上げます。</div>'
    + '</td>'
    + '<td style="width:48%;">'
    +   '<div class="issuer">'
    +     '<b>' + esc(issuer.name) + '</b><br>'
    +     (issuer.regNo ? '登録番号：' + esc(issuer.regNo) + '<br>' : '')
    +     '<div style="height:8px;"></div>'
    +     (issuer.zip ? '〒' + esc(issuer.zip) + '<br>' : '')
    +     (issuer.address ? br(issuer.address) + '<br>' : '')
    +     (issuer.tel ? 'TEL: ' + esc(issuer.tel) : '')
    +   '</div>'
    +   '<table class="meta">'
    +     '<tr><td class="k">請求書番号</td><td>' + esc(r['請求番号']) + '</td></tr>'
    +     '<tr><td class="k">請求日</td><td>' + esc(jpDate_(r['発行日'])) + '</td></tr>'
    +     '<tr><td class="k">お支払期限</td><td>' + esc(jpDate_(r['支払期限'])) + '</td></tr>'
    +   '</table>'
    + '</td></tr></table>'

    + '<table class="amount"><tr>'
    + '<td class="lbl" style="width:38%;">ご請求金額</td>'
    + '<td class="val">' + yen(total) + ' 円</td>'
    + '</tr></table>'

    + '<table class="items">'
    + '<tr><th style="width:20%;">利用期間</th><th>品目</th>'
    +   '<th class="r" style="width:13%;">単価</th>'
    +   '<th class="c" style="width:8%;">数量</th>'
    +   '<th class="c" style="width:8%;">単位</th>'
    +   '<th class="r" style="width:15%;">価格</th></tr>'
    + '<tr><td>' + esc(period) + '</td>'
    +   '<td>' + esc(itemName) + '</td>'
    +   '<td class="r">' + yen(unit) + '</td>'
    +   '<td class="c">' + qty + '</td>'
    +   '<td class="c">式</td>'
    +   '<td class="r">' + yen(total) + '</td></tr>'
    + '</table>'

    + '<table class="sum">'
    + '<tr><td>小計（税抜）</td><td class="r">' + yen(subtotal) + '</td></tr>'
    + '<tr><td>消費税額合計</td><td class="r">' + yen(tax) + '</td></tr>'
    + '<tr class="tot"><td>合計</td><td class="r">' + yen(total) + '</td></tr>'
    + '</table>'

    + '<div class="bd"><div class="cap">税率別内訳</div>'
    + '<table class="bd">'
    + '<tr><th style="width:70px;"></th><th style="width:110px;">税抜金額</th>'
    +     '<th style="width:110px;">消費税額</th><th style="width:110px;">税込金額</th></tr>'
    + '<tr><th>' + taxRate + '%</th><td>' + yen(subtotal) + '</td><td>' + yen(tax) + '</td>'
    +     '<td>' + yen(total) + '</td></tr>'
    + '</table></div>'

    + (issuer.bank
        ? '<div class="sec"><div class="t">振込先</div><div class="b">' + br(issuer.bank) + '</div></div>'
        : '')
    + '<div class="sec"><div class="t">備考</div><div class="b">'
    +   br(str_(getSetting_('請求書備考')) || '恐れ入りますが、振込手数料は貴社負担にてお願いいたします。')
    + '</div></div>'

    + '</body></html>';

  return Utilities.newBlob(html, 'text/html', 'invoice.html')
    .getAs('application/pdf')
    .setName('請求書_' + str_(r['請求番号']) + '_' + custName + '.pdf');
}

/**
 * 宛名。顧客管理の「会社名」(法人格つき)を優先し、無ければ店舗名/屋号を使う。
 * 顧客側が「株式会社」を含めて登録していればそのまま反映される。
 */
function customerDisplayName_(r) {
  var company = str_(r['会社名']).trim();
  if (company) return company;
  return str_(r['顧客名']).trim();
}

/** 利用期間の表示 (2026/08/15〜2026/09/14)。無ければ対象月にフォールバック */
function invoicePeriodLabel_(r) {
  var s = ymd_(r['利用開始']), e = ymd_(r['利用終了']);
  if (s && e) return jpDate_(s) + '〜' + jpDate_(e);
  var m = str_(r['対象月']);
  return m ? m.replace('-', '/') : '';
}

/** yyyy-mm-dd → yyyy/mm/dd */
function jpDate_(v) {
  var d = ymd_(v);
  return d ? d.replace(/-/g, '/') : '';
}


// ---------------------------------------------------------------------
// テスト用: 見た目を確認するための下書きを1件だけ作る
// ---------------------------------------------------------------------

/**
 * 請求書のレイアウト確認用。実在の顧客には送らず、自分宛の下書きを1件作る。
 * 請求・入金シートに行があればその1件目を、無ければサンプル値を使う。
 */
function createTestDraft() {
  return guard_('テスト請求書の下書き作成', function () {
    var ui = SpreadsheetApp.getUi();
    var to = notifyTo_();
    if (!to) { ui.alert('送信先が特定できませんでした。「⚙️設定」シートの「通知先メール」を入力してください。'); return; }

    var rows = readSheet_(SHEETS.INVOICES).rows;
    var r = rows.length ? rows[0] : sampleInvoiceRow_();
    var issuer = issuerInfo_();
    var pdf = buildInvoicePdf_(r, issuer);
    var subject = '【テスト】' + fillTemplate_(
      str_(getSetting_('請求書メール件名')) || '【ラクシフトAI】{対象月}分 ご請求書のご送付', r);
    var body = '※ これはレイアウト確認用のテストです。顧客には送信されていません。\n\n'
             + fillTemplate_(str_(getSetting_('請求書メール本文')) || defaultMailBody_(r, issuer), r);

    GmailApp.createDraft(to, subject, body, { attachments: [pdf], name: issuer.name });

    ui.alert('テスト用の下書きを作成しました。\n\n'
             + '宛先: ' + to + '（自分宛）\n'
             + '請求書番号: ' + str_(r['請求番号']) + '\n'
             + '金額: ¥' + Number(num_(r['請求額(税込)'])).toLocaleString() + '\n\n'
             + 'Gmailの「下書き」を開いてPDFをご確認ください。'
             + (rows.length ? '' : '\n\n（請求データが無いためサンプル値で作成しました）'));
  });
}

/** 請求データが無いときのサンプル */
function sampleInvoiceRow_() {
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var d = new Date();
  var end = new Date(d.getFullYear(), d.getMonth() + 1, d.getDate() - 1);
  return {
    '請求番号': 'INV-TEST000001',
    '対象月': Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM'),
    '利用開始': today,
    '利用終了': Utilities.formatDate(end, 'Asia/Tokyo', 'yyyy-MM-dd'),
    '顧客名': 'テスト店舗',
    '会社名': 'テスト株式会社',
    '請求先メール': '',
    'プラン': 'Standard',
    '発行日': today,
    '支払期限': Utilities.formatDate(new Date(d.getTime() + 10 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd'),
    '数量': 1,
    '単価': 3380,
    '小計(税抜)': 3073,
    '消費税': 307,
    '請求額(税込)': 3380,
    '状態': '未入金'
  };
}
