/**
 * 06_Triggers.gs — 自動実行 (時間主導トリガー)
 *
 * 自動でやること:
 *   毎朝  7:00  … 全データ同期
 *                 → 請求日を迎えた顧客の請求書を生成 (契約日基準の応当日)
 *                 → Gmail下書きまで作成 (設定を「はい」にすれば送信まで)
 *                 → 突合チェック。要確認があれば運営へメール通知
 *   毎月1日 8:00 … 前月の売上サマリーを通知
 *
 * 請求サイクルが暦月ではなく契約日基準になったため、生成は日次で回す必要がある。
 * (毎月1日にまとめて作ると、月中に応当日が来る顧客の請求が漏れる)
 *
 * 自動でやらないこと (意図的に人の手を残す):
 *   - 請求書メールの送信      … 誤請求は取り返しがつかないため、必ず目視してから送る
 *   - 入金の記録              … 銀行入金の確認は人の作業
 *   - 代理店フィーの変更      … 契約条件の判断が必要
 *
 * 注意:
 *   トリガー実行中は SpreadsheetApp.getUi() が例外になるため、
 *   ここからは UI に触れない *_core_ / *_quiet_ 系のみを呼ぶ。
 */

var TRIG_DAILY = 'dailyJob';
var TRIG_MONTHLY = 'monthlyJob';
var PROP_LAST_ALERT = 'LAST_RECONCILE_SIGNATURE';

// =====================================================================
// トリガーの設定 / 解除
// =====================================================================

function setupTriggers() {
  return guard_('自動実行の設定', function () {
    var ui = SpreadsheetApp.getUi();
    if (ui.alert('自動実行をONにする',
                 '次のスケジュールで自動実行します。\n\n'
                 + '・毎朝 7時台\n'
                 + '　　全データ同期\n'
                 + '　　請求日を迎えた顧客の請求書を作成（契約日から1ヶ月ごと）\n'
                 + '　　Gmail下書きまで作成（設定を「はい」にすれば送信まで自動）\n'
                 + '　　入金明細を取り込んで請求書に自動照合（消込）\n'
                 + '　　期日超過に督促（設定でON）\n'
                 + '　　突合チェック。要確認があればメール通知\n\n'
                 + '・毎月1日 8時台\n'
                 + '　　前月の売上・代理店フィー・返金・解約の実績を通知\n\n'
                 + '入金の記録と代理店設定の変更は、これまでどおり手動です。\n\nよろしいですか？',
                 ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

    removeTriggers_();   // 二重登録を防ぐ
    ScriptApp.newTrigger(TRIG_DAILY).timeBased().atHour(7).everyDays(1).create();
    ScriptApp.newTrigger(TRIG_MONTHLY).timeBased().onMonthDay(1).atHour(8).create();

    ui.alert('自動実行をONにしました。\n\n'
             + '通知先: ' + notifyTo_() + '\n'
             + '（変更する場合は「⚙️設定」シートの「通知先メール」に入力してください）');
  });
}

function disableTriggers() {
  return guard_('自動実行の解除', function () {
    var ui = SpreadsheetApp.getUi();
    var n = removeTriggers_();
    ui.alert(n > 0 ? ('自動実行をOFFにしました（' + n + '件のトリガーを削除）')
                   : '自動実行は設定されていません。');
  });
}

/** このスクリプトが作った時間主導トリガーだけを削除する */
function removeTriggers_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === TRIG_DAILY || fn === TRIG_MONTHLY) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

function showTriggerStatus() {
  return guard_('自動実行の状態', function () {
    var list = ScriptApp.getProjectTriggers().filter(function (t) {
      var fn = t.getHandlerFunction();
      return fn === TRIG_DAILY || fn === TRIG_MONTHLY;
    });
    var label = { dailyJob: '毎朝の同期・請求書作成・突合', monthlyJob: '毎月1日の実績通知' };
    SpreadsheetApp.getUi().alert(
      list.length === 0
        ? '自動実行は OFF です。\n\nメニュー「⏰ 自動実行をONにする」で有効化できます。'
        : '自動実行は ON です。\n\n'
          + list.map(function (t) { return '・' + (label[t.getHandlerFunction()] || t.getHandlerFunction()); }).join('\n')
          + '\n\n通知先: ' + notifyTo_());
  });
}

// =====================================================================
// 自動実行される処理
// =====================================================================

/**
 * 毎朝の自動処理。
 *   同期 → 請求書作成 → 下書き/送信 → 入金の自動消込 → 督促 → 突合
 * 通知は1通のダイジェストにまとめる (毎朝4通届くと読まれなくなるため)。
 * 何も起きなかった日は通知しない。
 */
function dailyJob() {
  var sections = [];
  var headline = [];

  try {
    // 同期はシートを作り直すため、書き戻していない編集は退避・復元される。
    // 運営が編集したまま帰った翌朝に黙って消えることがないよう、件数を通知に載せる。
    var kept = syncAll_quiet_();
    if (kept > 0) {
      sections.push('■ 未反映の編集 (' + kept + '行)\n'
        + '　シート上の黄色いセルがシステムへ反映されていません。\n'
        + '　「代理店設定をシステムに反映」または「入金を手動で反映」を実行してください。');
      headline.push('未反映の編集' + kept + '行');
    }
  } catch (e) {
    notifyError_('毎朝の同期', e);
    return;   // 同期できていない状態で後続を動かさない
  }

  // ---- 1) 請求書の作成と下書き ----
  try {
    var gen = generateInvoices_core_();
    var dr = createDrafts_core_();
    var sentN = (dr && dr.sent) ? dr.sent.length : 0;

    if ((gen && gen.created > 0) || (dr && dr.created.length > 0)) {
      var l = ['■ 請求書', '　作成: ' + ((gen && gen.created) || 0) + '件'];
      ((gen && gen.invoices) || []).forEach(function (x) {
        l.push('　　- ' + str_(x.shop_name) + '　' + str_(x.period_start) + '〜' + str_(x.period_end)
               + '　¥' + Number(num_(x.total)).toLocaleString());
      });
      if (gen && gen.no_price_count > 0) {
        l.push('　⚠ プラン未設定で作成できず: ' + gen.no_price_count + '件 ('
               + (gen.no_price_contracts || []).join(', ') + ')');
      }
      l.push(sentN > 0 ? ('　メール送信: ' + sentN + '件（自動送信ON）')
                       : ('　Gmail下書き: ' + dr.created.length + '件'));
      if (dr.skipped.length) {
        l.push('　⚠ スキップ: ' + dr.skipped.length + '件');
        dr.skipped.slice(0, 10).forEach(function (x) { l.push('　　- ' + x); });
      }
      if (dr.remaining > 0) {
        l.push('　※ 上限のため ' + dr.remaining + ' 件を明日に回しました');
      }
      sections.push(l.join('\n'));
      if (sentN === 0 && dr.created.length > 0) {
        headline.push('下書き' + dr.created.length + '件の送信');
      }
    }
  } catch (e) {
    notifyError_('請求書の自動作成', e);
  }

  // ---- 2) 入金の自動消込 ----
  try {
    if (isOn_(getSetting_('入金を自動で消し込む'))) {
      var rec = autoReconcile_core_();
      if (rec.matched + rec.ambiguous + rec.unmatched > 0) {
        var m = ['■ 入金',
                 '　取込: ' + rec.imported + '件 / 消込: ' + rec.matched + '件'];
        (rec.matched_list || []).slice(0, 20).forEach(function (x) {
          m.push('　　- ' + str_(x.invoice_no) + '  ¥' + Number(num_(x.amount)).toLocaleString()
                 + '  ' + str_(x.payer_name));
        });
        if (rec.ambiguous + rec.unmatched > 0) {
          m.push('　⚠ 要確認: ' + rec.ambiguous + '件 / 該当なし: ' + rec.unmatched + '件');
          m.push('　　「入金明細」シートの「照合先請求番号」に請求番号を入れ、'
                 + '「入金を手動で反映」を実行してください');
          headline.push('入金' + (rec.ambiguous + rec.unmatched) + '件の確認');
        }
        if (rec.overPaid > 0) {
          // 請求額を超えた分はどの請求にも充てていない。放置すると前受けのまま残る。
          m.push('　⚠ 請求額を超える入金: ' + rec.overPaid + '件（超過分は前受けとして未充当）');
          m.push('　　「入金明細」シートのメモに超過額が出ています');
          headline.push('前受け' + rec.overPaid + '件の確認');
        }
        if (rec.importError) m.push('　⚠ ' + rec.importError);
        sections.push(m.join('\n'));
      }
    }
  } catch (e) {
    notifyError_('入金の自動消込', e);
  }

  // ---- 3) 支払督促 ----
  try {
    if (isOn_(getSetting_('支払督促を自動で送る'))) {
      var rem = sendReminders_core_();
      if (rem.created.length > 0) {
        var rr = ['■ 支払督促',
                  (rem.sent.length ? '　送信: ' + rem.sent.length + '件'
                                   : '　下書き: ' + rem.created.length + '件'),
                  '　　' + rem.created.join(', ')];
        if (rem.skipped.length) {
          rr.push('　⚠ スキップ: ' + rem.skipped.length + '件');
          rem.skipped.slice(0, 10).forEach(function (x) { rr.push('　　- ' + x); });
        }
        if (rem.remaining > 0) {
          rr.push('　※ 上限のため ' + rem.remaining + ' 件を明日に回しました');
        }
        sections.push(rr.join('\n'));
        if (rem.sent.length === 0) headline.push('督促' + rem.created.length + '件の送信');
      }
    }
  } catch (e) {
    notifyError_('支払督促', e);
  }

  // ---- 4) 突合と未入金 ----
  var issues = null;
  try {
    issues = collectIssues_();
  } catch (e) {
    notifyError_('突合チェック', e);
  }

  var props = PropertiesService.getScriptProperties();
  if (issues && issues.total > 0) {
    // 同じ内容が続く間は毎朝出さない (ダイジェスト全体は他に動きがあれば出す)
    if (props.getProperty(PROP_LAST_ALERT) !== issues.signature) {
      props.setProperty(PROP_LAST_ALERT, issues.signature);
      sections.push('■ 要確認 (' + issues.total + '件)\n' + issues.body);
      headline.push('要確認' + issues.total + '件');
    }
  } else {
    props.deleteProperty(PROP_LAST_ALERT);
  }

  if (sections.length === 0) return;   // 動きが無い日は通知しない

  var subject = headline.length
    ? ('【ラクシフトAI運営】要対応: ' + headline.join(' / '))
    : '【ラクシフトAI運営】本日の処理結果';
  notify_(subject,
          Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd') + ' の自動処理\n\n'
          + sections.join('\n\n')
          + '\n\nスプレッドシート: ' + sheetUrl_());
}

/** 設定値が「はい」系かどうか */
function isOn_(v) {
  return /^(はい|yes|true|on|1)$/i.test(str_(v).trim());
}

/** 毎月1日: 前月の実績をまとめて通知する (請求書の生成は日次で行う) */
function monthlyJob() {
  try {
    syncAll_quiet_();
    var rows = readSheet_(SHEETS.SUMMARY).rows;
    var d = new Date();
    var prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    var ym = Utilities.formatDate(prev, 'Asia/Tokyo', 'yyyy-MM');
    var row = rows.filter(function (r) { return str_(r['対象月']) === ym; })[0];

    var lines = [ym + ' の実績です。', ''];
    if (row) {
      lines.push('■ 売上');
      lines.push('　請求額: ¥' + Number(num_(row['請求額'])).toLocaleString()
                 + '（' + num_(row['請求件数']) + '件）');
      lines.push('　入金額: ¥' + Number(num_(row['入金額'])).toLocaleString());
      lines.push('　未入金: ¥' + Number(num_(row['未入金額'])).toLocaleString()
                 + '（' + num_(row['未入金件数']) + '件）');
      lines.push('');
      lines.push('■ 代理店フィー');
      lines.push('　支払対象(入金済): ¥' + Number(num_(row['支払対象フィー(入金済)'])).toLocaleString());
      lines.push('　保留(未入金分): ¥'
                 + Number(num_(row['代理店フィー']) - num_(row['支払対象フィー(入金済)'])).toLocaleString());
    } else {
      lines.push('（' + ym + ' の請求データがありません）');
    }

    var refunds = readSheet_(SHEETS.REFUNDS).rows.filter(function (r) {
      return ymd_(r['返金日']).slice(0, 7) === ym && str_(r['テスト']) !== 'テスト';
    });
    if (refunds.length) {
      var sum = refunds.reduce(function (a, r) { return a + num_(r['返金額']); }, 0);
      lines.push('', '■ 返金（売上サマリーには含めていません）',
                 '　' + refunds.length + '件 / ¥' + Number(sum).toLocaleString());
    }

    var cancels = readSheet_(SHEETS.CANCELLED).rows.filter(function (r) {
      return ymd_(r['解約日']).slice(0, 7) === ym;
    });
    if (cancels.length) {
      var early = cancels.filter(function (r) { return str_(r['早期解約']) !== ''; }).length;
      lines.push('', '■ 解約', '　' + cancels.length + '件（うち早期解約 ' + early + '件）');
      cancels.slice(0, 20).forEach(function (r) {
        lines.push('　- ' + str_(r['会社名'] || r['店舗名']) + '　契約 ' + num_(r['契約期間(月)']) + 'ヶ月');
      });
    }

    lines.push('', 'スプレッドシート: ' + sheetUrl_());
    notify_('【ラクシフトAI運営】' + ym + ' の実績', lines.join('\n'));
  } catch (e) {
    notifyError_('毎月の実績通知', e);
  }
}

// =====================================================================
// 異常の収集と通知
// =====================================================================

/** 突合チェックと未入金から「人が見るべきこと」を集める */
function collectIssues_() {
  var rec = api_('/gas/export?sheet=reconcile', 'get').reconcile || {};
  var orphans = (rec.inquiries || []).filter(function (q) { return q.is_orphan; });
  var mismatch = rec.referrer_mismatch || [];

  // 期日を過ぎた未入金
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var overdue = readSheet_(SHEETS.INVOICES).rows.filter(function (r) {
    var st = str_(r['状態']);
    if (st === '入金済' || st === '無効') return false;
    var due = ymd_(r['支払期限']);
    return due !== '' && due < today;
  });

  var lines = [];
  if (orphans.length) {
    lines.push('■ 未契約のまま残っているお問い合わせ: ' + orphans.length + '件');
    orphans.slice(0, 20).forEach(function (q) {
      lines.push('　- ' + str_(q.company_name || q.business_name) + '（' + ymdhm_(q.created_at) + '）');
    });
    lines.push('');
  }
  if (mismatch.length) {
    lines.push('■ 紹介者コードの不一致: ' + mismatch.length + '件（代理店フィーの付け漏れ・誤付与の可能性）');
    mismatch.slice(0, 20).forEach(function (m) {
      lines.push('　- ' + str_(m.shop_name) + ' 問合せ:' + str_(m.inquiry_referrer)
                 + ' / 顧客:' + str_(m.customer_referrer));
    });
    lines.push('');
  }
  if (overdue.length) {
    lines.push('■ 支払期日を過ぎた未入金: ' + overdue.length + '件');
    overdue.slice(0, 20).forEach(function (r) {
      lines.push('　- ' + str_(r['請求番号']) + ' ' + str_(r['顧客名'])
                 + ' ¥' + Number(num_(r['請求額(税込)'])).toLocaleString()
                 + '（期限 ' + ymd_(r['支払期限']) + '）');
    });
    lines.push('');
  }
  if (lines.length) lines.push('スプレッドシート: ' + sheetUrl_());

  return {
    total: orphans.length + mismatch.length + overdue.length,
    signature: [orphans.length, mismatch.length, overdue.length].join('/'),
    body: lines.join('\n'),
  };
}

/** 通知先。設定シートに無ければスクリプト実行者のアドレス */
function notifyTo_() {
  var to = str_(getSetting_('通知先メール')).trim();
  if (to) return to;
  try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ''; }
}

function notify_(subject, body) {
  var to = notifyTo_();
  if (!to) return;
  MailApp.sendEmail(to, subject, body);
}

function notifyError_(label, e) {
  // 通知本文の組み立てで失敗すると「エラーが起きたこと自体」が消えてしまうため、
  // 付加情報 (シートURL等) の取得は個別に握りつぶし、本文だけは必ず送る。
  var body = label + ' が失敗しました。\n\n' + (e && e.message ? e.message : String(e));
  try { if (e && e.stack) body += '\n\n' + e.stack; } catch (_) {}
  try { body += '\n\nスプレッドシート: ' + sheetUrl_(); } catch (_) {}
  try {
    notify_('【ラクシフトAI運営】' + label + ' でエラー', body);
  } catch (_) { /* 通知経路自体が死んでいる場合は実行ログに残る */ }
}

/** シートのURL。取得できない環境でも例外にしない */
function sheetUrl_() {
  try {
    var s = ss_();
    return (s && typeof s.getUrl === 'function') ? s.getUrl() : '';
  } catch (e) {
    return '';
  }
}
