/**
 * 05_Reconcile.gs — お問い合わせフォーム × 顧客リストの突合
 *
 * 検出するもの:
 *   1. 未契約の問い合わせ        … フォームは来たが顧客になっていない（対応漏れ）
 *   2. 問い合わせ記録なしの顧客  … 手動発行や別経路で契約した顧客
 *   3. 紹介者コード不一致        … 問い合わせ時と契約時で紹介者が食い違う
 *                                  （代理店フィーの付け漏れ・誤付与になる）
 *
 * 照合はメールアドレス → 電話番号 → 会社名/事業者名 の順で、
 * 空白・記号・大文字小文字を無視して行う（システム側の reconcile_inquiries）。
 */

function runReconcile() {
  return guard_('突合チェック', function () {
    var data = api_('/gas/export?sheet=reconcile,customers,inquiries&month='
                    + encodeURIComponent(targetMonth_()), 'get');
    var reconcile = data.reconcile || {};

    syncReconcile_(reconcile);
    syncCustomers_(data.customers || [], reconcile);
    syncInquiries_(data.inquiries || [], reconcile);
    saveSnapshot_();

    var orphans = (reconcile.inquiries || []).filter(function (q) { return q.is_orphan; }).length;
    var noInquiry = (reconcile.customers_without_inquiry || []).length;
    var mismatch = (reconcile.referrer_mismatch || []).length;

    var sheet = ss_().getSheetByName(SHEETS.RECONCILE);
    if (sheet) ss_().setActiveSheet(sheet);

    if (orphans + noInquiry + mismatch === 0) {
      SpreadsheetApp.getUi().alert('✅ 突合チェック完了\n\n抜け・不一致はありませんでした。');
      return;
    }
    SpreadsheetApp.getUi().alert(
      '突合チェック完了\n\n'
      + '⚠ 未契約の問い合わせ: ' + orphans + '件\n'
      + '⚠ 問い合わせ記録なしの顧客: ' + noInquiry + '件\n'
      + '⚠ 紹介者コード不一致: ' + mismatch + '件\n\n'
      + '「' + SHEETS.RECONCILE + '」シートで内容を確認してください。');
  });
}
