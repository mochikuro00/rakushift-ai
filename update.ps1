$content = Get-Content -Path "f:\ラクシフト\js\app_v2.js" -Encoding UTF8 -Raw

# 1. adminHeader.innerHTML から「AIシフト作成」ボタンを削除
$content = $content -replace '<button onclick="app.openModal\(''autoFillModal''\)" class="hidden md:flex items-center gap-2 px-3 py-1.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded shadow transition-all">\s*<i class="fa-solid fa-wand-magic-sparkles"></i> AIシフト作成\s*</button>\s*<div class="h-8 w-px bg-gray-300 mx-2 hidden md:block"></div>', ''

# 2. renderShiftView の中に「AIシフト作成」ボタンを追加
$search = '<div class="bg-gray-100 p-1 rounded-lg flex items-center shadow-inner">'
$replace = "${this.state.isAdmin ? `<button onclick="app.openModal('autoFillModal')" class="hidden md:flex items-center gap-2 px-3 py-1.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded shadow transition-all mr-2"><i class="fa-solid fa-wand-magic-sparkles"></i> AIシフト作成</button>` : ''}
                        <div class="bg-gray-100 p-1 rounded-lg flex items-center shadow-inner">"
$content = $content.Replace($search, $replace)

# 3. renderSettings にお知らせ管理ボタンを追加
$search2 = '<button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">'
$replace2 = '<div class="flex flex-col gap-2 shrink-0"><button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center justify-center whitespace-nowrap">'
$content = $content.Replace($search2, $replace2)

$search3 = '<i class="fa-solid fa-save mr-2"></i>設定を保存'
$replace3 = '<i class="fa-solid fa-save mr-2"></i>設定を保存</button><button onclick="app.changeView(''shop_announcements'')" class="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-yellow-200 transition-all transform active:scale-95 flex items-center justify-center whitespace-nowrap"><i class="fa-solid fa-bullhorn mr-2"></i>お知らせ管理'
$content = $content.Replace($search3, $replace3)

$search4 = '</div>\s*</div>\s*<!-- 1\. 役職'
$replace4 = '</div></div></div><!-- 1. 役職'
# Fix div matching is risky, maybe regex
$content = $content -replace 'shrink-0">\s*<i class="fa-solid fa-save mr-2"></i>設定を保存\s*</button>', 'shrink-0"><i class="fa-solid fa-save mr-2"></i>設定を保存</button><button onclick="app.changeView(''shop_announcements'')" class="bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-yellow-200 transition-all transform active:scale-95 flex items-center justify-center whitespace-nowrap"><i class="fa-solid fa-bullhorn mr-2"></i>お知らせ管理</button></div>'

[IO.File]::WriteAllText("f:\ラクシフト\js\app_v2.js", $content, [System.Text.Encoding]::UTF8)
