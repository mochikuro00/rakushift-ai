/**
 * password_toggle.js (v3.7.280)
 * すべての <input type="password"> に目のマーク(表示/非表示切替)を付与する汎用エンハンサー。
 * 静的・動的(モーダル遅延生成)どちらの入力欄にも自動適用 (MutationObserver)。
 */
(function () {
    function enhance(input) {
        if (!input || input.dataset.eyeBound) return;
        if (input.type !== 'password') return;
        input.dataset.eyeBound = '1';

        // アイコン分の余白を確保
        const prevPr = getComputedStyle(input).paddingRight;
        input.style.paddingRight = 'calc(' + (prevPr && prevPr !== '0px' ? prevPr : '0.75rem') + ' + 1.75rem)';

        const wrap = document.createElement('span');
        wrap.style.cssText = 'position:relative;display:block;';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.tabIndex = -1;
        btn.setAttribute('aria-label', 'パスワードを表示');
        btn.style.cssText = 'position:absolute;right:0.55rem;top:50%;transform:translateY(-50%);' +
            'background:none;border:none;cursor:pointer;color:#9ca3af;padding:4px;line-height:1;font-size:0.95rem;z-index:2;';
        btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
        btn.addEventListener('click', function () {
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.innerHTML = show ? '<i class="fa-solid fa-eye-slash"></i>' : '<i class="fa-solid fa-eye"></i>';
            btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
        });
        wrap.appendChild(btn);
    }

    function scan(root) {
        (root || document).querySelectorAll && (root || document)
            .querySelectorAll('input[type="password"]:not([data-eye-bound])')
            .forEach(enhance);
    }

    function init() {
        scan(document);
        // 動的に追加される入力欄(モーダル等)にも対応
        const obs = new MutationObserver(function (muts) {
            for (const m of muts) {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.matches && n.matches('input[type="password"]')) enhance(n);
                    else scan(n);
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
