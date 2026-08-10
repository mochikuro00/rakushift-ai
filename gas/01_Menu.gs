/**
 * 01_Menu.gs — カスタムメニューと初期設定
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ラクシフト運営')
    .addItem('🔄 全データを同期', 'syncAll')
    .addSeparator()
    .addItem('🧾 対象月の請求書を一括生成', 'generateInvoicesForMonth')
    .addItem('📧 未送付の請求書をGmail下書きに作成', 'createInvoiceDrafts')
    .addItem('🧪 テスト請求書を下書きに作成（自分宛）', 'createTestDraft')
    .addSeparator()
    .addItem('🤖 入金を自動で消し込む', 'autoReconcilePayments')
    .addItem('💰 入金を手動で反映（消込）', 'pushPayments')
    .addItem('📮 期日超過に督促する', 'sendOverdueReminders')
    .addItem('🏢 代理店設定をシステムに反映', 'pushAgencySettings')
    .addSeparator()
    .addItem('✅ 突合チェック（お問い合わせ×顧客）', 'runReconcile')
    .addSeparator()
    .addItem('⏰ 自動実行をONにする', 'setupTriggers')
    .addItem('⏸️ 自動実行を解除する', 'disableTriggers')
    .addItem('📅 自動実行の状態を確認', 'showTriggerStatus')
    .addSeparator()
    .addItem('⚙️ 初期設定（APIキー登録）', 'setupApiKey')
    .addItem('🧱 シートを初期化', 'initSheets')
    .addToUi();
}

function setupApiKey() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    'APIキーの登録',
    '運営管理画面で発行した GAS 連携APIキー（gas_api_key）を貼り付けてください。\n' +
    'このキーはスプレッドシートには保存されず、スクリプトのプロパティに保管されます。',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  var key = res.getResponseText().trim();
  if (key.length < 16) {
    ui.alert('APIキーが短すぎます（16文字以上）。処理を中止しました。');
    return;
  }
  PropertiesService.getScriptProperties().setProperty(PROP_API_KEY, key);

  try {
    api_('/gas/export?sheet=summary', 'get');
    ui.alert('APIキーを登録し、接続を確認しました。');
  } catch (e) {
    ui.alert('APIキーは保存しましたが、接続に失敗しました:\n' + e.message);
  }
}

function initSheets() {
  setupSettingsSheet_();
  Object.keys(SHEETS).forEach(function (k) { getOrCreateSheet_(SHEETS[k]); });
  setupPasteSheet_();
  SpreadsheetApp.getUi().alert('シートを初期化しました。続けて「🔄 全データを同期」を実行してください。');
}

/** メニュー実行時の共通エラーハンドラ */
function guard_(label, fn) {
  try {
    return fn();
  } catch (e) {
    SpreadsheetApp.getUi().alert(label + ' に失敗しました:\n\n' + e.message);
    throw e;
  }
}
