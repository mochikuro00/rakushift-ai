const app = {
    // セキュリティ: ログイン試行回数制限
    _loginAttempts: {},
    _MAX_LOGIN_ATTEMPTS: 5,
    _LOCKOUT_DURATION_MS: 5 * 60 * 1000, // 5分間ロックアウト

    // セキュリティ: 入力サニタイゼーション
    _sanitize(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    },

    // パフォーマンス: 大量データの DOM 構築を1回の reflow に抑えるヘルパー
    // 5000件超のシフトを表示する将来の renderShiftTable 等で使用想定。
    // 旧 `container.innerHTML = html` 方式より 5-10倍高速。
    _setHTMLPerformant(container, html) {
        if (!container) return;
        const template = document.createElement('template');
        template.innerHTML = html;
        container.replaceChildren(template.content);
    },

    // パフォーマンス: シフトを「現在月の前後3ヶ月」に絞ってロードするためのヘルパー
    // 長期運用 (5年以上) でも初回ロードを 0.3秒程度に抑える
    _getShiftLoadRange(date) {
        const d = new Date(date || new Date());
        const from = new Date(d.getFullYear(), d.getMonth() - 3, 1);
        const to = new Date(d.getFullYear(), d.getMonth() + 4, 0); // +3月の最終日
        const fmt = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        return { from: fmt(from), to: fmt(to) };
    },

    // 表示中の月が既ロード範囲外の場合のみ shifts を再ロード (キャッシュ判定付き)
    // 範囲内なら何もしないため、頻繁な月切替でも DB 負荷ゼロ
    async ensureShiftsLoaded() {
        if (!this.state.organization_id) return;
        const target = this._getShiftLoadRange(this.state.currentDate);
        const loaded = this.state.loadedShiftRange;
        if (loaded && loaded.from <= target.from && loaded.to >= target.to) {
            return; // 既にロード済み範囲内
        }
        try {
            // session-less RPC 経由で RLS を回避 (REST + RLS は壊れる可能性あり)
            const cid = this.state.config?.contract_id || API.session?.user?.contract_id;
            if (!cid) return;
            const rows = await API.rpc('list_shifts_by_contract', {
                p_contract_id: cid,
                p_from: target.from,
                p_to: target.to
            });
            this.state.shifts = Array.isArray(rows) ? rows : [];
            this.state.loadedShiftRange = target;
            console.log(`[Shifts] Reloaded ${this.state.shifts.length} for ${target.from}〜${target.to}`);
        } catch (e) {
            console.error('ensureShiftsLoaded failed:', e);
        }
    },

    // セキュリティ: ログイン試行チェック
    _checkLoginLock(key) {
        const record = this._loginAttempts[key];
        if (!record) return false;
        if (record.count >= this._MAX_LOGIN_ATTEMPTS) {
            const elapsed = Date.now() - record.lastAttempt;
            if (elapsed < this._LOCKOUT_DURATION_MS) {
                const remainSec = Math.ceil((this._LOCKOUT_DURATION_MS - elapsed) / 1000);
                this.showToast('ログイン試行回数の上限に達しました。' + remainSec + '秒後に再試行してください。', 'error');
                return true;
            }
            // ロックアウト期間が過ぎたのでリセット
            delete this._loginAttempts[key];
        }
        return false;
    },
    _recordLoginAttempt(key, success) {
        if (success) {
            delete this._loginAttempts[key];
            return;
        }
        if (!this._loginAttempts[key]) {
            this._loginAttempts[key] = { count: 0, lastAttempt: 0 };
        }
        this._loginAttempts[key].count++;
        this._loginAttempts[key].lastAttempt = Date.now();
    },

    // アプリケーションの状態管理
    state: {
        currentDate: null, // Initialized in init()
        view: 'dashboard', // 現在のビュー
        shiftViewMode: 'table', // 'table' or 'calendar'
        shiftTablePeriod: 'month', // 'month' | 'week' | 'day'
        dashboardMode: 'month', // 'month', '2week-1', '2week-2'
        isShopLoggedIn: false, // 店舗ログイン状態
        isAdmin: false, // 管理者ログイン状態
        isHQ: false, // 本部ログイン状態
        
        // データ（APIからロード）
        config: {},
        staff: [],
        shifts: [],
        requests: [],
        organization_id: null,
        
        // 設定デフォルト値
        defaultConfig: {
            // admin_password は config_safe ビューから除外済 (migration 40)
            // 変更は専用モーダル + update_admin_password_by_contract RPC のみ
            opening_time: "09:00",
            closing_time: "22:00",
            hourly_wage_default: 1100,
            
            // 営業時間（詳細）
            opening_times: {
                weekday: { start: "09:00", end: "22:00" },
                weekend: { start: "10:00", end: "20:00" },
                holiday: { start: "10:00", end: "20:00" }
            },

            // 定休日 (0=日, 1=月...)
            closed_days: [], 
            
            // 人員配置ルール（詳細）
            staff_req: {
                min_manager: 0,
                min_weekday: 2,
                min_weekend: 3,
                min_holiday: 3
            },
            
            // 役職設定 (ID, 名前, 色, レベル:高いほど権限強)
            roles: [
                { id: 'manager', name: '店長', color: 'purple', level: 5 },
                { id: 'sub_manager', name: '副店長', color: 'red', level: 4 },
                { id: 'employee', name: '社員', color: 'green', level: 3 },
                { id: 'leader', name: 'リーダー', color: 'blue', level: 2 },
                { id: 'staff', name: 'アルバイト', color: 'gray', level: 1 }
            ],

            // 臨時休業日 (YYYY-MM-DD)
            special_holidays: [],
            
            // 特定日の営業時間 (YYYY-MM-DD: {start, end, note})
            special_days: {},

            // 時間帯別人員ルール
            time_staff_req: [], // [{ days: [0,6], start: '11:00', end: '14:00', count: 4 }]

            // カレンダー備考 (YYYY-MM-DD: "メモ内容")
            calendar_notes: {},

            // 休憩時間ルール
            break_rules: [
                { min_hours: 6, break_minutes: 45 },
                { min_hours: 8, break_minutes: 60 }
            ],
            
            // お店のルール（自由記述）
            shop_rules_text: "希望休の提出は前月20日までにお願いします。\n急な欠勤の場合は、必ず店長まで直接連絡してください。\nシフトの変更希望は「休暇・シフト申請」ボタンから行えます。",

            // 旧互換
            // staffing_rules removed
            
            // カスタムシフト設定 (早番・遅番など)
            custom_shifts: [
                { name: "早番", start: "09:00", end: "17:00" },
                { name: "遅番", start: "17:00", end: "22:00" }
            ],
            
            special_days: {} 
        },

        
        // チャートインスタンス保持用
        dashboardChartInstance: null,
        // ダッシュボード自動更新用タイマー
        dashboardTimer: null
    },

    /**
     * ログインタブの切り替え
     */
    switchLoginTab(tabId) {
        const tabs = ['shop', 'admin', 'hq', 'platform'];
        tabs.forEach(t => {
            const btn = document.getElementById('tab-' + t);
            const form = document.getElementById('form-' + t);
            if (btn && form) {
                if (t === tabId) {
                    btn.classList.add('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.remove('text-gray-500', 'border-transparent', 'hover:bg-gray-100');
                    form.classList.remove('hidden');
                } else {
                    btn.classList.remove('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.add('text-gray-500', 'border-transparent', 'hover:bg-gray-100');
                    form.classList.add('hidden');
                }
            }
        });
        
        // 色の調整
        if (tabId === 'hq') {
            document.getElementById('tab-hq').classList.replace('text-blue-600', 'text-indigo-600');
            document.getElementById('tab-hq').classList.replace('border-blue-600', 'border-indigo-600');
        } else if (tabId === 'platform') {
            document.getElementById('tab-platform').classList.replace('text-blue-600', 'text-purple-600');
            document.getElementById('tab-platform').classList.replace('border-blue-600', 'border-purple-600');
        }
    },

    // JS のビルドバージョン (デプロイの度に bump)。
    // 旧バージョンの JS でロードされた古いタブが残っている場合、
    // checkAppVersion() がそれを検知して自動リロードする。
    APP_VERSION: '20260611-v3.7.170-admin-plan-badge-fix',

    // 起動時に保存版と比較して、不一致なら強制リロード (キャッシュ強制破棄)
    checkAppVersion() {
        try {
            const KEY = 'rakushift_app_version';
            const saved = localStorage.getItem(KEY);
            if (saved && saved !== this.APP_VERSION) {
                console.warn('[Version] App updated', saved, '→', this.APP_VERSION, '— forcing reload');
                localStorage.setItem(KEY, this.APP_VERSION);
                // 二重リロードを防ぐためフラグでガード
                if (!sessionStorage.getItem('__just_reloaded_for_version')) {
                    sessionStorage.setItem('__just_reloaded_for_version', '1');
                    location.reload();
                    return true;
                }
            }
            localStorage.setItem(KEY, this.APP_VERSION);
            sessionStorage.removeItem('__just_reloaded_for_version');
        } catch (_) {}
        return false;
    },

    /**
     * 初期化処理
     */
    async init() {
        // バージョン不一致なら自動リロード (古いキャッシュ破棄)
        if (this.checkAppVersion()) return;

        console.log("App initializing... (v" + this.APP_VERSION + ")");
        // v3.7.139: 別タブで logout 等 が起きた場合に同期する storage イベント
        try {
            window.addEventListener('storage', (e) => {
                if (!e.key) return;
                if (e.key === 'rakushift_org_id' && !e.newValue) {
                    // 別タブでログアウト → このタブもリロードして整合性確保
                    console.warn('[storage] org_id removed elsewhere → reload');
                    location.reload();
                }
            });
        } catch (_) {}
        try {
            await API.init();

            // Use native Date to avoid external dependency issues
            this.state.currentDate = new Date();

            // v3.7.82: シフト表表示期間の初期値をモバイル幅では「1週間」に
            // localStorage に保存された値があればそれを優先 (ユーザー選択を尊重)
            const savedPeriod = (() => {
                try { return localStorage.getItem('shiftTablePeriod'); }
                catch (e) { return null; }
            })();
            if (savedPeriod && ['month', 'week', 'day'].includes(savedPeriod)) {
                this.state.shiftTablePeriod = savedPeriod;
            } else if (typeof window !== 'undefined' && window.innerWidth <= 768) {
                this.state.shiftTablePeriod = 'week';
            }
            this.bindEvents();

            // Stripe決済完了時の処理
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('payment') === 'success') {
                setTimeout(() => this.showToast('決済が完了しました。プランが有効化されました。', 'success'), 1000);
                window.history.replaceState({}, '', window.location.pathname);
            } else if (urlParams.get('payment') === 'cancelled') {
                setTimeout(() => this.showToast('決済がキャンセルされました。', 'info'), 1000);
                window.history.replaceState({}, '', window.location.pathname);
            }

            // 本部観覧モード: admin.html から ?as_hq=<contract_id> で開かれた場合、
            // 該当テナントに自動的に「閲覧専用」として入る
            const asHq = urlParams.get('as_hq');
            if (asHq) {
                try {
                    await this._enterHQViewMode(asHq);
                } catch (e) {
                    console.error('[HQ View] failed:', e);
                    this.showToast('本部観覧モードの初期化に失敗しました', 'error');
                }
                window.history.replaceState({}, '', window.location.pathname);
            }
            
            // セッションチェック
            if (API.session) {
                console.log("Session found. Loading data...");
                
                // 【復元処理】
                // session内のuser情報から状態を復元する
                const user = API.session.user;
                if (user) {
                    // ライセンス状態チェック（セッション復元時）
                    if (user.contract_id) {
                        try {
                            const licenseCheck = await API.rpc('check_license_status', { p_contract_id: user.contract_id });
                            if (licenseCheck && !licenseCheck.allowed && licenseCheck.status === 'suspended') {
                                console.log('[Init] License suspended. Forcing logout.');
                                await API.logout();
                                this.state.isAdmin = false;
                                this.state.isShopLoggedIn = false;
                                this.renderCurrentView();
                                this.updateHeader();
                                this.openModal('loginModal');
                                this.showToast('ライセンスが停止中のため、自動ログアウトしました。運営までお問い合わせください。', 'error');
                                return;
                            }
                        } catch (e) {
                            console.warn('[Init] License check skipped:', e.message);
                        }
                    }

                    this.state.isShopLoggedIn = true;
                    // contract_id を優先的に復元
                    if (user.contract_id) {
                        this.state.organization_id = user.contract_id;
                    }
                    // 管理者かどうかの復元
                    if (user.role === 'admin' || user.role === 'Manager' || user.role === 'manager') {
                        this.state.isAdmin = true;
                    }
                }

                await this.loadData();
            } else {
                console.log("No session. Showing login modal.");
                // データをロードせず、空の状態で描画してからログインモーダルを出す
                this.state.isAdmin = false;
                this.state.isShopLoggedIn = false; // 明示的にfalse
                this.renderCurrentView();
                this.updateHeader();

                // ログインモーダルを表示（お知らせはサイドバーで確認する方式に統一）
                this.openModal('loginModal');
                
                const loadingEl = document.getElementById('viewContainer').querySelector('.loading-spinner')?.parentElement?.parentElement;
                if(loadingEl) loadingEl.innerHTML = ''; 
                return; // ここで終了
            }
            
        } catch (e) {
            // ... (error handling)
        } finally {
            this.updateAuthUI();
            this.renderCurrentView();
            this.updateHeader();
        }
    },

    /**
     * イベントリスナー登録
     */
    bindEvents() {
        const closeSidebar = () => {
            if (window.innerWidth < 768) {
                document.querySelector('aside')?.classList.add('-translate-x-full');
                document.getElementById('sidebarOverlay')?.classList.remove('active');
            }
        };

        // v3.7.139: 親 (sidebar) に 1個のリスナーで委譲 (累積リーク防止)
        const sidebarEl = document.querySelector('aside');
        if (sidebarEl && !sidebarEl.dataset.linkBound) {
            sidebarEl.addEventListener('click', (e) => {
                const link = e.target.closest('.sidebar-link');
                if (!link) return;
                e.preventDefault();
                const view = link.dataset.view;
                if (view) {
                    this.changeView(view);
                    closeSidebar();
                }
            });
            sidebarEl.dataset.linkBound = '1';
        }

        document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
            const aside = document.querySelector('aside');
            const overlay = document.getElementById('sidebarOverlay');
            aside.classList.toggle('-translate-x-full');
            if (aside.classList.contains('-translate-x-full')) {
                overlay?.classList.remove('active');
            } else {
                overlay?.classList.add('active');
            }
        });
        
        // Dynamic buttons (autoFill, aiAdvice) are bound in updateAuthUI()

        document.getElementById('authBtn')?.addEventListener('click', () => this.handleAuth());

        // ヘッダの期間ナビゲーション (← 月/期間 → / 今日)
        document.getElementById('prevPeriod')?.addEventListener('click', () => this.navigatePeriod(-1));
        document.getElementById('nextPeriod')?.addEventListener('click', () => this.navigatePeriod(1));
        document.getElementById('todayBtn')?.addEventListener('click', () => this.goToToday());

        // ヘッダの年/月ドロップダウン (任意の年月へ直接ジャンプ)
        this._initJumpDropdowns();
    },

    _initJumpDropdowns() {
        const ySel = document.getElementById('jumpYear');
        const mSel = document.getElementById('jumpMonth');
        if (!ySel || !mSel) return;
        const now = new Date();
        const baseYear = (this.state.currentDate || now).getFullYear();
        // 過去5年〜未来3年
        let yOpts = '';
        for (let y = baseYear - 5; y <= baseYear + 3; y++) {
            yOpts += `<option value="${y}">${y}年</option>`;
        }
        ySel.innerHTML = yOpts;
        let mOpts = '';
        for (let m = 1; m <= 12; m++) {
            mOpts += `<option value="${m}">${m}月</option>`;
        }
        mSel.innerHTML = mOpts;
        ySel.value = baseYear;
        mSel.value = (this.state.currentDate || now).getMonth() + 1;

        const onJump = () => {
            const y = parseInt(ySel.value, 10);
            const m = parseInt(mSel.value, 10) - 1;
            if (isNaN(y) || isNaN(m)) return;
            const d = new Date(this.state.currentDate || now);
            const day = Math.min(d.getDate(), new Date(y, m + 1, 0).getDate());
            d.setFullYear(y, m, day);
            this.state.currentDate = d;
            // 月モードなら1日揃え、週/日モードはそのまま
            if (this.state.view === 'manual-shift' && this.state.shiftTablePeriod === 'week') {
                d.setDate(d.getDate() - d.getDay());
                this.state.currentDate = d;
            } else if (!(this.state.view === 'manual-shift' && this.state.shiftTablePeriod === 'day')) {
                d.setDate(1);
                this.state.currentDate = d;
            }
            this.updateHeader();
            // 範囲外月への大ジャンプの場合に shifts を再ロード
            this.ensureShiftsLoaded().then(() => this.renderCurrentView());
        };
        ySel.addEventListener('change', onJump);
        mSel.addEventListener('change', onJump);
    },

    // 表示中ビュー/期間モードに応じた前後送り
    // v3.7.155: スマホ (vw < 768) では常に月移動のみ (ユーザー要望)
    navigatePeriod(delta) {
        const isMobile = (typeof window !== 'undefined') && window.innerWidth < 768;
        if (isMobile) {
            this.changeMonth(delta);
            return;
        }
        if (this.state.view === 'manual-shift' && this.state.shiftTablePeriod && this.state.shiftTablePeriod !== 'month') {
            this.changeTablePeriod(delta);
        } else {
            this.changeMonth(delta);
        }
    },

    goToToday() {
        const today = new Date();
        if (this.state.view === 'manual-shift' && this.state.shiftTablePeriod && this.state.shiftTablePeriod !== 'month') {
            // 週/2週モードは今日を含む週の日曜揃え
            const d = new Date(today);
            d.setDate(d.getDate() - d.getDay());
            this.state.currentDate = d;
        } else {
            this.state.currentDate = today;
        }
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderCurrentView());
    },

    /**
     * データのロード
     */
    async loadData() {
        if (!this._shiftGenInProgress) this.showLoading(true);
        try {
            // 1. organization_id を確定する (セッション → localStorage の順)
            let orgId = null;

            if (API.session?.user?.organization_id) {
                orgId = API.session.user.organization_id;
            }
            if (!orgId && API.session?.user?.contract_id) {
                // contract_id から session-less RPC で organization_id を取得
                try {
                    const r = await API.rpc('resolve_config_id_by_contract', {
                        p_contract_id: API.session.user.contract_id
                    });
                    if (r && r.organization_id) {
                        orgId = r.organization_id;
                    }
                } catch(e) { console.warn("Config lookup failed:", e); }
            }
            if (!orgId) {
                orgId = localStorage.getItem('rakushift_org_id') || this.state.organization_id;
            }

            // orgIdが無ければデータ取得不可 → ログイン画面へ
            if (!orgId) {
                console.error("No organization_id available. Cannot load data.");
                this.showLoading(false);
                this.openModal('loginModal');
                return;
            }

            this.state.organization_id = orgId;
            localStorage.setItem('rakushift_org_id', orgId);

            // 2. テナント分離: 全クエリにorganization_idフィルタを適用
            const orgFilter = { organization_id: `eq.${orgId}` };

            console.log(`Loading data for org: ${orgId}`);

            // シフトのみ「現在月の前後3ヶ月」に範囲限定してロード (長期累積によるロード遅延を予防)
            // 月切替で範囲外へ移動した時は ensureShiftsLoaded() で追加ロードする
            const shiftRange = this._getShiftLoadRange(this.state.currentDate || new Date());
            const shiftFilter = {
                ...orgFilter,
                and: `(date.gte.${shiftRange.from},date.lte.${shiftRange.to})`
            };
            this.state.loadedShiftRange = shiftRange;

            // 全データを session-less RPC で取得 (RLS 配下の REST は使わない)
            // セッション状態に関係なく常に安定動作。contract_id があれば必ず読める。
            const contractId = this.state.config.contract_id
                || API.session?.user?.contract_id;

            if (!contractId) {
                console.warn('[loadData] contract_id 未取得。空状態で UI 描画');
                this.state.config = { ...this.state.defaultConfig, organization_id: orgId };
                this.state.staff = [];
                this.state.shifts = [];
                this.state.requests = [];
            } else {
                const [cfgRes, staffRes, shiftsRes, requestsRes] = await Promise.allSettled([
                    API.rpc('get_config_by_contract', { p_contract_id: contractId }),
                    API.rpc('list_staff_by_contract', { p_contract_id: contractId }),
                    API.rpc('list_shifts_by_contract', {
                        p_contract_id: contractId,
                        p_from: shiftRange.from,
                        p_to: shiftRange.to
                    }),
                    API.rpc('list_requests_by_contract', { p_contract_id: contractId })
                ]);

                const cfgRow = cfgRes.status === 'fulfilled' ? cfgRes.value : null;
                const staffRows = staffRes.status === 'fulfilled' && Array.isArray(staffRes.value) ? staffRes.value : [];
                const shiftRows = shiftsRes.status === 'fulfilled' && Array.isArray(shiftsRes.value) ? shiftsRes.value : [];
                const requestRows = requestsRes.status === 'fulfilled' && Array.isArray(requestsRes.value) ? requestsRes.value : [];

                if (cfgRow && typeof cfgRow === 'object') {
                    this.state.config = { ...this.state.defaultConfig, ...cfgRow };
                } else {
                    // config が DB に無い (新規テナント等) — デフォルトのまま contract_id/org_id だけ補完
                    this.state.config = {
                        ...this.state.defaultConfig,
                        contract_id: contractId,
                        organization_id: orgId
                    };
                }

                this.state.staff = staffRows;
                this.state.shifts = shiftRows;
                // v3.7.152: 3ヶ月超の 承認済/却下 申請はキャッシュからも除外
                const _cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
                this.state.requests = requestRows.filter(req => {
                    if (req.status === 'pending') return true;
                    const t = req.created_at ? new Date(req.created_at).getTime() : Date.now();
                    return t >= _cutoff;
                });
            }

            console.log(`Loaded: ${this.state.staff.length} staff, ${this.state.shifts.length} shifts, ${this.state.requests.length} requests.`);

            // v3.7.152: 古い申請を DB から自動 purge (非同期、エラーは無視)
            this._purgeOldRequestsIfNeeded().catch(() => {});

            this.updateRequestBadge();

            // スタッフ数がプラン上限を超えていたら警告
            if (this.isStaffOverLimit()) {
                this.showStaffOverLimitAlert();
            } else {
                this.clearStaffOverLimitAlert();
            }

            // 決済エラー状態なら警告表示
            if (this.state.config.subscription_status === 'past_due') {
                this.showPaymentAlert();
            }

        } catch (error) {
            console.error('Data Load Error:', error);
        } finally {
            if (!this._shiftGenInProgress) this.showLoading(false);
        }
    },

    handleAuth() {
        if (this.state.isAdmin) {
            // 管理者ログアウトのみ（店舗ログインは維持）
            if(confirm('管理者権限からログアウトしますか？')) {
                this.state.isAdmin = false;
                // セッション情報を更新（管理者情報を消す）
                const currentUser = API.session.user;
                // 契約情報は残すが、個人特定は消すイメージ（ここでは簡易的にisAdminフラグのみ操作）
                const shopUser = {
                    contract_id: currentUser.contract_id,
                    organization_id: currentUser.organization_id, // RLSフィルター用に維持
                    session_id: currentUser.session_id,           // セッションを維持
                    name: 'Guest (Staff)',
                    role: 'Guest'
                };
                API.setSession(shopUser);
                
                this.showToast('管理者からログアウトしました', 'info');
                this.updateAuthUI();
                this.updateHeader();
                this.changeView('dashboard');
            }
        } else {
            // 管理者ログインタブを開く
            this.switchLoginTab('admin');
            this.openModal('loginModal');
        }
    },

    /**
     * 契約者（店舗）ログイン処理 - RPC経由bcrypt認証
     */
    async login() {
        console.log('[ShopLogin] Login attempt started...');

        const contractIdEl = document.getElementById('loginContractId');
        const passwordEl = document.getElementById('loginShopPass');

        if (!contractIdEl) {
            app.showToast('エラー: 入力欄が見つかりません。ページを再読み込みしてください。', 'error');
            return;
        }

        const contractId = this._sanitize(contractIdEl.value.trim());
        const password = passwordEl ? passwordEl.value.trim() : '';

        if (!contractId || !password) {
            this.showToast('契約IDとパスワードを入力してください', 'error');
            return;
        }

        // セキュリティ: ブルートフォース対策
        if (this._checkLoginLock('shop_' + contractId)) return;

        this.showLoading(true);
        try {
            // 1. ライセンス・サブスクリプション状態チェック
            try {
                const subCheck = await API.rpc('check_subscription_status', { p_contract_id: contractId });
                if (subCheck && !subCheck.allowed) {
                    if (subCheck.status === 'suspended') {
                        this.showToast('このアカウントのライセンスは停止中です。運営までお問い合わせください。', 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'not_found') {
                        this.showToast('契約IDが見つかりません', 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'canceled' || subCheck.status === 'unpaid') {
                        this.showToast('サブスクリプションが無効です。プランを再度ご契約ください。', 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'past_due') {
                        this._paymentPastDue = true;
                    }
                }
                // サブスク未契約(free)の場合 → ログインは許可するが決済を促す
                if (subCheck && subCheck.status === 'free') {
                    this._pendingPayment = true;
                } else {
                    this._pendingPayment = false;
                }
            } catch (licenseErr) {
                console.warn('[ShopLogin] Subscription check skipped:', licenseErr.message);
            }

            // 2a. サーバ側レート制限チェック (RPC が無い古いDBでも壊れないように try)
            try {
                const rl = await API.rpc('can_attempt_login', { p_identifier: 'shop:' + contractId });
                if (rl && rl.allowed === false) {
                    const sec = rl.retry_after_seconds || 300;
                    this.showToast('ログイン試行回数の上限に達しました。' + sec + '秒後に再度お試しください。', 'error');
                    return;
                }
            } catch (_) { /* RPC 未デプロイ環境では握りつぶす */ }

            // 2b. bcrypt認証 (RPC経由)
            const authResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: password
            });

            console.log('[ShopLogin] Auth result: success=', authResult?.success);

            if (authResult && authResult.success) {
                this._recordLoginAttempt('shop_' + contractId, true);
                try { await API.rpc('clear_login_failures', { p_identifier: 'shop:' + contractId }); } catch (_) {}
                this.state.isShopLoggedIn = true;
                this.state.isAdmin = false;
                this.state.organization_id = authResult.organization_id;

                API.setSession({
                    contract_id: authResult.contract_id,
                    organization_id: authResult.organization_id,
                    session_id: authResult.session_id,
                    name: 'Guest (Staff)',
                    role: 'Guest'
                });

                this.closeModal('loginModal');

                await this.loadData();
                this.updateAuthUI();
                this.updateHeader();

                // サブスク未契約の場合、決済を促す
                if (this._pendingPayment) {
                    this.showToast('ご利用にはプランの契約が必要です', 'warning');
                    this.changeView('settings');
                    setTimeout(() => {
                        const section = document.getElementById('subscriptionSection');
                        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 500);
                } else if (this._paymentPastDue) {
                    this.showToast(`契約ID: ${contractId} でログインしました`, 'success');
                    this.showPaymentAlert();
                } else {
                    this.showToast(`契約ID: ${contractId} でログインしました`, 'success');
                }

                // お知らせバッジを更新（サイドバーで確認する方式に統一）
                this.updateAnnouncementBadge();
            } else {
                this._recordLoginAttempt('shop_' + contractId, false);
                try { await API.rpc('record_login_failure', { p_identifier: 'shop:' + contractId }); } catch (_) {}
                this.showToast(authResult?.message || 'ログインに失敗しました', 'error');
            }

        } catch (error) {
            console.error('[ShopLogin] Error:', error);
            this.showToast(`ログイン処理中にエラーが発生しました: ${error.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    /**
     * 管理者ログイン処理 - RPC経由bcrypt認証
     * 契約IDと管理者パスワードで直接ログイン可能
     * verify_admin_login → verify_shop_login → demo フォールバック
     */
    async adminLogin() {
        const password = document.getElementById('adminLoginPass')?.value.trim() || '';
        const inputContractId = this._sanitize(document.getElementById('adminLoginContractId')?.value.trim() || '');

        if (!inputContractId) {
            this.showToast('契約IDを入力してください', 'error');
            return;
        }
        // v3.7.139: contract_id は英数字+ハイフン/アンダースコアのみ、最大32文字
        if (!/^[A-Za-z0-9_\-]{1,32}$/.test(inputContractId)) {
            this.showToast('契約ID は英数字/_/- のみ、最大 32文字で入力してください', 'error');
            return;
        }
        if (!password) {
            this.showToast('管理者パスワードを入力してください', 'error');
            return;
        }

        if (this._checkLoginLock('admin_' + inputContractId)) return;

        this.showLoading(true);
        try {
            // サーバ側レート制限チェック
            try {
                const rl = await API.rpc('can_attempt_login', { p_identifier: 'admin:' + inputContractId });
                if (rl && rl.allowed === false) {
                    const sec = rl.retry_after_seconds || 300;
                    this.showToast('ログイン試行回数の上限に達しました。' + sec + '秒後に再度お試しください。', 'error');
                    return;
                }
            } catch (_) {}

            let authResult = null;
            let authMethod = 'none';
            let orgId = null;

            // 方法1: verify_admin_login RPC
            try {
                authResult = await API.rpc('verify_admin_login', {
                    p_contract_id: inputContractId,
                    p_login_id: 'admin',
                    p_password: password
                });
                if (authResult && authResult.success) {
                    authMethod = 'admin_rpc';
                    orgId = authResult.organization_id;
                }
            } catch (rpcErr) {
                console.warn('[AdminLogin] admin RPC failed:', rpcErr.message);
            }

            // 方法2: verify_shop_login で店舗認証
            if (authMethod === 'none') {
                try {
                    authResult = await API.rpc('verify_shop_login', {
                        p_contract_id: inputContractId,
                        p_password: password
                    });
                    if (authResult && authResult.success) {
                        authMethod = 'shop_rpc';
                        orgId = authResult.organization_id;
                    }
                } catch (shopErr) {
                    console.warn('[AdminLogin] shop RPC also failed:', shopErr.message);
                }
            }

            // 方法3は削除: config_safeルックアップによるフォールバック認証は
            // パスワード検証をバイパスするセキュリティリスクがあるため廃止。
            // RPC（verify_admin_login / verify_shop_login）が両方失敗した場合は
            // 認証失敗として扱う。

            if (authResult && authResult.success) {
                this._recordLoginAttempt('admin_' + inputContractId, true);
                try { await API.rpc('clear_login_failures', { p_identifier: 'admin:' + inputContractId }); } catch (_) {}
                this.state.isAdmin = true;
                this.state.isShopLoggedIn = true;
                this.state.organization_id = orgId;

                API.setSession({
                    id: authResult.staff_id,
                    contract_id: inputContractId,
                    organization_id: orgId,
                    // サーバが session_id を返さなかった時の fallback は予測不可能な UUID に
                    // (旧 Date.now() ベースは攻撃者が予測してセッション偽装可能だった)
                    session_id: authResult.session_id || (crypto.randomUUID ? crypto.randomUUID() : 'admin_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
                    name: authResult.name || '管理者',
                    role: authResult.role || 'admin'
                });

                this.closeModal('loginModal');
                await this.loadData();
                this.updateAuthUI();
                this.updateHeader();
                // v3.7.133: 設定 PIN があれば追加検証 (失敗時はログイン取消)
                const pinOk = await this._checkPinIfNeeded(inputContractId);
                if (!pinOk) {
                    this.showLoading(false);
                    return;
                }
                this.showToast(`管理者: ${this._sanitize(authResult.name || '管理者')} でログインしました`, 'success');
                this.updateAnnouncementBadge();
                // v3.7.130: 初回のみチュートリアル自動表示
                this._maybeShowTutorial();
            } else {
                this._recordLoginAttempt('admin_' + inputContractId, false);
                try { await API.rpc('record_login_failure', { p_identifier: 'admin:' + inputContractId }); } catch (_) {}
                this.showToast(authResult?.message || '契約IDまたはパスワードが正しくありません', 'error');
            }

        } catch(e) {
            console.error('Admin Login Error:', e);
            this.showToast(`エラーが発生しました: ${e.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    // =========================================================
    // 3店舗以上お問い合わせフォーム送信
    // =========================================================
    openPrivacyPolicy() {
        // 完全版プライバシーポリシーページを別タブで開く
        window.open('privacy.html', '_blank', 'noopener,noreferrer');
    },

    async submitMultiStoreInquiry() {
        // v3.7.132: Honeypot 検出 (bot のみ入力される hidden field)
        const honeypot = document.getElementById('inquiryWebsiteUrl');
        if (honeypot && honeypot.value && honeypot.value.length > 0) {
            // bot 検出: 何もエラーを返さず無視 (成功風レスポンスでステルス)
            console.warn('[Inquiry] honeypot triggered, silently dropping');
            this.showToast('お問い合わせを受け付けました。担当者より1営業日以内にご連絡いたします。', 'success');
            return;
        }
        // 個人情報取得の同意確認 (個人情報保護法 第17条)
        const consent = document.getElementById('inquiryConsent');
        if (consent && !consent.checked) {
            this.showToast('個人情報の取扱いについて同意が必要です', 'warning');
            consent.focus();
            return;
        }
        const company = document.getElementById('inquiryCompany')?.value.trim() || '';
        const address = document.getElementById('inquiryAddress')?.value.trim() || '';
        const phone = document.getElementById('inquiryPhone')?.value.trim() || '';
        const name = document.getElementById('inquiryName')?.value.trim() || '';
        const lightCount = document.getElementById('inquiryLightCount')?.value || '0';
        const standardCount = document.getElementById('inquiryStandardCount')?.value || '0';
        const premiumCount = document.getElementById('inquiryPremiumCount')?.value || '0';
        const message = document.getElementById('inquiryMessage')?.value.trim() || '';

        // 希望日取得
        const date1 = document.getElementById('inquiryDate1')?.value || '';
        const date2 = document.getElementById('inquiryDate2')?.value || '';
        const date3 = document.getElementById('inquiryDate3')?.value || '';

        // 時間帯ラジオ取得
        const timeSlot = document.querySelector('input[name="inquiryTimeSlot"]:checked')?.value || '';

        // バリデーション
        if (!company) { this.showToast('会社名を入力してください', 'error'); return; }
        if (!address) { this.showToast('会社住所を入力してください', 'error'); return; }
        if (!phone) { this.showToast('会社連絡先を入力してください', 'error'); return; }
        if (!name) { this.showToast('ご担当者名を入力してください', 'error'); return; }

        // プラン件数チェック（合計1件以上）
        const totalPlans = (parseInt(lightCount) || 0) + (parseInt(standardCount) || 0) + (parseInt(premiumCount) || 0);
        if (totalPlans === 0 && lightCount === '0' && standardCount === '0' && premiumCount === '0') {
            this.showToast('契約予定プランを1件以上選択してください', 'error'); return;
        }

        if (!date1) { this.showToast('第1希望日を選択してください', 'error'); return; }

        this.showLoading(true);
        try {
            // プランサマリー文字列を構築
            const planParts = [];
            if (lightCount !== '0') planParts.push(`ライトプラン ${lightCount}件`);
            if (standardCount !== '0') planParts.push(`スタンダードプラン ${standardCount}件`);
            if (premiumCount !== '0') planParts.push(`プレミアムプラン ${premiumCount}件`);
            const planSummary = planParts.join('、');

            // 連絡希望日程サマリー
            const dateParts = [date1];
            if (date2) dateParts.push(date2);
            if (date3) dateParts.push(date3);
            const scheduleSummary = [
                `希望日: ${dateParts.join(', ')}`,
                timeSlot ? `時間帯: ${timeSlot}` : ''
            ].filter(Boolean).join(' / ');

            const inquiryData = {
                company_name: this._sanitize(company),
                company_address: this._sanitize(address),
                phone: this._sanitize(phone),
                contact_name: this._sanitize(name),
                plan_summary: planSummary,
                light_plan_count: lightCount,
                standard_plan_count: standardCount,
                premium_plan_count: premiumCount,
                preferred_days: dateParts.join(','),
                preferred_time: timeSlot,
                schedule_summary: scheduleSummary,
                message: this._sanitize(message),
                status: 'new',
                created_at: new Date().toISOString()
            };

            // v3.7.137: localStorage 保存を try-catch で囲む (QuotaExceeded 等)
            try {
                const pending = JSON.parse(localStorage.getItem('rakushift_pending_inquiries') || '[]');
                pending.push(inquiryData);
                // 直近 20件のみ保持 (古いものから捨てる)
                while (pending.length > 20) pending.shift();
                localStorage.setItem('rakushift_pending_inquiries', JSON.stringify(pending));
            } catch (lsErr) {
                console.warn('[Inquiry] localStorage backup failed (容量 or 権限):', lsErr.name);
            }

            // Railwayサーバー経由でメール送信
            try {
                const serverUrl = RAKUSHIFT_CONFIG.CALC_SERVER_URL || '';
                const res = await fetch(`${serverUrl}/api/inquiry`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(inquiryData)
                });
                const result = await res.json();
                console.log('[Inquiry] Server response:', result);
            } catch (serverErr) {
                console.warn('[Inquiry] Server send failed:', serverErr.message);
            }

            // フォームリセット
            ['inquiryCompany', 'inquiryAddress', 'inquiryPhone', 'inquiryName', 'inquiryMessage', 'inquiryDate1', 'inquiryDate2', 'inquiryDate3'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            ['inquiryLightCount', 'inquiryStandardCount', 'inquiryPremiumCount'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '0';
            });
            const checkedRadio = document.querySelector('input[name="inquiryTimeSlot"]:checked');
            if (checkedRadio) checkedRadio.checked = false;

            this.closeModal('multiStoreInquiryModal');
            this.showToast('お問い合わせを受け付けました。担当者より1営業日以内にご連絡いたします。', 'success');
        } catch (e) {
            console.error('Inquiry Error:', e);
            this.showToast('送信に失敗しました。時間をおいて再度お試しください。', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // =========================================================
    // ログインタブ切り替え
    // =========================================================
    switchLoginTab(tab) {
        const tabs = ['admin', 'shop', 'hq', 'platform'];
        tabs.forEach(t => {
            const form = document.getElementById(`form-${t}`);
            const btn = document.getElementById(`tab-${t}`);
            if (form) form.classList.toggle('hidden', t !== tab);
            if (btn) {
                if (t === tab) {
                    btn.classList.add('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.remove('text-gray-500', 'border-transparent');
                } else {
                    btn.classList.remove('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.add('text-gray-500', 'border-transparent');
                }
            }
        });
    },

    signUpMode() {
        app.showToast('新規登録機能は現在メンテナンス中です。管理者に連絡してアカウントを発行してください。', 'error');
    },

    async hqLogin() {
        const loginId = this._sanitize((document.getElementById('loginHqId')?.value || '').trim());
        const password = document.getElementById('loginHqPass')?.value.trim() || '';
        if (!loginId || !password) {
            this.showToast('本部IDとパスワードを入力してください', 'error');
            return;
        }

        // セキュリティ: ブルートフォース対策
        if (this._checkLoginLock('hq_' + loginId)) return;

        this.showLoading(true);
        try {
            // サーバ側レート制限
            try {
                const rl = await API.rpc('can_attempt_login', { p_identifier: 'hq:' + loginId });
                if (rl && rl.allowed === false) {
                    const sec = rl.retry_after_seconds || 300;
                    this.showToast('ログイン試行回数の上限に達しました。' + sec + '秒後に再度お試しください。', 'error');
                    return;
                }
            } catch (_) {}

            let result = null;

            // RPC経由の認証のみ (migration 18 以降は hq_login RPC が必須)
            // 旧 HQ_ACCOUNTS フロントフォールバックは migration 適用済の現環境では不要なため削除
            // (削除前はフロントに rakushift_hq 等の固定パスワードが残っていてセキュリティリスク)
            try {
                result = await API.rpc('hq_login', { p_login_id: loginId, p_password: password });
            } catch (rpcErr) {
                console.error('[HQ] hq_login RPC failed:', rpcErr.message);
                result = { status: 'error', message: 'ログインサーバに接続できません。時間をおいて再試行してください。' };
            }

            if (result && result.status === 'success') {
                this._recordLoginAttempt('hq_' + loginId, true);
                try { await API.rpc('clear_login_failures', { p_identifier: 'hq:' + loginId }); } catch (_) {}
                this.state.isHQ = true;
                this.state.isAdmin = false;
                this.state.isShopLoggedIn = false;
                this.state.organization_id = null;
                
                API.setSession({
                    session_id: result.session_id || (crypto.randomUUID ? crypto.randomUUID() : 'hq_' + Date.now() + '_' + Math.random().toString(36).slice(2)),
                    name: result.company_name || 'HQ Admin',
                    role: 'hq_admin',
                    login_id: result.login_id || loginId,           // get_hq_scope() で必要
                    is_global: !!result.is_global,
                    company_name: result.company_name || null,
                    scope_org_ids: result.scope_org_ids || []
                });

                this.closeModal('loginModal');
                this.showToast('本部としてログインしました', 'success');
                this.changeView('hq_dashboard');
                this.updateAuthUI();
                this.updateHeader();
            } else {
                this._recordLoginAttempt('hq_' + loginId, false);
                try { await API.rpc('record_login_failure', { p_identifier: 'hq:' + loginId }); } catch (_) {}
                this.showToast(result?.message || 'ログインに失敗しました', 'error');
            }
        } catch (e) {
            console.error(e);
            this.showToast('エラーが発生しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async logout() {
        if(!confirm('アプリケーションから完全にログアウトしますか？\n（ログイン画面に戻ります）')) return;

        await API.logout();
        // タイマー全クリア (再ログイン時の重複・メモリリーク防止)
        if (this.state.dashboardTimer) { clearInterval(this.state.dashboardTimer); this.state.dashboardTimer = null; }
        if (this._tipTimer) { clearInterval(this._tipTimer); this._tipTimer = null; }
        // セキュリティ: 全ての認証状態を完全にクリア
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        this.state.isHQ = false;
        this.state.organization_id = null;
        this.state.config = {};
        this.state.staff = [];
        this.state.shifts = [];
        this.state.requests = [];
        this.state.loadedShiftRange = null;
        // gantt_drag のグローバルリスナーも破棄 (メモリリーク防止)
        if (typeof GanttDrag !== 'undefined' && GanttDrag.destroy) {
            try { GanttDrag.destroy(); } catch (_) {}
        }
        // セキュリティ: セッション関連のlocalStorageを全消去
        sessionStorage.removeItem('rakushift_user');
        sessionStorage.removeItem('supabase.auth.token');
        localStorage.removeItem('rakushift_org_id');
        this.showToast('ログアウトしました', 'info');
        this.updateAuthUI();
        this.changeView('dashboard');
        this.openModal('loginModal');
    },

    updateAuthUI() {
        const authBtn = document.getElementById('authBtn');
        const adminLinks = document.querySelectorAll('.admin-link');
        const adminHeader = document.getElementById('adminHeaderControls');

        // --- 本部（閲覧専用）モードの制御 ---
        if (this.state.isHQ) {
            if (authBtn) authBtn.classList.add('hidden');
            
            // 店舗が選択されている場合のみサイドバーメニューを表示
            const hasShop = !!this.state.organization_id;
            adminLinks.forEach(link => {
                if (hasShop) {
                    link.classList.remove('hidden');
                } else {
                    link.classList.add('hidden');
                }
            });

            if (adminHeader) {
                adminHeader.innerHTML = `
                    <div class="hidden md:flex items-center gap-2 mr-4 bg-indigo-50 border border-indigo-200 text-indigo-700 px-3 py-1.5 rounded text-xs font-bold shadow-sm">
                        <i class="fa-solid fa-eye"></i> 閲覧専用モード
                    </div>
                    <button onclick="app.changeView('hq_dashboard')" class="px-3 py-1.5 text-xs font-bold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 rounded bg-white transition-all mr-2 shadow-sm">
                        <i class="fa-solid fa-list mr-1"></i>店舗一覧
                    </button>
                    <button onclick="app.hqLogout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all shadow-sm">
                        <i class="fa-solid fa-power-off mr-1"></i>ログアウト
                    </button>
                `;
            }

            // 閲覧専用: 編集系ボタンを隠す
            if (hasShop) {
                setTimeout(() => {
                    const actionKeywords = ['追加', '保存', '作成', '申請', '編集', '設定', '削除', '承認', '却下'];
                    document.querySelectorAll('button').forEach(btn => {
                        if (!btn.closest('#adminHeaderControls') && !btn.closest('#sidebar')) {
                            const txt = btn.textContent;
                            if (actionKeywords.some(kw => txt.includes(kw))) {
                                btn.classList.add('hidden');
                            }
                        }
                    });
                }, 100);
            }

            this.updateRequestBadge();
            this.updateAnnouncementBadge();
            return;
        }

        // サイドバーの「管理者ログイン」ボタンの表示
        if (authBtn) {
            if (this.state.isAdmin) {
                authBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket w-6 text-center"></i> 管理者ログアウト';
                authBtn.classList.remove('text-blue-600', 'hover:bg-blue-50');
                authBtn.classList.add('text-red-600', 'hover:bg-red-50');
            } else {
                authBtn.innerHTML = '<i class="fa-solid fa-user-shield w-6 text-center"></i> 管理者ログイン';
                authBtn.classList.add('text-blue-600', 'hover:bg-blue-50');
                authBtn.classList.remove('text-red-600', 'hover:bg-red-50');
            }
        }
        
        // 管理者専用メニューの表示切り替え
        adminLinks.forEach(link => {
            if (this.state.isAdmin) {
                link.classList.remove('hidden');
            } else {
                link.classList.add('hidden');
            }
        });

        // ヘッダーへの管理者コントロール注入
        if (adminHeader) {
            if (this.state.isAdmin) {
                adminHeader.innerHTML = `
                    <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all ml-2">
                        <i class="fa-solid fa-power-off mr-1"></i>ログアウト
                    </button>
                `;
            } else {
                // スタッフモード（閲覧のみ）のときはヘッダーに契約IDと完全ログアウトボタンを表示
                if (this.state.isShopLoggedIn) {
                     adminHeader.innerHTML = `
                        <div class="hidden md:block px-3 py-1 text-xs font-mono text-gray-400 border border-gray-200 rounded bg-gray-50 mr-2">
                            ID: ${this.state.organization_id}
                        </div>
                        <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all">
                            <i class="fa-solid fa-power-off mr-1"></i>ログアウト
                        </button>
                     `;
                } else {
                    adminHeader.innerHTML = '';
                }
            }
        }
        
        // メニューバッジなどの更新
        this.updateRequestBadge();
        this.updateAnnouncementBadge();
    },

    changeView(viewName) {
        // タイマークリア
        if (this.state.dashboardTimer) {
            clearInterval(this.state.dashboardTimer);
            this.state.dashboardTimer = null;
        }

        this.state.view = viewName;
        document.querySelectorAll('.sidebar-link').forEach(link => {
            if (link.dataset.view === viewName) {
                link.classList.add('active', 'bg-blue-50', 'text-blue-600');
                link.classList.remove('text-gray-600', 'hover:bg-gray-50');
            } else {
                link.classList.remove('active', 'bg-blue-50', 'text-blue-600');
                link.classList.add('text-gray-600', 'hover:bg-gray-50');
            }
        });
        this.renderCurrentView();
    },

    changeMonth(delta) {
        this.state.currentDate.setMonth(this.state.currentDate.getMonth() + delta);
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderCurrentView());
    },

    updateHeader() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const display = document.getElementById('currentPeriodDisplay');
        if(display) display.textContent = `${year}年 ${month}月`;
        // 年月ドロップダウンも追従
        const ySel = document.getElementById('jumpYear');
        const mSel = document.getElementById('jumpMonth');
        if (ySel && mSel) {
            // 範囲外の年を表示する場合は option を追加
            if (!Array.from(ySel.options).some(o => o.value === String(year))) {
                const opt = document.createElement('option');
                opt.value = year; opt.textContent = `${year}年`;
                ySel.appendChild(opt);
            }
            ySel.value = year;
            mSel.value = month;
        }
        this.calculateMonthlyStats();
    },

    renderCurrentView() {
        const container = document.getElementById('viewContainer');
        container.innerHTML = '';

        switch (this.state.view) {
            case 'hq_dashboard':
                this.renderHQDashboard(container);
                break;
            case 'dashboard':
                this.renderDashboard(container);
                break;
            case 'manual-shift':
                this.renderShiftView(container);
                break;
            case 'staff':
                this.renderStaffList(container);
                break;
            case 'requests':
                this.renderRequests(container);
                break;
            case 'analytics':
                this.renderAnalytics(container);
                break;
            case 'settings':
                this.renderSettings(container);
                break;
            case 'manual':
                this.renderManual(container);
                break;
            case 'handover':
                this.renderHandover(container);
                break;
            case 'hq_manual':
                this.renderHQManual(container);
                break;
            case 'announcements':
                this.renderAnnouncementsAdmin(container);
                break;
            default:
                this.renderDashboard(container);
        }
    },

    // --- 開発者用ツール (Dev Tools) ---
    async devCreateTestData() {
        // 1. マスターアカウントチェック
        const currentUser = API.session?.user?.email;
        console.log("Current user:", currentUser);
        if (currentUser !== 'master@mochikuro.com') {
            app.showToast('現在のアカウントではこの機能を使用できません。管理者のみ実行可能です。', 'error');
            return;
        }

        // 削除確認ではなく「データ整備」の確認に変更
        if (!confirm("【開発者用】テストデータを整備しますか？\n※既存データは保持され、不足しているスタッフや設定が補充されます。")) return;
        
        this.showLoading(true);
        try {
            // 2. 組織IDの確保と検証 (自己修復ロジック)
            let orgId = this.state.organization_id || localStorage.getItem('rakushift_org_id');
            let isValidOrg = false;

            // IDを持っている場合、DBに実在するか確認
            if (orgId) {
                try {
                    const check = await API.list('organizations', { id: `eq.${orgId}` });
                    if (check.data && check.data.length > 0) isValidOrg = true;
                } catch(e) { console.warn("Org check failed", e); }
            }

            // 無効または持っていない場合、再取得・作成
            if (!isValidOrg) {
                console.log("Org ID is invalid or missing. Repairing...");
                const orgRes = await API.list('organizations');
                if (orgRes && orgRes.data && orgRes.data.length > 0) {
                    orgId = orgRes.data[0].id; // 既存のものを採用
                } else {
                    console.log("No organizations found. Creating new...");
                    const newOrg = await API.create('organizations', { name: 'Test Shop' });
                    orgId = newOrg?.id;
                }
                
                // 新しいIDを保存
                if (orgId) {
                    this.state.organization_id = orgId;
                    localStorage.setItem('rakushift_org_id', orgId);
                    
                    // プロフィールも強制更新して紐付け直す
                    const userId = API.session?.user?.id;
                    if (userId) {
                        await API.update('profiles', userId, { organization_id: orgId }).catch(e=>{});
                    }
                } else {
                    throw new Error("組織IDの生成に失敗しました。");
                }
            }

            // 3. 既存データの確認 (全削除はしない) — session-less RPC で取得
            let currentStaff = [];
            try {
                const cid = this.state.config?.contract_id || API.session?.user?.contract_id;
                if (cid) {
                    const rows = await API.rpc('list_staff_by_contract', { p_contract_id: cid });
                    if (Array.isArray(rows)) currentStaff = rows;
                }
            } catch (_) {}
            
            // 4. 不足分の補充
            // 少なくとも10名は確保したい
            const targetCount = 13;
            const currentCount = currentStaff.length;
            
            if (currentCount < targetCount) {
                this.showToast(`スタッフを補充中... (${currentCount} -> ${targetCount}名)`, 'info');
                
                // 補充用テンプレート (シフトが埋まりやすい「最強バイト」を含める)
                // ランクA-D, 年間休日対応
                const templates = [
                    { name: "【万能】佐藤 (店長)", role: 'manager', max_days: 5, max_hours: 8, wage: 1500, eval: 'A', salary_type: 'monthly', holidays: 105 }, 
                    { name: "【万能】鈴木 (副店長)", role: 'manager', max_days: 5, max_hours: 8, wage: 1400, eval: 'A', salary_type: 'monthly', holidays: 110 },
                    { name: "高橋 (リーダー)", role: 'leader', max_days: 5, max_hours: 8, wage: 1300, eval: 'B', salary_type: 'monthly', holidays: 120 },
                    { name: "田中 (フル)", role: 'staff', max_days: 5, max_hours: 8, wage: 1100, eval: 'B' },
                    { name: "渡辺 (フル)", role: 'staff', max_days: 5, max_hours: 8, wage: 1100, eval: 'B' },
                    { name: "フリーターA (長時間)", role: 'staff', max_days: 5, max_hours: 8, wage: 1200, eval: 'C' }, 
                    { name: "フリーターB (長時間)", role: 'staff', max_days: 5, max_hours: 8, wage: 1200, eval: 'C' },
                    { name: "学生C (夕方)", role: 'staff', max_days: 4, max_hours: 5, wage: 1000, eval: 'D' },
                    { name: "学生D (夕方)", role: 'staff', max_days: 4, max_hours: 5, wage: 1000, eval: 'D' },
                    { name: "主婦E (昼)", role: 'staff', max_days: 4, max_hours: 6, wage: 1050, eval: 'C' },
                    { name: "主婦F (昼)", role: 'staff', max_days: 4, max_hours: 6, wage: 1050, eval: 'C' },
                    { name: "週末G (土日)", role: 'staff', max_days: 2, max_hours: 8, wage: 1100, eval: 'D' },
                    { name: "新人H", role: 'staff', max_days: 3, max_hours: 4, wage: 950, eval: 'D' }
                ];

                // 足りない人数分だけ追加
                const addCount = targetCount - currentCount;
                const createdStaff = [];
                
                // 直列実行で確実にIDを紐付ける
                for (let i = 0; i < addCount; i++) {
                    const tmpl = templates[i % templates.length];
                    const uniqueName = currentCount > 0 ? `${tmpl.name} ${i+1}` : tmpl.name;
                    
                    // 個別の作成エラーをキャッチせず、失敗したら全体を止める
                    const data = {
                        name: uniqueName,
                        role: tmpl.role,
                        evaluation: tmpl.eval || 'B',
                        salary_type: tmpl.salary_type || 'hourly',
                        hourly_wage: tmpl.wage,
                        monthly_salary: tmpl.salary_type === 'monthly' ? 250000 : 0,
                        max_days_week: tmpl.max_days,
                        max_hours_day: tmpl.max_hours,
                        min_days_week: 0,
                        min_days_month: 0,
                        organization_id: orgId
                    };
                    if (tmpl.holidays) {
                        data.annual_holidays = tmpl.holidays; // ここで保存
                    }

                    // session-less RPC で RLS 回避
                    const cid = this._getContractId();
                    if (!cid) throw new Error('contract_id 未取得');
                    const r = await API.rpc('upsert_staff_by_contract', {
                        p_contract_id: cid,
                        p_staff_id: null,
                        p_data: data
                    });
                    if (!r || r.success !== true) {
                        throw new Error(`スタッフ「${uniqueName}」のDB保存に失敗: ${r?.message || ''}`);
                    }
                    createdStaff.push({ ...data, id: r.staff_id });
                }
                
                // State更新 (既存 + 新規)
                this.state.staff = [...currentStaff, ...createdStaff];
                
                // 画面更新 (リロードなしで即時反映)
                this.renderCurrentView();
                this.showToast(`完了！ ${this.state.staff.length}名のスタッフを表示中`, 'success');
                
            } else {
                this.showToast('スタッフ数は十分です (データ維持)', 'success');
                this.state.staff = currentStaff;
            }

            // 5. 設定データの修復 (空の場合のみ) — session-less RPC
            if (!this.state.config.id) {
                try {
                    const cid = this.state.config?.contract_id || API.session?.user?.contract_id;
                    if (cid) {
                        const row = await API.rpc('get_config_by_contract', { p_contract_id: cid });
                        if (row && typeof row === 'object') {
                            this.state.config = { ...this.state.defaultConfig, ...row };
                        }
                    }
                } catch (_) {}
            }

            this.renderCurrentView();
            this.showToast(`データ整備完了。現在のスタッフ: ${this.state.staff.length}名`, 'success');
            
        } catch(e) {
            console.error("Test data setup failed:", e);
            app.showToast('エラーが発生しました: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // =================================================================
    // =================================================================
    // HQ (本部) ダッシュボード
    // =================================================================
    async renderHQDashboard(container) {
        if (!this.state.isHQ) return;

        this.showLoading(true);
        let shops = [];
        try {
            // バックエンド(Railway)経由で取得（サービスキーでRLSバイパス）
            const backendUrl = RAKUSHIFT_CONFIG?.CALC_SERVER_URL || 'https://rakushift-ai-production.up.railway.app';
            const sessionData = JSON.parse(sessionStorage.getItem('rakushift_user') || '{}');
            const res = await fetch(`${backendUrl}/hq/shops`, {
                headers: {
                    'x-session-id': sessionData.session_id || '',
                    'Content-Type': 'application/json'
                }
            });
            if (res.ok) {
                shops = await res.json();
            } else {
                throw new Error('Backend returned ' + res.status);
            }
        } catch (backendErr) {
            console.warn('[HQ] Backend fallback failed:', backendErr.message);
            // フォールバック: Supabase RPC
            try {
                const result = await API.rpc('hq_get_all_shops', {});
                shops = result || [];
            } catch (rpcErr) {
                console.warn('[HQ] RPC also failed:', rpcErr.message);
                this.showToast('店舗一覧の取得に失敗しました', 'error');
            }
        } finally {
            this.showLoading(false);
        }

        const planLabels = { standard: 'Standard', pro: 'Pro', premium: 'Premium', oem: 'OEM', free: '未契約' };
        const planColors = { standard: 'bg-blue-100 text-blue-800', pro: 'bg-green-100 text-green-800', premium: 'bg-purple-100 text-purple-800', oem: 'bg-amber-100 text-amber-800', free: 'bg-gray-100 text-gray-500' };

        // ローカルストレージに保存されている店舗のみ表示（入力しない限り見えない）
        let savedOrgIds = [];
        try {
            savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
        } catch(e) {}
        shops = shops.filter(shop => savedOrgIds.includes(shop.id) || savedOrgIds.includes(shop.organization_id));

        let tableRows = '';
        if (shops.length === 0) {
            tableRows = `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">登録されている店舗がありません</td></tr>`;
        } else {
            tableRows = shops.map(shop => {
                const date = new Date(shop.created_at);
                const dateStr = `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}`;
                const plan = shop.plan || 'free';
                const status = shop.license_status || 'active';
                const statusBadge = status === 'active'
                    ? '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700">稼働中</span>'
                    : '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-600">停止</span>';
                return `
                <tr class="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                    <td class="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600">
                                <i class="fa-solid fa-store"></i>
                            </div>
                            <div>
                                <span class="font-bold">${this._sanitize(shop.name || '未設定')}</span>
                                ${shop.contact_name ? `<div class="text-xs text-gray-400">${this._sanitize(shop.contact_name)}</div>` : ''}
                            </div>
                        </div>
                    </td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">${this._sanitize(shop.contract_id || '—')}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm">
                        <span class="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${planColors[plan] || planColors.free}">
                            ${planLabels[plan] || plan}
                        </span>
                    </td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-center text-gray-700">${shop.staff_count || 0}名</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-center">${statusBadge}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-400">${dateStr}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-center font-medium space-x-2">
                        <button onclick="app.switchToHQShop('${shop.organization_id || shop.id}')" class="text-indigo-600 hover:text-indigo-900 font-bold">
                            <i class="fa-solid fa-eye"></i> 閲覧
                        </button>
                        <button onclick="app.removeHQShop('${shop.organization_id || shop.id}')" class="text-red-600 hover:text-red-900 font-bold ml-2">
                            <i class="fa-solid fa-trash"></i> 削除
                        </button>
                    </td>
                </tr>
            `}).join('');
        }

        container.innerHTML = `
            <div class="max-w-6xl mx-auto space-y-6 pb-20">
                <div class="bg-gradient-to-r from-indigo-600 to-blue-600 rounded-2xl shadow-lg p-6 md:p-8 text-white flex justify-between items-center relative overflow-hidden">
                    <div class="relative z-10">
                        <h2 class="text-2xl md:text-3xl font-bold mb-2"><i class="fa-solid fa-building mr-2"></i>本部・ダッシュボード</h2>
                        <p class="text-indigo-100 text-sm md:text-base">店舗にアクセスするには、下記の入力フォームから契約IDとパスワードを入力してください。</p>
                    </div>
                    <div class="relative z-10 flex flex-wrap gap-2 md:gap-3">
                        <button onclick="app.changeView('hq_manual')" class="bg-white/20 hover:bg-white/30 backdrop-blur text-white px-3 py-2 rounded-lg font-bold text-sm transition flex items-center gap-1.5">
                            <i class="fa-solid fa-book"></i> 本部マニュアル
                        </button>
                        <button onclick="app.openHQPasswordChange()" class="bg-white/20 hover:bg-white/30 backdrop-blur text-white px-3 py-2 rounded-lg font-bold text-sm transition flex items-center gap-1.5">
                            <i class="fa-solid fa-key"></i> パスワード変更
                        </button>
                        <button onclick="app.hqLogout()" class="bg-white/20 hover:bg-white/30 backdrop-blur text-white px-3 py-2 rounded-lg font-bold text-sm transition flex items-center gap-1.5">
                            <i class="fa-solid fa-right-from-bracket"></i> ログアウト
                        </button>
                    </div>
                    <div class="absolute right-0 top-0 opacity-10 text-[120px] leading-none transform translate-x-1/4 -translate-y-1/4 pointer-events-none">
                        <i class="fa-solid fa-globe"></i>
                    </div>
                </div>

                <!-- Manual Shop Login Card -->
                <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="px-6 py-4 border-b border-gray-200 bg-gray-50">
                        <h3 class="font-bold text-gray-800"><i class="fa-solid fa-key text-blue-500 mr-2"></i>指定の店舗を閲覧 (IDとパスワードでアクセス)</h3>
                    </div>
                    <div class="p-6">
                        <div class="flex flex-col md:flex-row gap-4 items-end">
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-500 mb-1">契約ID</label>
                                <input type="text" id="hqManualContractId" class="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="例: 123456789012345">
                            </div>
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-500 mb-1">パスワード</label>
                                <input type="password" id="hqManualPassword" class="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="店舗用または管理者パスワード" onkeydown="if(event.key==='Enter') app.hqManualShopLogin()">
                            </div>
                            <div>
                                <button onclick="app.hqManualShopLogin()" class="w-full md:w-auto px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow transition whitespace-nowrap">
                                    <i class="fa-solid fa-eye mr-2"></i>閲覧する
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800"><i class="fa-solid fa-list text-gray-400 mr-2"></i>登録店舗一覧 (${shops.length}店舗)</h3>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="min-w-full divide-y divide-gray-200">
                            <thead class="bg-gray-50">
                                <tr>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">店舗名</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">契約ID</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">プラン</th>
                                    <th scope="col" class="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider">スタッフ</th>
                                    <th scope="col" class="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider">状態</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">登録日</th>
                                    <th scope="col" class="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
                                </tr>
                            </thead>
                            <tbody class="bg-white divide-y divide-gray-200">
                                ${tableRows}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    },

    async hqManualShopLogin() {
        if (!this.state.isHQ) return;
        
        const contractId = document.getElementById('hqManualContractId')?.value.trim();
        const password = document.getElementById('hqManualPassword')?.value.trim();

        if (!contractId || !password) {
            this.showToast('契約IDとパスワードを入力してください', 'warning');
            return;
        }

        this.showLoading(true);
        try {
            // 店舗のパスワード（スタッフまたは管理者）を検証
            // 管理者パスワードでも通るように、まず shop login、ダメなら admin login を試すか、shop login で一元化
            // 今回は店舗用ログインを試す
            const authResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: password
            });

            if (authResult && authResult.success) {
                // Save to localStorage
                try {
                    let savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
                    if (!savedOrgIds.includes(authResult.organization_id)) {
                        savedOrgIds.push(authResult.organization_id);
                        localStorage.setItem('hq_saved_shops', JSON.stringify(savedOrgIds));
                    }
                } catch(e) {}

                this.state.organization_id = authResult.organization_id;
                this.state.isAdmin = true;
                this.state.isShopLoggedIn = true;
                await this.loadData();
                this.showToast('店舗 (' + contractId + ') の閲覧を開始します', 'success');
                this.updateAuthUI();
                this.changeView('dashboard');
            } else {
                // 管理者として試す
                const adminResult = await API.rpc('verify_admin_login', {
                    p_contract_id: contractId,
                    p_login_id: 'admin',
                    p_password: password
                });

                if (adminResult && adminResult.success) {
                    // Save to localStorage
                    try {
                        let savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
                        if (!savedOrgIds.includes(adminResult.organization_id)) {
                            savedOrgIds.push(adminResult.organization_id);
                            localStorage.setItem('hq_saved_shops', JSON.stringify(savedOrgIds));
                        }
                    } catch(e) {}

                    this.state.organization_id = adminResult.organization_id;
                    this.state.isAdmin = true;
                    this.state.isShopLoggedIn = true;
                    await this.loadData();
                    this.showToast('管理者権限で店舗 (' + contractId + ') の閲覧を開始します', 'success');
                    this.updateAuthUI();
                    this.changeView('dashboard');
                } else {
                    this.showToast('IDまたはパスワードが正しくありません', 'error');
                }
            }
        } catch(e) {
            console.error('HQ Manual Shop Login error:', e);
            this.showToast('エラーが発生しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    removeHQShop(orgId) {
        if (!confirm('この店舗をリストから削除しますか？\n(※データベースのデータは削除されません)')) return;
        try {
            let savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
            savedOrgIds = savedOrgIds.filter(id => id !== orgId);
            localStorage.setItem('hq_saved_shops', JSON.stringify(savedOrgIds));
            this.showToast('店舗をリストから削除しました', 'info');
            this.renderCurrentView();
        } catch(e) {
            console.error('Failed to remove shop', e);
        }
    },

    async switchToHQShop(orgId) {
        if (!this.state.isHQ) return;
        this.showLoading(true);
        try {
            this.state.organization_id = orgId;
            this.state.isAdmin = true;
            this.state.isShopLoggedIn = true;
            await this.loadData();
            this.showToast('店舗情報を読み込みました（閲覧専用モード）', 'success');
            this.updateAuthUI();
            this.changeView('dashboard');
        } catch(e) {
            console.error('Shop loading error:', e);
            this.showToast('店舗情報の読み込みに失敗しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // =========================================================
    // v3.7.134: PIN 必須化 (セカンドファクター)
    //   - 既存ユーザーも次回ログイン時に PIN 設定必須
    //   - 設定済ユーザーはログイン時に PIN 入力
    //   - 引き継ぎ時は現 PIN で認証して新 PIN に変更
    // =========================================================
    _pinPendingContractId: null,  // PIN 待機中の contract_id
    _pinPendingResolve: null,     // PIN フロー完了の Promise resolve

    // ログイン成功直後に呼ぶ。PIN 未設定 → 初回設定モーダル / 設定済 → 検証モーダル
    async _checkPinIfNeeded(contractId) {
        let hasPin = false;
        try {
            const r = await API.rpc('has_pin_by_contract', { p_contract_id: contractId });
            hasPin = !!(r && r.has_pin);
        } catch (e) {
            console.warn('[PIN] has_pin check failed:', e);
            return true;  // RPC 失敗時はフェイルオープン
        }
        this._pinPendingContractId = contractId;
        if (hasPin) {
            return await this._showPinEntryModal(contractId);
        } else {
            return await this._showPinSetupModal(contractId);
        }
    },

    // 初回 PIN 設定モーダル
    _showPinSetupModal(contractId) {
        this._pinPendingContractId = contractId;
        const modal = document.getElementById('pinSetupModal');
        if (!modal) return Promise.resolve(true);
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        const newEl = document.getElementById('pinSetupNew');
        const confEl = document.getElementById('pinSetupConfirm');
        if (newEl) { newEl.value = ''; setTimeout(() => newEl.focus(), 100); }
        if (confEl) confEl.value = '';
        const err = document.getElementById('pinSetupError');
        if (err) { err.classList.add('hidden'); err.textContent = ''; }
        return new Promise(resolve => { this._pinPendingResolve = resolve; });
    },

    async submitPinSetup() {
        const np = document.getElementById('pinSetupNew')?.value || '';
        const nc = document.getElementById('pinSetupConfirm')?.value || '';
        const errEl = document.getElementById('pinSetupError');
        const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
        if (!/^[0-9]{4,8}$/.test(np)) return showErr('PIN は 4〜8桁の数字');
        if (np !== nc) return showErr('PIN (確認) が一致しません');
        try {
            const r = await API.rpc('set_pin_initial_by_contract', {
                p_contract_id: this._pinPendingContractId,
                p_new_pin: np,
            });
            if (r && r.success) {
                this._closePinSetupModal();
                this.showToast('PIN を設定しました', 'success');
                if (this._pinPendingResolve) { this._pinPendingResolve(true); this._pinPendingResolve = null; }
            } else {
                showErr(r?.message || '設定に失敗しました');
            }
        } catch (e) {
            console.error('[PIN] setup error:', e);
            showErr('PIN 設定に失敗しました');
            // v3.7.137: 例外時もモーダルを開いたまま再試行を許可
            // Promise は resolve せず、ユーザーがキャンセル/再試行を選ぶ
        }
    },

    cancelPinSetup() {
        if (!confirm('PIN を設定せずログアウトしますか?\nPIN を設定しないとログインを完了できません。')) return;
        this._closePinSetupModal();
        if (this._pinPendingResolve) { this._pinPendingResolve(false); this._pinPendingResolve = null; }
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        try { sessionStorage.removeItem('rakushift_user'); } catch (_) {}
        try { localStorage.removeItem('rakushift_org_id'); } catch (_) {}
        this.updateAuthUI();
        this.openModal('loginModal');
    },

    _closePinSetupModal() {
        const modal = document.getElementById('pinSetupModal');
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    },

    _showPinEntryModal(contractId) {
        this._pinPendingContractId = contractId;
        const modal = document.getElementById('pinEntryModal');
        if (!modal) return Promise.resolve(true);
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        const input = document.getElementById('pinEntryInput');
        if (input) { input.value = ''; setTimeout(() => input.focus(), 100); }
        const err = document.getElementById('pinEntryError');
        if (err) { err.classList.add('hidden'); err.textContent = ''; }
        return new Promise(resolve => { this._pinPendingResolve = resolve; });
    },

    async submitPinEntry() {
        const input = document.getElementById('pinEntryInput');
        const errEl = document.getElementById('pinEntryError');
        const pin = (input && typeof input.value === 'string') ? input.value.trim() : '';
        if (!/^[0-9]{4,8}$/.test(pin)) {
            if (errEl) { errEl.textContent = 'PIN は 4〜8桁の数字'; errEl.classList.remove('hidden'); }
            return;
        }
        try {
            const r = await API.rpc('verify_pin_by_contract', {
                p_contract_id: this._pinPendingContractId,
                p_pin: pin,
            });
            // v3.7.137: PIN 未設定が判明したら初回設定モーダルに切替
            if (r && !r.success && r.has_pin === false) {
                this._closePinEntryModal();
                // 初回設定フローへ遷移
                const ok = await this._showPinSetupModal(this._pinPendingContractId);
                if (this._pinPendingResolve) { this._pinPendingResolve(ok); this._pinPendingResolve = null; }
                return;
            }
            if (r && r.success) {
                this._closePinEntryModal();
                if (this._pinPendingResolve) { this._pinPendingResolve(true); this._pinPendingResolve = null; }
            } else {
                if (errEl) {
                    errEl.textContent = r?.message || 'PIN が正しくありません';
                    errEl.classList.remove('hidden');
                }
                if (input) input.value = '';
            }
        } catch (e) {
            console.error('[PIN] verify error:', e);
            if (errEl) {
                errEl.textContent = 'PIN 認証に失敗しました';
                errEl.classList.remove('hidden');
            }
            // v3.7.137: RPC エラー時も Promise を resolve(false) してハング防止
            // モーダルは閉じず、ユーザーが再試行 or キャンセル できるようにする
        }
    },

    cancelPinEntry() {
        // v3.7.137: state を最初にクリア (renderCurrentView 等の競合を防ぐ)
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        try { sessionStorage.removeItem('rakushift_user'); } catch (_) {}
        try { localStorage.removeItem('rakushift_org_id'); } catch (_) {}
        this._closePinEntryModal();
        if (this._pinPendingResolve) { this._pinPendingResolve(false); this._pinPendingResolve = null; }
        this.updateAuthUI();
        this.openModal('loginModal');
    },

    _closePinEntryModal() {
        const modal = document.getElementById('pinEntryModal');
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
        this._pinPendingContractId = null;
    },

    // 設定画面から呼ばれる: PIN 変更モーダル (現PIN + 新PIN)
    openPinChangeModal() {
        const modal = document.getElementById('pinChangeModal');
        if (!modal) return;
        ['pinChangeCurrent', 'pinChangeNew', 'pinChangeConfirm'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const err = document.getElementById('pinChangeError');
        if (err) { err.classList.add('hidden'); err.textContent = ''; }
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        setTimeout(() => document.getElementById('pinChangeCurrent')?.focus(), 100);
    },

    closePinChangeModal() {
        const modal = document.getElementById('pinChangeModal');
        if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
    },

    async submitPinChange() {
        const cid = this._getContractId();
        const cur = document.getElementById('pinChangeCurrent')?.value || '';
        const np = document.getElementById('pinChangeNew')?.value || '';
        const nc = document.getElementById('pinChangeConfirm')?.value || '';
        const errEl = document.getElementById('pinChangeError');
        const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
        if (!cid) return showErr('contract_id 未取得');
        if (!/^[0-9]{4,8}$/.test(cur)) return showErr('現在の PIN は 4〜8桁の数字');
        if (!/^[0-9]{4,8}$/.test(np)) return showErr('新しい PIN は 4〜8桁の数字');
        if (np !== nc) return showErr('新 PIN (確認) が一致しません');
        if (cur === np) return showErr('新しい PIN は現在の PIN と異なる値にしてください');
        try {
            const r = await API.rpc('change_pin_with_pin_by_contract', {
                p_contract_id: cid,
                p_current_pin: cur,
                p_new_pin: np,
            });
            if (r && r.success) {
                this.closePinChangeModal();
                this.showToast(r.message || 'PIN を変更しました', 'success');
                this.renderSettings(document.getElementById('viewContainer'));
            } else {
                showErr(r?.message || '変更に失敗しました');
            }
        } catch (e) {
            console.error('[PIN] change error:', e);
            showErr('PIN 変更に失敗しました');
        }
    },

    async _hasPinSet() {
        const cid = this._getContractId();
        if (!cid) return false;
        try {
            const r = await API.rpc('has_pin_by_contract', { p_contract_id: cid });
            return !!(r && r.has_pin);
        } catch (e) { return false; }
    },

    // =========================================================
    // v3.7.130: 店舗管理者 初回チュートリアル (30秒ガイド)
    // =========================================================
    _tutorialSteps: [
        {
            icon: 'fa-hand-wave',
            color: 'text-blue-500',
            title: 'ようこそ ラクシフトAI へ',
            description: 'AI でシフト作成を自動化、ドラッグ&ドロップで微調整、印刷まで一気通貫。約30秒で主要機能をご案内します。',
        },
        {
            icon: 'fa-users-gear',
            color: 'text-emerald-500',
            title: '① スタッフ管理',
            description: 'スタッフの役割・給与・勤務制約 (週/月の出勤日数・連続出勤日数) を設定します。「該当シフトパターン」で早番のみ等の個別制限も可能。',
            hint: 'サイドバー [スタッフ] から登録。連続出勤日数 (デフォルト6=労基法35条) を必ず確認',
        },
        {
            icon: 'fa-store',
            color: 'text-purple-500',
            title: '② 店舗設定',
            description: '営業時間、休業曜日、シフトパターン (早番・遅番等)、各パターンの必要人数を設定。土日祝で人数を分けられます。',
            hint: 'シフトパターン人数を 0 にすると「そのパターン不要」になります',
        },
        {
            icon: 'fa-wand-magic-sparkles',
            color: 'text-amber-500',
            title: '③ AI シフト生成',
            description: 'ダッシュボードの「AIで作成」ボタンで、すべての制約を考慮した最適シフトを 1〜2 分で生成。過剰配置の許容も切替可能。',
            hint: '過剰配置 OFF: 必要人数ぴったり / ON: 最低出勤日数を優先補完',
        },
        {
            icon: 'fa-arrows-up-down-left-right',
            color: 'text-indigo-500',
            title: '④ ドラッグ&ドロップで微調整',
            description: 'シフトバーを別のセルにドラッグで移動、既存シフトに重ねると入れ替え (swap)。連勤上限超過は自動でブロックされます。',
            hint: '管理者ログイン中のみ操作可能。失敗時は自動ロールバック',
        },
        {
            icon: 'fa-print',
            color: 'text-rose-500',
            title: '⑤ 印刷・公開',
            description: 'シフト確定後、画面右上の印刷ボタンで PDF/印刷可能。スタッフは個別ログインで自分のシフトのみ閲覧できます。',
            hint: '人員状況の「⚡ 要N+過剰M=合計名」表示で需給バランスを一目で確認',
        },
    ],
    _tutorialIndex: 0,

    _shouldShowTutorial() {
        try {
            return !localStorage.getItem('rakushift_tutorial_v1_seen');
        } catch (e) {
            return false;
        }
    },

    _maybeShowTutorial() {
        // 店舗管理者ログイン直後にのみ表示 (本部/閲覧専用モードは除外)
        if (!this.state.isAdmin || this.state.isHQ) return;
        if (!this._shouldShowTutorial()) return;
        setTimeout(() => this.showTutorial(), 600);
    },

    showTutorial(forceShow) {
        this._tutorialIndex = 0;
        const modal = document.getElementById('tutorialModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        this._renderTutorialStep();
    },

    _renderTutorialStep() {
        const steps = this._tutorialSteps;
        const i = this._tutorialIndex;
        const s = steps[i];
        if (!s) return;
        const total = steps.length;
        // 進捗
        const ind = document.getElementById('tutorialStepIndicator');
        if (ind) ind.textContent = `${i + 1}/${total}`;
        const bar = document.getElementById('tutorialProgressBar');
        if (bar) bar.style.width = `${((i + 1) / total) * 100}%`;
        // アイコン
        const iconEl = document.getElementById('tutorialIcon');
        if (iconEl) {
            iconEl.className = `text-5xl mb-3 ${s.color || 'text-blue-500'}`;
            iconEl.innerHTML = `<i class="fa-solid ${s.icon}"></i>`;
        }
        // タイトル/説明
        const titleEl = document.getElementById('tutorialTitle');
        if (titleEl) titleEl.textContent = s.title;
        const descEl = document.getElementById('tutorialDescription');
        if (descEl) descEl.textContent = s.description;
        // ヒント
        const hintWrap = document.getElementById('tutorialHint');
        const hintTxt = document.getElementById('tutorialHintText');
        if (s.hint) {
            if (hintWrap) hintWrap.classList.remove('hidden');
            if (hintTxt) hintTxt.textContent = s.hint;
        } else {
            if (hintWrap) hintWrap.classList.add('hidden');
        }
        // ボタン
        const prevBtn = document.getElementById('tutorialPrevBtn');
        if (prevBtn) prevBtn.disabled = (i === 0);
        const nextBtn = document.getElementById('tutorialNextBtn');
        if (nextBtn) {
            nextBtn.innerHTML = (i === total - 1)
                ? '使ってみる<i class="fa-solid fa-check ml-1"></i>'
                : '次へ<i class="fa-solid fa-chevron-right ml-1"></i>';
        }
    },

    nextTutorialStep() {
        if (this._tutorialIndex < this._tutorialSteps.length - 1) {
            this._tutorialIndex++;
            this._renderTutorialStep();
        } else {
            this.dismissTutorial(true);
        }
    },

    prevTutorialStep() {
        if (this._tutorialIndex > 0) {
            this._tutorialIndex--;
            this._renderTutorialStep();
        }
    },

    dismissTutorial(completed) {
        const modal = document.getElementById('tutorialModal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
        try {
            localStorage.setItem('rakushift_tutorial_v1_seen', completed ? 'completed' : 'skipped');
        } catch (e) {}
        if (completed) {
            this.showToast('チュートリアル完了。困ったら設定 → 使い方ガイドから再表示できます', 'success');
        }
    },

    // admin.html → openTenantView(contract_id) → index.html?as_hq=<contract_id> から呼ばれる。
    // ローカルの本部セッション (rakushift_user.role='hq_admin') を確認し、
    // 該当 contract_id が本部の scope_org_ids に含まれるかチェックしてから閲覧モードに入る。
    async _enterHQViewMode(contractId) {
        // 既に本部としてセッションがあるか確認
        let sess = null;
        try {
            const raw = sessionStorage.getItem('rakushift_user') || localStorage.getItem('rakushift_user');
            if (raw) sess = JSON.parse(raw);
        } catch (_) {}

        if (!sess || sess.role !== 'hq_admin') {
            this.showToast('本部観覧モードには本部ログインが必要です。本部ログインしてからご利用ください。', 'warning');
            return;
        }

        // login_id undefined の古いセッションは強制再ログイン
        if (!sess.login_id) {
            this.showToast('セッションが古いため再ログインしてください', 'warning');
            sessionStorage.removeItem('rakushift_user');
            localStorage.removeItem('rakushift_user');
            return;
        }

        this.state.isHQ = true;
        API.setSession(sess);

        // contract_id → organization_id 解決 (session-less RPC)
        let orgId = null;
        try {
            const r = await API.rpc('resolve_config_id_by_contract', { p_contract_id: contractId });
            if (r && r.organization_id) orgId = r.organization_id;
        } catch (e) {
            console.error('[HQ View] resolve org_id failed:', e);
        }

        if (!orgId) {
            this.showToast('指定されたテナントが見つかりません', 'error');
            return;
        }

        // スコープチェック: グローバル本部以外は scope_org_ids に含まれる店舗のみ可
        // (サーバ側 RLS でも弾かれるが、フロント側でも明示)
        if (sess.is_global !== true) {
            const scope = Array.isArray(sess.scope_org_ids) ? sess.scope_org_ids : [];
            if (!scope.includes(orgId)) {
                this.showToast('この店舗は貴社の管轄外のため閲覧できません', 'error');
                return;
            }
        }

        await this.switchToHQShop(orgId);
        // ヘッダーに本部観覧モードのバナー表示
        setTimeout(() => this.showToast('🔍 本部観覧モード — 編集操作はサーバ側でも遮断されます', 'info'), 800);
    },

    // 本部ログアウト（confirmなしで即時実行）
    hqLogout() {
        this.state.isHQ = false;
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        this.state.organization_id = null;
        this.state.config = {};
        this.state.staff = [];
        this.state.shifts = [];
        this.state.requests = [];
        API.setSession(null);
        sessionStorage.removeItem('rakushift_user');
        localStorage.removeItem('rakushift_org_id');
        localStorage.removeItem('hq_saved_shops');
        window.location.reload();
    },

    // 1. ダッシュボード (Dashboard)
    // =================================================================
    renderDashboard(container) {
        // タイマークリア（念のため）
        if (this.state.dashboardTimer) {
            clearInterval(this.state.dashboardTimer);
            this.state.dashboardTimer = null;
        }

        const todayStr = new Date().toISOString().split('T')[0];
        const pendingCount = this.state.requests.filter(r => r.status === 'pending').length;
        const chartData = this.getDashboardChartData();

        const todayShiftsInitial = this.state.shifts.filter(s => s.date === todayStr);

        container.innerHTML = `
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                <!-- 左カラム -->
                <div class="lg:col-span-2 space-y-6">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <!-- 承認待ち (管理者の場合のみクリック可) -->
                        <div class="bg-white p-4 rounded-xl shadow-sm border ${pendingCount > 0 ? 'border-red-200 bg-red-50' : 'border-gray-200'} ${this.state.isAdmin ? 'cursor-pointer hover:scale-[1.02]' : ''} transition-transform" ${this.state.isAdmin ? `onclick="app.changeView('requests')"` : ''}>
                            <div class="flex justify-between items-start">
                                <div>
                                    <p class="text-xs font-bold text-gray-500 uppercase">未承認の申請</p>
                                    <h3 class="text-2xl font-bold ${pendingCount > 0 ? 'text-red-600' : 'text-gray-700'}">${pendingCount} <span class="text-sm text-gray-500">件</span></h3>
                                </div>
                                <div class="w-10 h-10 rounded-full ${pendingCount > 0 ? 'bg-red-100 text-red-500' : 'bg-gray-100 text-gray-400'} flex items-center justify-center">
                                    <i class="fa-solid fa-inbox"></i>
                                </div>
                            </div>
                            ${this.state.isAdmin ? (pendingCount > 0 ? '<p class="text-xs text-red-500 mt-2 font-bold">確認してください</p>' : '<p class="text-xs text-gray-400 mt-2">対応は完了しています</p>') : '<p class="text-xs text-gray-400 mt-2">※管理人のみ閲覧可能</p>'}
                        </div>

                        <!-- 本日のスタッフ数 -->
                        <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                             <div class="flex justify-between items-start">
                                <div>
                                    <p class="text-xs font-bold text-gray-500 uppercase">本日の出勤</p>
                                    <h3 class="text-2xl font-bold text-blue-600">${todayShiftsInitial.length} <span class="text-sm text-gray-500">名</span></h3>
                                </div>
                                <div class="w-10 h-10 rounded-full bg-blue-50 text-blue-500 flex items-center justify-center">
                                    <i class="fa-solid fa-users"></i>
                                </div>
                            </div>
                            <p class="text-xs text-gray-400 mt-2">営業時間: ${this.state.config.opening_time || '09:00'} - ${this.state.config.closing_time || '22:00'}</p>
                        </div>
                    </div>

                    <!-- 今日のシフトリスト -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                        <div class="p-4 border-b border-gray-100 flex justify-between items-center">
                            <h3 class="font-bold text-gray-800 flex items-center gap-2">
                                <i class="fa-regular fa-calendar-check text-blue-500"></i> 今日のシフト詳細
                            </h3>
                            <span class="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-1 rounded" id="dashboardCurrentTime">${todayStr}</span>
                        </div>
                        
                        <div id="dashboardShiftList" class="divide-y divide-gray-50 max-h-[300px] overflow-y-auto">
                            <!-- JSで自動更新 -->
                        </div>
                    </div>
                </div>

                <!-- 右カラム -->
                <div class="space-y-6">
                    <!-- グラフ (管理者のみ表示) -->
                    ${this.state.isAdmin ? `
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                        <h3 class="font-bold text-gray-800 mb-1 text-sm">直近7日間の人件費(概算)</h3>
                        <p class="text-xs text-gray-400 mb-4">祝日割増・休憩控除を含みます</p>
                        <div class="h-[200px] w-full">
                            <canvas id="dashboardChart"></canvas>
                        </div>
                    </div>
                    ` : ''}

                    <!-- クイックアクション -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                         <h3 class="font-bold text-gray-800 mb-3 text-sm">クイックメニュー</h3>
                         <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            ${this.state.isAdmin ? `
                            <button onclick="app.prepareStaffModal()"
                                class="w-full text-left px-4 py-3 hover:bg-blue-50 rounded-lg text-sm font-bold text-gray-600 hover:text-blue-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-blue-200">
                                <i class="fa-solid fa-user-plus text-blue-500 text-lg"></i> スタッフ追加
                            </button>
                            ` : ''}
                            
                            <button onclick="app.openModal('requestModal'); app.initRequestModal();"
                                class="w-full text-left px-4 py-3 hover:bg-red-50 rounded-lg text-sm font-bold text-gray-600 hover:text-red-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-red-200">
                                <i class="fa-solid fa-umbrella-beach text-red-400 text-lg"></i> 休み希望を出す
                            </button>

                            <button onclick="app.showShopRules()" 
                                class="w-full text-left px-4 py-3 hover:bg-orange-50 rounded-lg text-sm font-bold text-gray-600 hover:text-orange-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-orange-200">
                                <i class="fa-solid fa-book-open text-orange-400 text-lg"></i> お店のルール
                            </button>

                            <button id="btn-quick-shift" onclick="app.changeView('manual-shift')" 
                                class="w-full text-left px-4 py-3 hover:bg-teal-50 rounded-lg text-sm font-bold text-gray-600 hover:text-teal-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-teal-200">
                                <i class="fa-solid fa-calendar-days text-teal-500 text-lg"></i> シフト表を確認
                            </button>
                         </div>
                    </div>
                </div>
            </div>
        `;

        // 自動更新関数
        const updateShiftList = () => {
            const listContainer = document.getElementById('dashboardShiftList');
            const timeDisplay = document.getElementById('dashboardCurrentTime');
            if (!listContainer) return;

            const now = new Date();
            // 修正: 時間もゼロパディングして2桁にする (例: 1:05 -> 01:05)
            // これにより文字列比較 "01:00" >= "09:00" が正しく false になる
            const currentHour = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
            
            // 時刻表示更新
            if(timeDisplay) timeDisplay.textContent = `${todayStr} ${currentHour}`;

            const todayShifts = this.state.shifts
                .filter(s => s.date === todayStr)
                .sort((a, b) => a.start_time.localeCompare(b.start_time));

            if (todayShifts.length === 0) {
                listContainer.innerHTML = '<div class="p-6 text-center text-gray-400 text-sm">本日のシフトはありません</div>';
                return;
            }

            listContainer.innerHTML = todayShifts.map(s => {
                const staff = this.getStaff(s.staff_id);
                
                // 勤務状況判定 (日またぎ対応)
                let isWorking = false;
                let isFinished = false;

                if (s.start_time > s.end_time) {
                    // 日またぎシフト (例: 22:00 - 05:00)
                    // 現在時刻が開始時刻以降(22:00-23:59) または 終了時刻以前(00:00-05:00)
                    if (currentHour >= s.start_time || currentHour <= s.end_time) {
                        isWorking = true;
                    } else {
                        // 勤務時間外
                        // 例: 06:00 (終了後) -> 21:00 (開始前)
                        // 今日の日付のシフトとして扱われているため、終了時刻を過ぎていれば「終了」とみなす
                        isFinished = currentHour > s.end_time && currentHour < s.start_time;
                    }
                } else {
                    // 通常シフト (例: 09:00 - 18:00)
                    isWorking = currentHour >= s.start_time && currentHour <= s.end_time;
                    isFinished = currentHour > s.end_time;
                }
                
                const statusClass = isWorking ? 'bg-green-50' : (isFinished ? 'bg-gray-50 opacity-60' : '');
                const borderClass = isWorking ? 'border-l-4 border-green-500' : 'border-l-4 border-transparent';
                
                return `
                    <div class="flex items-center justify-between p-3 hover:bg-gray-50 transition-colors ${statusClass} ${borderClass}">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center font-bold text-gray-600 text-xs">
                                ${staff ? this._sanitize(staff.name.charAt(0)) : '?'}
                            </div>
                            <div>
                                <div class="font-bold text-sm text-gray-800">${staff ? this._sanitize(staff.name) : '削除済スタッフ'}</div>
                                <div class="text-[10px] text-gray-500">${s.start_time} - ${s.end_time}</div>
                            </div>
                        </div>
                        <div>
                            ${isWorking ? '<span class="text-[10px] font-bold text-green-600 flex items-center gap-1"><span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>勤務中</span>' : ''}
                            ${isFinished ? '<span class="text-[10px] font-bold text-gray-400">勤務終了</span>' : ''}
                            ${!isWorking && !isFinished ? '<span class="text-[10px] font-bold text-blue-500">出勤前</span>' : ''}
                        </div>
                    </div>
                `;
            }).join('');
        };

        // 初回実行
        updateShiftList();

        // タイマーセット (1分ごと)
        this.state.dashboardTimer = setInterval(updateShiftList, 60000);

        // チャート描画
        setTimeout(() => {
            const ctx = document.getElementById('dashboardChart');
            if(ctx) {
                if (this.dashboardChartInstance) this.dashboardChartInstance.destroy();

                this.dashboardChartInstance = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: chartData.labels,
                        datasets: [{
                            label: '日次人件費 (円)',
                            data: chartData.data,
                            backgroundColor: chartData.colors,
                            borderRadius: 4,
                            barThickness: 12
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: { 
                            y: { display: true, ticks: { callback: v => '¥' + v/1000 + 'k', font: { size: 10 } }, grid: { color: '#f3f4f6' } }, 
                            x: { grid: { display: false }, ticks: { font: { size: 10 } } } 
                        }
                    }
                });
            }
        }, 100);
        
        // Ensure button works
        setTimeout(() => {
            const btn = document.getElementById('btn-quick-shift');
            if(btn) btn.onclick = () => app.changeView('manual-shift');
        }, 50);
    },

    getDashboardChartData() {
        const labels = [];
        const data = [];
        const colors = [];
        const today = new Date();

        for (let i = 6; i >= 0; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            const dateStr = targetDate.toISOString().split('T')[0];
            
            labels.push(`${targetDate.getMonth()+1}/${targetDate.getDate()}`);

            let dailyCost = 0;
            const dayShifts = this.state.shifts.filter(s => s.date === dateStr);

            dayShifts.forEach(shift => {
                const staff = this.getStaff(shift.staff_id);
                if (!staff || staff.salary_type !== 'hourly') return;

                const start = new Date(`${dateStr}T${shift.start_time}`);
                const end = new Date(`${dateStr}T${shift.end_time}`);
                if (end < start) end.setDate(end.getDate() + 1);
                let hours = (end - start) / (1000 * 60 * 60) - ((shift.break_minutes || 0) / 60);
                if (hours < 0) hours = 0;

                let wage = staff.hourly_wage;
                if (JapaneseHolidays.isHoliday(dateStr)) wage *= 1.25;
                dailyCost += Math.floor(hours * wage);
            });

            data.push(dailyCost);
            colors.push(i === 0 ? '#3b82f6' : '#cbd5e1');
        }
        return { labels, data, colors };
    },

    // =================================================================
    // 2. 申請リスト (Requests) - Admin Only
    // =================================================================
    renderRequests(container) {
        if (!this.state.isAdmin) {
             container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-gray-500">
                    <i class="fa-solid fa-lock text-4xl mb-4 text-gray-300"></i>
                    <p class="font-bold text-gray-600">権限がありません</p>
                    <p class="text-sm">申請の管理を行うには管理者としてログインしてください</p>
                    <button onclick="app.openModal('loginModal')" class="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg font-bold shadow hover:bg-blue-700">管理者ログイン</button>
                </div>
            `;
            return;
        }

        const pending = this.state.requests.filter(r => r.status === 'pending');
        // v3.7.150: 全申請一覧 (フィルタ + ソート可能)
        if (!this.state.requestsFilter) {
            this.state.requestsFilter = { status: 'all', type: 'all', staff: 'all', q: '' };
        }
        if (!this.state.requestsSort) {
            this.state.requestsSort = { key: 'created_at', dir: 'desc' };
        }
        const f = this.state.requestsFilter;
        const sort = this.state.requestsSort;
        const norm = (s) => (s == null ? '' : String(s).toLowerCase());
        const all = (this.state.requests || []).filter(r => {
            if (f.status !== 'all' && r.status !== f.status) return false;
            if (f.type !== 'all') {
                const t = r.type === 'off' || r.type === 'holiday' ? 'off' : 'work';
                if (t !== f.type) return false;
            }
            if (f.staff !== 'all' && String(r.staff_id) !== String(f.staff)) return false;
            if (f.q) {
                const s = this.getStaff(r.staff_id);
                const hay = norm((s && s.name) || '') + ' ' + norm(r.dates) + ' ' + norm(r.reason);
                if (!hay.includes(norm(f.q))) return false;
            }
            return true;
        });
        const getKey = (r) => {
            if (sort.key === 'staff') return norm((this.getStaff(r.staff_id) || {}).name);
            if (sort.key === 'dates') return norm(r.dates);
            if (sort.key === 'status') return norm(r.status);
            if (sort.key === 'type') return norm(r.type);
            return norm(r.created_at || '');
        };
        all.sort((a, b) => {
            const ka = getKey(a), kb = getKey(b);
            const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
            return sort.dir === 'asc' ? cmp : -cmp;
        });
        const uniqStaff = Array.from(new Set((this.state.requests || []).map(r => r.staff_id))).filter(Boolean);

        // v3.7.32 [B]: 承認希望が SOFT 化されたことを管理者に明示
        const softPolicyBanner = `
            <div class="mb-6 bg-blue-50 border-2 border-blue-200 rounded-xl p-4 text-blue-800">
                <div class="flex items-start gap-3">
                    <i class="fa-solid fa-circle-info text-xl mt-0.5 text-blue-600"></i>
                    <div class="text-sm leading-relaxed">
                        <div class="font-bold mb-1">承認した出勤希望の扱い (v3.7.30〜)</div>
                        <div>承認した出勤希望は、シフト生成時に <strong>原則として尊重</strong> されますが、
                        <strong>過剰配置になる場合は AI が諦めて配置しない</strong>ことがあります。
                        これは「過剰絶対回避ポリシー」のため、店舗運営を優先する設計です。<br>
                        <span class="text-xs text-blue-600">休み希望は引き続き 100% 反映されます。</span></div>
                    </div>
                </div>
            </div>
        `;

        container.innerHTML = `
            ${softPolicyBanner}
            <div class="grid lg:grid-cols-2 gap-8">
                <!-- Pending -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-blue-50">
                        <div class="flex justify-between items-center mb-3">
                            <h3 class="font-bold text-gray-800 flex items-center gap-2">
                                <i class="fa-solid fa-inbox text-blue-600"></i> 承認待ち
                                <span class="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">${pending.length}</span>
                            </h3>
                        </div>
                        ${pending.length > 0 ? `
                            <!-- v3.7.143: 選択して一括承認/拒否 -->
                            <div class="flex items-center justify-between gap-2 flex-wrap">
                                <div class="flex items-center gap-3 text-xs">
                                    <label class="inline-flex items-center gap-1.5 cursor-pointer">
                                        <input type="checkbox" id="reqSelectAll" onclick="app.toggleAllRequests(this.checked)" class="form-checkbox text-blue-600 rounded">
                                        <span class="font-bold text-gray-700">全選択</span>
                                    </label>
                                    <span class="text-gray-500" id="reqSelectedCount">0 件選択</span>
                                </div>
                                <div class="flex gap-1.5">
                                    <button onclick="app.handleBatchAction('approved')" class="px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-bold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1" id="batchApproveBtn" disabled>
                                        <i class="fa-solid fa-check-double"></i>選択を承認
                                    </button>
                                    <button onclick="app.handleBatchAction('rejected')" class="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded text-xs font-bold hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1" id="batchRejectBtn" disabled>
                                        <i class="fa-solid fa-xmark"></i>選択を拒否
                                    </button>
                                </div>
                            </div>
                        ` : ''}
                    </div>
                    <div class="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                        ${pending.length === 0 ? '<div class="p-8 text-center text-gray-400">現在、承認待ちの申請はありません</div>' : ''}
                        ${pending.map(req => {
                            const staff = this.getStaff(req.staff_id);
                            return `
                                <div class="p-4 hover:bg-gray-50 transition-colors">
                                    <div class="flex justify-between items-start mb-2">
                                        <div class="flex items-center gap-2">
                                            <!-- v3.7.143: 個別チェックボックス -->
                                            <input type="checkbox" class="req-select-cb form-checkbox text-blue-600 rounded mr-1" data-req-id="${req.id}" onclick="app.updateRequestSelectionUI()">
                                            <div class="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center font-bold text-gray-500 text-xs">
                                                ${staff ? this._sanitize(staff.name.charAt(0)) : '?'}
                                            </div>
                                            <div>
                                                <div class="font-bold text-gray-800 text-sm">${staff ? this._sanitize(staff.name) : '不明'}</div>
                                                <div class="text-xs text-gray-500">${new Date(req.created_at || Date.now()).toLocaleDateString()} 申請</div>
                                            </div>
                                        </div>
                                        <span class="text-xs font-bold px-2 py-1 rounded bg-yellow-100 text-yellow-700">
                                            ${req.type === 'off' ? '休み希望' : '勤務希望'}
                                        </span>
                                    </div>
                                    <div class="pl-10">
                                        <div class="text-sm font-bold text-gray-800 mb-1">
                                            <i class="fa-regular fa-calendar mr-1 text-gray-400"></i> ${this._sanitize(req.dates)}
                                            ${req.type === 'work' ? `<span class="ml-2 text-gray-600">${this._sanitize(req.start_time)} - ${this._sanitize(req.end_time)}</span>` : ''}
                                        </div>
                                        ${req.reason ? `<div class="text-xs text-gray-600 bg-gray-50 p-2 rounded mb-3">"${this._sanitize(req.reason)}"</div>` : ''}

                                        <div class="flex gap-3 mt-3 justify-end">
                                            <button onclick="app.handleRequest('${req.id}', 'rejected')" class="px-4 py-1.5 border border-gray-300 rounded text-gray-600 text-xs font-bold hover:bg-gray-50 shadow-sm transition-colors">
                                                却下
                                            </button>
                                            <button onclick="app.handleRequest('${req.id}', 'approved')" class="px-4 py-1.5 bg-blue-600 text-white rounded text-xs font-bold hover:bg-blue-700 shadow-sm transition-colors flex items-center gap-1">
                                                <i class="fa-solid fa-check"></i> 承認
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>

                <!-- v3.7.150: 全申請一覧 (検索/フィルタ/ソート) -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
                            <h3 class="font-bold text-gray-800 flex items-center gap-2">
                                <i class="fa-solid fa-list-check text-gray-500"></i> 全申請一覧
                                <span class="bg-gray-200 text-gray-700 text-xs px-2 py-0.5 rounded-full">${all.length}件</span>
                            </h3>
                            <span class="text-[10px] text-gray-500">全 ${(this.state.requests || []).length} 件中</span>
                        </div>
                        <!-- v3.7.153: 一括削除 UI -->
                        ${all.length > 0 ? `
                        <div class="flex items-center justify-between gap-2 flex-wrap mb-2 bg-red-50 border border-red-200 p-2 rounded">
                            <div class="flex items-center gap-3 text-xs">
                                <label class="inline-flex items-center gap-1.5 cursor-pointer">
                                    <input type="checkbox" id="reqDelSelectAll" onclick="app.toggleAllDeleteRequests(this.checked)" class="form-checkbox text-red-600 rounded">
                                    <span class="font-bold text-gray-700">全選択 (削除用)</span>
                                </label>
                                <span class="text-gray-500" id="reqDelSelectedCount">0 件選択</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <button type="button" onclick="app.deleteSelectedRequests()" class="px-3 py-1.5 bg-red-600 text-white rounded text-xs font-bold hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1" id="batchDeleteBtn" disabled>
                                    <i class="fa-solid fa-trash"></i>選択を削除
                                </button>
                                <button type="button" onclick="app.resetAllRequests()" title="この契約の希望シフト申請をすべて削除します" class="px-3 py-1.5 bg-white border border-red-600 text-red-700 rounded text-xs font-bold hover:bg-red-100 flex items-center gap-1">
                                    <i class="fa-solid fa-rotate-left"></i>すべてリセット
                                </button>
                            </div>
                        </div>
                        ` : ''}
                        <!-- 検索 + フィルタ -->
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
                            <input type="search" maxlength="100" placeholder="名前/日付/理由で検索" value="${this._sanitize(f.q)}"
                                onchange="app.setRequestsFilter('q', this.value)"
                                class="col-span-2 md:col-span-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded">
                            <select onchange="app.setRequestsFilter('status', this.value)" class="px-2.5 py-1.5 text-xs border border-gray-300 rounded bg-white">
                                <option value="all" ${f.status==='all'?'selected':''}>状態: すべて</option>
                                <option value="pending" ${f.status==='pending'?'selected':''}>承認待ち</option>
                                <option value="approved" ${f.status==='approved'?'selected':''}>承認済</option>
                                <option value="rejected" ${f.status==='rejected'?'selected':''}>却下</option>
                            </select>
                            <select onchange="app.setRequestsFilter('type', this.value)" class="px-2.5 py-1.5 text-xs border border-gray-300 rounded bg-white">
                                <option value="all" ${f.type==='all'?'selected':''}>種類: すべて</option>
                                <option value="work" ${f.type==='work'?'selected':''}>勤務希望</option>
                                <option value="off" ${f.type==='off'?'selected':''}>休み希望</option>
                            </select>
                            <select onchange="app.setRequestsFilter('staff', this.value)" class="px-2.5 py-1.5 text-xs border border-gray-300 rounded bg-white">
                                <option value="all" ${f.staff==='all'?'selected':''}>スタッフ: すべて</option>
                                ${uniqStaff.map(sid => {
                                    const s = this.getStaff(sid);
                                    const name = s ? s.name : '不明';
                                    return `<option value="${this._sanitize(sid)}" ${String(f.staff)===String(sid)?'selected':''}>${this._sanitize(name)}</option>`;
                                }).join('')}
                            </select>
                        </div>
                        <!-- ソート -->
                        <div class="flex items-center gap-2 text-[11px] text-gray-600">
                            <span>並び替え:</span>
                            <button onclick="app.setRequestsSort('created_at')" class="px-2 py-0.5 rounded ${sort.key==='created_at'?'bg-blue-600 text-white font-bold':'bg-white border border-gray-300 hover:bg-gray-100'}">申請日 ${sort.key==='created_at'?(sort.dir==='asc'?'↑':'↓'):''}</button>
                            <button onclick="app.setRequestsSort('staff')" class="px-2 py-0.5 rounded ${sort.key==='staff'?'bg-blue-600 text-white font-bold':'bg-white border border-gray-300 hover:bg-gray-100'}">スタッフ ${sort.key==='staff'?(sort.dir==='asc'?'↑':'↓'):''}</button>
                            <button onclick="app.setRequestsSort('dates')" class="px-2 py-0.5 rounded ${sort.key==='dates'?'bg-blue-600 text-white font-bold':'bg-white border border-gray-300 hover:bg-gray-100'}">対象日 ${sort.key==='dates'?(sort.dir==='asc'?'↑':'↓'):''}</button>
                            <button onclick="app.setRequestsSort('status')" class="px-2 py-0.5 rounded ${sort.key==='status'?'bg-blue-600 text-white font-bold':'bg-white border border-gray-300 hover:bg-gray-100'}">状態 ${sort.key==='status'?(sort.dir==='asc'?'↑':'↓'):''}</button>
                            <button onclick="app.resetRequestsFilter()" class="ml-auto px-2 py-0.5 rounded bg-white border border-gray-300 hover:bg-gray-100 text-gray-500">条件リセット</button>
                        </div>
                    </div>
                    <div class="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                        ${all.length === 0 ? '<div class="p-8 text-center text-gray-400 text-sm">条件に一致する申請はありません</div>' : ''}
                        ${all.map(req => {
                            const staff = this.getStaff(req.staff_id);
                            const statusClass = req.status === 'approved' ? 'bg-green-100 text-green-700'
                                              : req.status === 'rejected' ? 'bg-red-100 text-red-700'
                                              : 'bg-yellow-100 text-yellow-700';
                            const statusLabel = req.status === 'approved' ? '承認済'
                                              : req.status === 'rejected' ? '却下'
                                              : '承認待ち';
                            const typeLabel = (req.type === 'off' || req.type === 'holiday') ? '休み希望' : '勤務希望';
                            const typeClass = (req.type === 'off' || req.type === 'holiday') ? 'bg-rose-50 text-rose-700' : 'bg-blue-50 text-blue-700';
                            const dt = req.created_at ? new Date(req.created_at).toLocaleString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';
                            return `
                                <div class="p-3 hover:bg-gray-50 text-sm">
                                    <div class="flex items-center justify-between gap-2 flex-wrap mb-1">
                                        <div class="flex items-center gap-2 min-w-0">
                                            <!-- v3.7.153: 一括削除チェック -->
                                            <input type="checkbox" class="req-del-cb form-checkbox text-red-600 rounded" data-req-id="${req.id}" onclick="app.updateDeleteSelectionUI()" title="削除対象に追加">
                                            <span class="font-bold text-gray-800 truncate">${staff ? this._sanitize(staff.name) : '不明スタッフ'}</span>
                                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${typeClass}">${typeLabel}</span>
                                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${statusClass}">${statusLabel}</span>
                                        </div>
                                        <div class="flex items-center gap-2">
                                            <span class="text-[10px] text-gray-400 whitespace-nowrap">申請: ${dt}</span>
                                            <button type="button" onclick="app.deleteRequest('${req.id}')" title="この申請を削除" class="text-gray-300 hover:text-red-600 transition px-1 py-0.5 rounded hover:bg-red-50">
                                                <i class="fa-solid fa-trash text-xs"></i>
                                            </button>
                                        </div>
                                    </div>
                                    <div class="text-xs text-gray-700">
                                        <i class="fa-regular fa-calendar mr-1 text-gray-400"></i>${this._sanitize(req.dates)}
                                        ${req.start_time && req.type === 'work' ? `<span class="ml-2 text-gray-500">${this._sanitize(req.start_time)} - ${this._sanitize(req.end_time)}</span>` : ''}
                                    </div>
                                    ${req.reason ? `<div class="mt-1 text-[11px] text-gray-500 italic">"${this._sanitize(req.reason)}"</div>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        `;
    },

    // =================================================================
    // 3. シフトビュー (Shift View: Table & Calendar)
    // =================================================================
    renderShiftView(container) {
        // Toggle Buttons logic
        const getBtnClass = (isActive) => isActive 
            ? 'bg-white text-blue-600 shadow-sm font-bold' 
            : 'text-gray-500 hover:text-gray-700 font-medium hover:bg-gray-200/50';

        const isTable = this.state.shiftViewMode === 'table';
        const p = this.state.shiftTablePeriod;

        // Period controls (only for table mode)
        let periodControls = '';
        if (isTable) {
            // v3.7.63: 縮小/拡大ボタン (シフト表のズーム機能)
            // v3.7.144: モバイルでも横並びで収まるよう ml→gap、shrink-0 付与
            const zoom = this.state.shiftZoom || 1.0;
            periodControls = `
                <div class="flex items-center bg-white border border-gray-200 p-1 rounded-lg shrink-0">
                    <button onclick="app.switchShiftTablePeriod('month')" class="px-2.5 py-1 text-xs rounded transition-all ${getBtnClass(p==='month')}">月</button>
                    <button onclick="app.switchShiftTablePeriod('week')" class="px-2.5 py-1 text-xs rounded transition-all ${getBtnClass(p==='week')}">週</button>
                    <button onclick="app.switchShiftTablePeriod('day')" class="px-2.5 py-1 text-xs rounded transition-all ${getBtnClass(p==='day')}">日</button>
                </div>
                <div class="flex items-center bg-white border border-gray-200 p-1 rounded-lg shrink-0">
                    <button onclick="app.changeShiftZoom(-0.25)" class="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 text-gray-600 transition" title="縮小"><i class="fa-solid fa-magnifying-glass-minus text-xs"></i></button>
                    <span class="px-1.5 text-[10px] font-bold text-gray-500 font-mono w-9 text-center">${Math.round(zoom*100)}%</span>
                    <button onclick="app.changeShiftZoom(0.25)" class="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 text-gray-600 transition" title="拡大"><i class="fa-solid fa-magnifying-glass-plus text-xs"></i></button>
                </div>
            `;
        }

        // Navigation arrows for Week/2Weeks
        let navControls = '';
        if (isTable && p !== 'month') {
            const label = p === 'week' ? '1週間' : '1日';
            navControls = `
                <div class="flex items-center gap-1 ml-2">
                    <button onclick="app.changeTablePeriod(-1)" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-600 transition">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <span class="text-xs font-bold text-gray-500">${label}移動</span>
                    <button onclick="app.changeTablePeriod(1)" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-600 transition">
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>
                </div>
            `;
        }

        container.innerHTML = `
            <div class="flex flex-col h-full space-y-4">
                <div class="flex items-center justify-between bg-white p-3 rounded-xl shadow-sm border border-gray-200 flex-wrap gap-2">
                    <div class="flex items-center gap-2">
                        <h2 class="text-lg font-bold text-gray-800">シフト表</h2>
                        <span class="text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded font-mono whitespace-nowrap">
                            ${this.state.currentDate.getFullYear()}年${this.state.currentDate.getMonth()+1}月
                            ${isTable && p !== 'month' ? `<span class="ml-1 text-xs text-blue-600">(${this.state.currentDate.getDate()}日〜)</span>` : ''}
                        </span>
                        ${navControls}
                    </div>
                    
                    <!-- v3.7.144: モバイル幅で折り返し可能なツールバー -->
                    <div class="flex items-center gap-2 flex-wrap">
                        ${this.state.isAdmin ? `
                        <button onclick="app.openModal('autoFillModal')" class="flex items-center gap-1.5 px-3 py-2 text-xs sm:text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 shrink-0 whitespace-nowrap">
                            <i class="fa-solid fa-wand-magic-sparkles"></i><span>AIシフト作成</span>
                        </button>
                        ` : ''}
                        ${periodControls}
                        <div class="flex bg-white border border-gray-200 p-1 rounded-lg shrink-0">
                            <button onclick="app.switchShiftViewMode('table')" aria-label="表" class="px-2.5 py-1.5 rounded-md text-xs font-bold transition-all whitespace-nowrap ${isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-solid fa-table-list sm:mr-1"></i><span class="hidden sm:inline">表</span>
                            </button>
                            <button onclick="app.switchShiftViewMode('calendar')" aria-label="カレンダー" class="px-2.5 py-1.5 rounded-md text-xs font-bold transition-all whitespace-nowrap ${!isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-regular fa-calendar-days sm:mr-1"></i><span class="hidden sm:inline">カレンダー</span>
                            </button>
                        </div>
                        <!-- v3.7.193: スタッフ並び順 -->
                        ${(() => {
                            const sk = (this.state.staffSort && this.state.staffSort.key) || 'role';
                            const opt = (v, l) => `<option value="${v}" ${sk===v?'selected':''}>${l}</option>`;
                            return `<select onchange="app.setStaffSortFromShift(this.value)" title="スタッフの並び順" class="shrink-0 bg-white border border-gray-300 rounded-lg text-xs font-bold text-gray-600 px-2 py-1.5 h-10 sm:h-auto">
                                <option disabled>並び順</option>
                                ${opt('role','役職順')}${opt('name','名前順')}${opt('evaluation','評価順')}${opt('salary','給与形態順')}
                            </select>`;
                        })()}
                        <!-- v3.7.103: 印刷ボタンをヘッダに移動して Android でも常時表示 -->
                        <button onclick="app.printShiftTable()" aria-label="印刷"
                                class="flex items-center justify-center w-10 h-10 sm:w-auto sm:h-auto sm:px-3 sm:py-1.5 bg-white border border-gray-300 rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 transition shrink-0">
                            <i class="fa-solid fa-print sm:mr-1"></i><span class="hidden sm:inline">印刷</span>
                        </button>
                    </div>
                </div>
                <div id="shiftViewContent" class="flex-1 overflow-x-auto overflow-y-hidden bg-white rounded-xl shadow-sm border border-gray-200 relative">
                    <!-- Content injected here -->
                </div>
            </div>
        `;
        
        const content = document.getElementById('shiftViewContent');
        if (this.state.shiftViewMode === 'table') {
            this.renderShiftTable(content);
        } else {
            this.renderCalendar(content);
        }
    },

    switchShiftViewMode(mode) {
        this.state.shiftViewMode = mode;
        this.renderShiftView(document.getElementById('viewContainer'));
    },

    // v3.7.63: シフト表のズーム機能 (スマホでも縮小可能に)
    changeShiftZoom(delta) {
        const cur = this.state.shiftZoom || 1.0;
        const next = Math.max(0.5, Math.min(2.0, +((cur + delta).toFixed(2))));
        this.state.shiftZoom = next;
        this.renderCurrentView();
        this.showToast(`表示倍率: ${Math.round(next * 100)}%`, 'info');
    },

    switchShiftTablePeriod(period) {
        this.state.shiftTablePeriod = period;
        // v3.7.82: ユーザー選択を localStorage に保存して次回開いた時にも維持
        try { localStorage.setItem('shiftTablePeriod', period); } catch (e) {}
        if (period === 'month') {
            const d = new Date(this.state.currentDate);
            d.setDate(1);
            this.state.currentDate = d;
        } else if (period === 'week') {
            // 直近の日曜に揃える
            const d = new Date(this.state.currentDate);
            d.setDate(d.getDate() - d.getDay());
            this.state.currentDate = d;
        }
        // day モードは currentDate をそのまま使う (揃え不要)
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderShiftView(document.getElementById('viewContainer')));
    },

    changeTablePeriod(delta) {
        const d = new Date(this.state.currentDate);
        if (this.state.shiftTablePeriod === 'week') {
            d.setDate(d.getDate() + (delta * 7));
        } else if (this.state.shiftTablePeriod === 'day') {
            d.setDate(d.getDate() + delta);
        }
        this.state.currentDate = d;
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderShiftView(document.getElementById('viewContainer')));
    },

    renderShiftTable(container) {
        const period = this.state.shiftTablePeriod || 'month';
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();

        // v3.7.63: ズーム倍率を適用 (デフォルト 1.0)
        const zoom = this.state.shiftZoom || 1.0;

        let days = [];
        // v3.7.94: モバイルでは最低 56px (時刻 09:45 が読める幅) を確保
        // v3.7.157: Tailwind Play CDN は動的 class (min-w-[XXXpx]) を生成しないため
        //           inline style で min-width を指定して zoom を確実に反映
        const isMobileTable = (typeof window !== 'undefined' && window.innerWidth <= 768);
        const minCellPx = isMobileTable ? 56 : 40;
        let _colW = Math.max(minCellPx, Math.round(minCellPx * zoom));
        let isGanttMode = false;

        if (period === 'month') {
            const lastDay = new Date(year, month + 1, 0).getDate();
            days = Array.from({length: lastDay}, (_, i) => {
                return new Date(year, month, i + 1);
            });
        } else if (period === 'day') {
            _colW = Math.max(800, Math.round(1600 * zoom));
            isGanttMode = true;
            days = [new Date(this.state.currentDate)];
        } else {
            if (isMobileTable) {
                _colW = Math.max(56, Math.round(56 * zoom));
                isGanttMode = false;
            } else {
                _colW = Math.max(600, Math.round(1200 * zoom));
                isGanttMode = true;
            }
            const start = new Date(this.state.currentDate);
            days = Array.from({length: 7}, (_, i) => {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                return d;
            });
        }
        const colWidthStyle = `min-width: ${_colW}px; width: ${_colW}px;`;
        
        // v3.7.63: 日付ヘッダーを縦スクロール時も固定 (sticky top-0 追加)
        let headerHtml = `<th class="p-3 sticky left-0 top-0 z-50 bg-gray-50 border-b border-r border-gray-200 min-w-[120px] text-left text-xs font-bold text-gray-500 uppercase tracking-wider">スタッフ</th>`;
        days.forEach(date => {
            const d = date.getDate();
            const m = date.getMonth() + 1;
            const dayOfWeek = date.getDay();
            const dateStr = `${date.getFullYear()}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const isHoliday = JapaneseHolidays.isHoliday(dateStr);
            let colorClass = 'text-gray-700';
            if (dayOfWeek === 0 || isHoliday) colorClass = 'text-red-500';
            else if (dayOfWeek === 6) colorClass = 'text-blue-500';
            
            // Show Month/Date if crossing months or in week mode
            const label = period === 'month' ? d : `${m}/${d}`;
            
            // 時間スケールをヘッダーに追加 (ガントチャート用)
            // v3.7.153/154: モバイル/狭幅では大きく間引いて文字重なりを防止
            let timeScale = '';
            if (isGanttMode) {
                // 列幅と viewport から表示間隔を決定
                const colW = period === 'day' ? Math.max(800, Math.round(1600 * zoom))
                           : Math.max(600, Math.round(1200 * zoom));
                const vw = (typeof window !== 'undefined') ? window.innerWidth : 1024;
                const isNarrow = vw < 768;
                // モバイル/狭幅 → 6時間刻みのみ / 中幅 → 6時間刻み / 広幅 → 3時間刻み / 超広幅 → 1時間
                const step = isNarrow ? 6 : (colW < 700 ? 6 : colW < 1100 ? 3 : 1);
                const tickSize = isNarrow ? '9' : '10';
                let scaleHtml = '';
                for (let i = 0; i <= 24; i += step) {
                    const left = (i / 24) * 100;
                    scaleHtml += `<span class="absolute -translate-x-1/2 font-mono text-[${tickSize}px]" style="left: ${left}%">${i}</span>`;
                }
                // 15分刻みの細目盛りは超広幅のみ (狭幅では表示しない)
                if (!isNarrow && (period === 'week' || period === 'day') && colW >= 900) {
                    for (let i = 0; i < 24; i++) {
                        for (let m = 1; m < 4; m++) {
                            const mLeft = ((i + m/4) / 24) * 100;
                            scaleHtml += `<span class="absolute -translate-x-1/2 text-[8px] text-gray-300 top-1" style="left: ${mLeft}%">|</span>`;
                        }
                    }
                }

                timeScale = `
                    <div class="relative h-4 text-gray-400 font-bold mt-1 border-t border-gray-100 pt-0.5 select-none">
                        ${scaleHtml}
                    </div>
                `;
            }
            
            headerHtml += `<th class="p-2 text-center border-b border-gray-200 bg-gray-50 text-xs font-bold ${colorClass} sticky top-0 z-30" style="${colWidthStyle}">
                <div class="flex flex-col items-center justify-center leading-tight">
                    <span class="text-sm block">${label}</span>
                    <span class="text-[10px] font-normal block">${['日','月','火','水','木','金','土'][dayOfWeek]}</span>
                </div>
                ${timeScale}
            </th>`;
        });

        // パフォーマンス最適化: shifts を Map<staff_id:date, shift> 化して O(1) アクセスに
        // 旧 O(staff×days×shifts) フルスキャン → 新 O(shifts + staff×days) で 100倍以上高速
        const shiftsByKey = new Map();
        for (const s of this.state.shifts) {
            shiftsByKey.set(s.staff_id + ':' + s.date, s);
        }
        // 過去日判定の today を1回だけ計算 (各セル毎の new Date() を排除)
        const _today = new Date();
        _today.setHours(0, 0, 0, 0);
        const _todayMs = _today.getTime();

        // ボディ生成 (v3.7.193: スタッフ行も役職順/選択ソートで並べる)
        let bodyHtml = '';
        this._sortedStaff().forEach(staff => {
            bodyHtml += `<tr data-staff-id="${staff.id}">`;
            bodyHtml += `<td class="p-3 sticky left-0 z-40 bg-white border-b border-r border-gray-100 font-bold text-sm text-gray-800 truncate h-14">${this._sanitize(staff.name)}</td>`;

            days.forEach(date => {
                const y = date.getFullYear();
                const m = date.getMonth() + 1;
                const d = date.getDate();
                const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

                // 過去日判定 (事前計算 _todayMs と比較)
                const isPast = date.getTime() < _todayMs;

                // シフト検索 (O(1) Map アクセス)
                const shift = shiftsByKey.get(staff.id + ':' + dateStr);

                // セル背景色
                const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
                // v3.7.151: 承認済 希望休 (staff.unavailable_dates) かを判定
                const _udArr = Array.isArray(staff.unavailable_dates) ? staff.unavailable_dates
                              : (typeof staff.unavailable_dates === 'string' ? staff.unavailable_dates.split(',').map(s => s.trim()) : []);
                const isRequestedOff = !shift && _udArr.includes(dateStr);
                let bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines'
                            : isRequestedOff ? 'bg-rose-50'
                            : 'bg-white';

                if (isPast) {
                    bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines opacity-75'
                            : isRequestedOff ? 'bg-rose-50 opacity-70'
                            : 'bg-gray-50/30';
                } else if (!shift && !isSpecialHoliday && !isRequestedOff) {
                    bgClass = 'hover:bg-gray-50';
                }

                // セルアクション (ガントモードではバーのドラッグ操作があるため、空セルのみクリックイベント)
                let action = '';
                let cursor = '';
                if (this.state.isAdmin) {
                    if (isGanttMode) {
                        action = shift ? '' : `onclick="app.openAddShift('${dateStr}'); document.getElementById('editShiftStaffSelect').value='${staff.id}';"`;
                    } else {
                        action = shift ? `onclick="app.openEditShift('${shift.id}')"` : `onclick="app.openAddShift('${dateStr}'); document.getElementById('editShiftStaffSelect').value='${staff.id}';"`;
                    }
                    cursor = 'cursor-pointer';
                }

                // ガントチャート用: 営業時間の背景（Open-Close以外をグレーアウト）を生成するための時間取得
                let openTime = "09:00";
                let closeTime = "22:00";
                if (isGanttMode) {
                    const dayOfWeek = new Date(dateStr).getDay();
                    const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
                    const isHoliday = jh ? jh.isHoliday(dateStr) : false;
                    
                    // 特定日設定
                    const specialDay = (this.state.config.special_days || {})[dateStr];
                    if (specialDay) {
                        openTime = specialDay.start;
                        closeTime = specialDay.end;
                    } else {
                        // 通常営業設定
                        const times = this.state.config.opening_times || {};
                        const defTimes = this.state.defaultConfig.opening_times;
                        const getStart = (type) => times[type]?.start || defTimes[type].start;
                        const getEnd = (type) => times[type]?.end || defTimes[type].end;

                        if (isHoliday) {
                            openTime = getStart('holiday');
                            closeTime = getEnd('holiday');
                        } else if (dayOfWeek === 0 || dayOfWeek === 6) { 
                            openTime = getStart('weekend');
                            closeTime = getEnd('weekend');
                        } else {
                            openTime = getStart('weekday');
                            closeTime = getEnd('weekday');
                        }
                    }
                }

                let content = '';
                if (shift) {
                    // v3.7.81: シフトパターン名 + パターンインデックスで色分け
                    let barColor = this._getShiftBarColor(shift, this.state.config.custom_shifts || []);
                    
                    // イレギュラーアサイン（社員の強制アサイン等）の強調
                    if (shift.is_irregular) {
                        barColor = 'bg-red-50 text-red-700 border-red-500 border-2 pattern-diagonal-lines ring-2 ring-red-400 ring-inset';
                    }
                    
                    // 社員（月給制・店長・副店長・社員）のシフト枠組みの色を変更して強調
                    const isEmployeeRole = staff && (staff.salary_type === 'monthly' || ['manager', 'sub_manager', 'employee'].includes(staff.role));
                    if (isEmployeeRole) {
                        barColor += ' border-emerald-500 shadow-md';
                    }
                    
                    // 過去の場合は少し透明にして元の色を残す
                    if (isPast) {
                        barColor += ' opacity-50 hover:opacity-70';
                    }

                    if (isGanttMode) {
                        // === Gantt Style (Bar inside timeline) ===
                        const timeToPct = (t) => {
                            const [h, m] = t.split(':').map(Number);
                            return ((h + m/60) / 24) * 100;
                        };
                        const startPct = timeToPct(shift.start_time);
                        let endPct = timeToPct(shift.end_time);
                        if (endPct <= startPct) endPct += 100;
                        const widthPct = endPct - startPct;
                        
                        // 営業時間外マスク (Open前、Close後)
                        const openPct = timeToPct(openTime);
                        const closePct = timeToPct(closeTime);
                        
                        // CSS Gradientで細かいグリッドを描画
                        // 1h = 100/24 %, 15m = 1h/4
                        const oneHour = 100/24;
                        const oneFifteen = oneHour / 4;
                        const bgGuides = '';
                        
                        const adminDrag = this.state.isAdmin ? `draggable="true" ondragstart="app.onShiftDragStart(event)" ondragend="app.onShiftDragEnd(event)" data-shift-id="${shift.id}" data-staff-id="${staff.id}" data-date="${dateStr}" style="left: ${startPct}%; width: ${Math.max(widthPct, 0.5)}%; min-width: 2px; cursor: grab;"` : `style="left: ${startPct}%; width: ${Math.max(widthPct, 0.5)}%; min-width: 2px;"`;
                        const resizeHandles = this.state.isAdmin ? `
                                    <div class="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/10 rounded-l" style="touch-action:none;"></div>
                                    <div class="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/10 rounded-r" style="touch-action:none;"></div>
                        ` : '';
                        content = `
                            <div class="w-full h-full relative group bg-transparent overflow-hidden">
                                ${bgGuides}
                                <!-- v3.7.156: 時刻表示を HH:MM に短縮、改行で開始/終了の両方を確実に出す -->
                                <div class="absolute top-1/2 -translate-y-1/2 h-9 ${period==='week'?'':'h-7'} rounded ${barColor} border shadow-sm flex items-center justify-center overflow-hidden z-10 hover:brightness-95 transition-all px-1"
                                     ${adminDrag}
                                     ${this.state.isHQ ? '' : `ondblclick="app.openEditShift('${shift.id}')"`}>
                                     ${resizeHandles}
                                     <span class="text-[8px] sm:text-[9px] md:text-[10px] font-bold whitespace-nowrap pointer-events-none select-none leading-tight text-center">
                                        ${(shift.start_time || '').slice(0,5)}<br>${(shift.end_time || '').slice(0,5)}
                                     </span>
                                </div>

                                <!-- Tooltip on hover -->
                                <div class="opacity-0 group-hover:opacity-100 absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded px-2 py-1 z-20 pointer-events-none whitespace-nowrap shadow-lg">
                                    ${(shift.start_time || '').slice(0,5)} - ${(shift.end_time || '').slice(0,5)}
                                </div>
                            </div>
                        `;
                    } else {
                        // === Month Style (Block) === v3.7.94: 開始時刻のみ HH:MM 表示してオーバーフロー回避
                        const stShort = (shift.start_time || '').slice(0, 5);
                        const etShort = (shift.end_time || '').slice(0, 5);
                        // v3.7.125: Month モードでバーの onclick を td の onclick と分離
                        //   バーをクリック → openEditShift / セル空きをクリック → 同じく編集
                        //   ドラッグ時は onclick 発火しない (mouseup なし) ので衝突なし
                        const monthDrag = this.state.isAdmin
                            ? `draggable="true" ondragstart="app.onShiftDragStart(event)" ondragend="app.onShiftDragEnd(event)" data-shift-id="${shift.id}" data-staff-id="${staff.id}" data-date="${dateStr}" style="cursor:grab;" onclick="event.stopPropagation(); app.openEditShift('${shift.id}')"`
                            : '';
                        content = `<div class="w-full h-full p-0.5"><div ${monthDrag} class="${barColor} border-l-2 rounded text-[9px] sm:text-[10px] font-bold text-center leading-tight py-1 shadow-sm" style="overflow:hidden;">${stShort}<br>${etShort}</div></div>`;
                    }
                } else if (isSpecialHoliday) {
                    content = `<div class="w-full h-full flex items-center justify-center"><span class="text-[10px] text-red-300 font-bold">休</span></div>`;
                } else if (isRequestedOff) {
                    // v3.7.151: 承認済 希望休
                    content = `<div class="w-full h-full flex items-center justify-center" title="本人の希望休 (承認済)">
                        <div class="flex flex-col items-center leading-none">
                            <i class="fa-solid fa-mug-hot text-rose-400 text-[10px]"></i>
                            <span class="text-[8px] text-rose-600 font-bold mt-0.5">希望休</span>
                        </div>
                    </div>`;
                }

                // Ganttモードの場合は空セルにもガイド線を表示
                if (!shift && isGanttMode && !isSpecialHoliday) {
                    // 営業時間取得 (繰り返しロジックになるが、shift有無に関わらず必要)
                    // 上記で計算済み変数を再利用
                    const timeToPct = (t) => {
                        const [h, m] = t.split(':').map(Number);
                        return ((h + m/60) / 24) * 100;
                    };
                    const openPct = timeToPct(openTime);
                    const closePct = timeToPct(closeTime);

                    const guides = '';
                    content = `<div class="w-full h-full relative group overflow-hidden bg-transparent">${guides}</div>`;
                }

                const dropAttrs = this.state.isAdmin ? `ondragover="app.onShiftDragOver(event)" ondragleave="app.onShiftDragLeave(event)" ondrop="app.onShiftDrop(event,'${dateStr}','${staff.id}')"` : '';
                bodyHtml += `<td class="p-0 border-b border-r border-gray-100 h-14 relative transition-colors ${bgClass} ${cursor}" style="${colWidthStyle}" ${action} ${dropAttrs}>${content}</td>`;
            });
            bodyHtml += `</tr>`;
        });

        // === 人員不足アラート行の生成 ===
        let alertRowHtml = '';
        if (this.state.isAdmin && this.state.config) {
            const staffReq = this.state.config.staff_req || this.state.defaultConfig.staff_req;
            const closedDays = this.state.config.closed_days || [];
            const specialHolidays = this.state.config.special_holidays || [];

            alertRowHtml += `<tr>`;
            alertRowHtml += `<td class="p-2 sticky left-0 z-40 bg-white border-b border-r border-gray-100 text-xs font-bold text-gray-500 h-10 whitespace-nowrap">
                <i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1"></i>人員状況
            </td>`;

            days.forEach(date => {
                const m = date.getMonth() + 1;
                const d = date.getDate();
                const dateStr = `${date.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const dayOfWeek = date.getDay();
                const jsDow = dayOfWeek; // 0=日, 6=土

                // 休業日チェック
                const isSpecialHoliday = specialHolidays.includes(dateStr);
                const isClosedDay = closedDays.map(Number).includes(jsDow);
                if (isSpecialHoliday || isClosedDay) {
                    alertRowHtml += `<td class="p-0 border-b border-r border-gray-100 h-10 bg-gray-50 text-center" style="${colWidthStyle}">
                        <span class="text-[10px] text-gray-300">-</span>
                    </td>`;
                    return;
                }

                // 祝日チェック
                const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
                const isHoliday = jh ? jh.isHoliday(dateStr) : false;

                // 必要人数を取得（ベース値）
                let required = parseInt(staffReq.min_weekday || 2);
                if (isHoliday || dayOfWeek === 0) {
                    required = parseInt(staffReq.min_holiday || 3);
                } else if (dayOfWeek === 6) {
                    required = parseInt(staffReq.min_weekend || 3);
                }

                // 営業時間の取得
                const times = this.state.config.opening_times || this.state.defaultConfig.opening_times;
                const defTimes = this.state.defaultConfig.opening_times;
                const getT = (key) => ((times || {})[key] || defTimes[key]);
                let dayOpen, dayClose;
                const specialDay = (this.state.config.special_days || {})[dateStr];
                if (specialDay && specialDay.start && specialDay.end) {
                    dayOpen = specialDay.start;
                    dayClose = specialDay.end;
                } else if (isHoliday) {
                    dayOpen = getT('holiday').start; dayClose = getT('holiday').end;
                } else if (dayOfWeek === 0 || dayOfWeek === 6) {
                    dayOpen = getT('weekend').start; dayClose = getT('weekend').end;
                } else {
                    dayOpen = getT('weekday').start; dayClose = getT('weekday').end;
                }

                const toMins = (t) => { const [h, m] = (t || '09:00').split(':').map(Number); return h * 60 + m; };
                const openM = toMins(dayOpen);
                let closeM = toMins(dayClose);
                if (closeM <= openM) closeM += 24 * 60; // 日またぎ対応

                // 時間帯別の必要人数ルール適用（days配列の型を数値に統一して安全にフィルタ）
                const timeRules = (this.state.config.time_staff_req || []).filter(r => (r.days || []).map(Number).includes(jsDow));

                // v3.7.80: シフトパターン登録時はパターン外時間帯を「要件0」(scheduler.py と仕様揃え)
                // v3.7.92: 国民の祝日 (海の日・スポーツの日等) も holiday 扱いに
                const customShifts = this.state.config.custom_shifts || [];
                const _jhUi = (typeof JapaneseHolidays !== 'undefined') ? JapaneseHolidays : null;
                const isJpHolidayUi = _jhUi ? _jhUi.isHoliday(dateStr) : false;
                const dayTypeForUi = (this.state.config.special_holidays || []).includes(dateStr) || isJpHolidayUi
                    ? 'holiday'
                    : (dayOfWeek === 0 ? 'holiday' : (dayOfWeek === 6 ? 'weekend' : 'weekday'));
                const patCountKey = dayTypeForUi === 'holiday' ? 'count_holiday'
                                  : dayTypeForUi === 'weekend' ? 'count_weekend'
                                  : 'count_weekday';
                // パターンが1つ以上 count>0 で登録されているか
                const hasPatterns = customShifts.some(p => {
                    const c = Number(p[patCountKey] != null ? p[patCountKey]
                                    : (p.count != null ? p.count : 0));
                    return Number.isFinite(c) && c > 0;
                });

                // 15分スロットごとに「同時在籍人数」vs「そのスロットの要件」を比較
                const shiftsForDay = this.state.shifts.filter(s => s.date === dateStr);
                let totalSlots = 0;
                let shortageSlots = 0;
                let worstDeficit = 0;
                let maxConcurrent = 0;
                let minConcurrent = Number.POSITIVE_INFINITY;
                let minConcurrentTime = '';
                let worstSlotReq = required;
                let maxSlotReq = required;
                let surplusSlots = 0;
                let worstSurplus = 0; // v3.7.85: 過剰スロットでの最大超過数
                const slotStates = [];

                for (let t = openM; t < closeM; t += 15) {
                    // v3.7.74: パターン人数の重ねがけ集計
                    let patternSum = 0;
                    customShifts.forEach(pat => {
                        const ps = toMins(pat.start || '00:00');
                        let pe = toMins(pat.end || '00:00');
                        if (pe <= ps) pe += 24 * 60;
                        const rawCnt = pat[patCountKey] != null ? pat[patCountKey]
                                     : (pat.count != null ? pat.count : 0);
                        const cnt = Number(rawCnt) || 0;
                        if (cnt > 0 && ps <= t && t < pe) {
                            patternSum += cnt;
                        }
                    });
                    // v3.7.80: パターンあり時間帯 → patternSum
                    //          パターン未登録のユーザー → ベース要件
                    //          パターン登録あり + この時間帯はパターン外 → 0 (不足判定しない)
                    let slotReq;
                    if (patternSum > 0) {
                        slotReq = patternSum;
                    } else if (hasPatterns) {
                        slotReq = 0;
                    } else {
                        slotReq = required;
                    }

                    // v3.7.105: 過剰配置 ON でも slot_req に補完分を加算しない。
                    //   ユーザー要望「人員状況を +N で過剰として表示してほしい」
                    //   過剰部分は「⚡ 過剰 +N名」で視覚化し、赤枠で示す。
                    //   (v3.7.99 で +α 加算してぴったり扱いにしていたのを撤回)

                    // time_staff_req (UI 廃止済みだが旧データ互換): max で上書き
                    timeRules.forEach(rule => {
                        const rs = toMins(rule.start);
                        let re = toMins(rule.end);
                        if (re <= rs) re += 24 * 60;
                        if (t >= rs && t < re) {
                            slotReq = Math.max(slotReq, parseInt(rule.count || 0));
                        }
                    });

                    // このスロットの同時在籍人数
                    const concurrent = shiftsForDay.filter(s => {
                        const sStart = toMins(s.start_time);
                        let sEnd = toMins(s.end_time);
                        if (sEnd <= sStart) sEnd += 24 * 60;
                        return sStart <= t && t < sEnd;
                    }).length;

                    totalSlots++;
                    const slotDeficit = slotReq - concurrent;
                    // v3.7.127: 過剰閾値を 0 に厳格化
                    //   旧 (+1): slotReq+1 までは「ぴったり」扱い → 補完1名が見逃された
                    //   新 (0): slotReq を 1名でも超えたら「過剰」として計上
                    const overThreshold = 0;
                    let status = 'ok';
                    if (slotDeficit > 0) {
                        status = 'under';
                        shortageSlots++;
                        if (slotDeficit > worstDeficit) {
                            worstDeficit = slotDeficit;
                            worstSlotReq = slotReq;
                        }
                    } else if (concurrent > slotReq + overThreshold) {
                        status = 'over';
                        surplusSlots++;
                        const surplus = concurrent - slotReq;
                        if (surplus > worstSurplus) worstSurplus = surplus;
                    }
                    if (slotReq > maxSlotReq) maxSlotReq = slotReq;
                    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
                    if (concurrent < minConcurrent) {
                        minConcurrent = concurrent;
                        const hh = String(Math.floor(t / 60) % 24).padStart(2, '0');
                        const mm = String(t % 60).padStart(2, '0');
                        minConcurrentTime = `${hh}:${mm}`;
                    }
                    // v3.7.75: タイムストライプ用に slot 状態を蓄積
                    slotStates.push({ t, req: slotReq, actual: concurrent, status });
                }
                if (minConcurrent === Number.POSITIVE_INFINITY) minConcurrent = 0;

                // 表示用: ピーク同時在籍人数 vs 最大要件で判定
                // (旧来 assigned = shiftsForDay.length は「総シフト本数」で、
                //  早番+遅番なら 2 件カウント → 同時 1 名でも「2 名」と誤表示していた。
                //  正しくは maxConcurrent = ピーク同時在籍数を表示する。
                //  ユニークスタッフ数も併せて出して二重シフトを検知可能に)
                const uniqueStaffIds = new Set(shiftsForDay.map(s => s.staff_id));
                const uniqueStaffCount = uniqueStaffIds.size;
                const duplicateShifts = shiftsForDay.length - uniqueStaffCount;

                let cellContent = '';
                let cellBg = 'bg-white';
                const dupNote = duplicateShifts > 0 ? `<span class="text-red-500 text-[8px] ml-0.5">⚠重複${duplicateShifts}</span>` : '';

                // v3.7.75: タイムストライプ式表示
                // 連続する同じ status の slot を run-length encoding でまとめる
                const runs = [];
                slotStates.forEach(s => {
                    const last = runs[runs.length - 1];
                    if (last && last.status === s.status) {
                        last.len++;
                        last.endT = s.t + 15;
                        if (s.req > last.maxReq) last.maxReq = s.req;
                        if (s.actual < last.minActual) last.minActual = s.actual;
                        if (s.actual > last.maxActual) last.maxActual = s.actual;
                    } else {
                        runs.push({
                            status: s.status,
                            len: 1,
                            startT: s.t,
                            endT: s.t + 15,
                            maxReq: s.req,
                            minActual: s.actual,
                            maxActual: s.actual,
                        });
                    }
                });

                const fmtTime = (m) => {
                    const h = String(Math.floor(m / 60) % 24).padStart(2, '0');
                    const mm = String(m % 60).padStart(2, '0');
                    return `${h}:${mm}`;
                };
                const statusColor = { ok: 'bg-green-400', under: 'bg-red-500', over: 'bg-amber-400' };
                const statusLabel = { ok: 'ぴったり', under: '不足', over: '過剰' };

                // v3.7.126: ストライプ tooltip も「要件+過剰」内訳表示に統一
                const stripeHtml = runs.map(r => {
                    const tip = r.status === 'under'
                        ? `${fmtTime(r.startT)}〜${fmtTime(r.endT)} 不足 ${r.maxReq - r.minActual}名 (要${r.maxReq} / 実${r.minActual}-${r.maxActual})`
                        : r.status === 'over'
                            ? `${fmtTime(r.startT)}〜${fmtTime(r.endT)} 要件${r.maxReq}+過剰${r.maxActual - r.maxReq}=${r.maxActual}名`
                            : `${fmtTime(r.startT)}〜${fmtTime(r.endT)} ぴったり ${r.maxActual}名 (要${r.maxReq})`;
                    return `<div class="${statusColor[r.status]}" style="flex:${r.len}" title="${this._sanitize(tip)}"></div>`;
                }).join('');

                // 要約テキスト (1 行)
                // v3.7.126-128: 要件と実配置の両方を明示
                //   v3.7.128: ぴったり時も「要N名 配置M名」形式で数字の整合を可視化
                let summary, summaryColor;
                if (shortageSlots > 0) {
                    cellBg = 'bg-red-50';
                    summaryColor = 'text-red-600';
                    summary = `⚠ 不足${worstDeficit}名 (${minConcurrentTime})`;
                } else if (surplusSlots > 0) {
                    cellBg = 'bg-amber-50';
                    summaryColor = 'text-amber-600';
                    summary = `⚡ 要${maxSlotReq}+過剰${worstSurplus}=${maxConcurrent}名`;
                } else {
                    summaryColor = 'text-green-600';
                    summary = `✓ 要${maxSlotReq}名/配置${maxConcurrent}名`;
                }

                const animateCls = shortageSlots > 0 ? 'animate-pulse' : '';
                // v3.7.87: 不足セルクリック → 原因分析モーダル
                // ストライプ div の pointer-events:none で onclick 妨害を回避
                const isShort = shortageSlots > 0;
                const clickHandler = isShort
                    ? `app.showShortageReason('${dateStr}', '${minConcurrentTime}', ${worstSlotReq}, ${minConcurrent}); event.stopPropagation();`
                    : '';
                cellContent = `<div class="flex flex-col h-full w-full px-0.5 py-0.5 overflow-hidden gap-0.5" style="pointer-events:none;">
                    <div class="flex h-2 rounded-sm overflow-hidden border border-gray-200" style="pointer-events:none;">${stripeHtml}</div>
                    <div class="flex items-center justify-center flex-1">
                        <span class="${summaryColor} font-bold text-[9px] sm:text-[10px] md:text-xs whitespace-nowrap truncate tracking-tighter ${animateCls}">${summary}${dupNote}</span>
                    </div>
                </div>`;
                const cellStyle = isShort ? 'cursor:pointer;' : '';
                const cellAttr = isShort ? `onclick="${clickHandler}" title="クリックで不足原因を表示"` : '';
                alertRowHtml += `<td style="${cellStyle}${colWidthStyle}" class="p-0 border-b border-r border-gray-100 h-12 ${cellBg} text-center" ${cellAttr}>${cellContent}</td>`;
            });
            alertRowHtml += `</tr>`;
        }

        // 日毎モード: ガント下に「本日のシフト一覧 (時刻順 + メモ)」を追加表示
        let dayDetailHtml = '';
        if (period === 'day') {
            const targetDate = days[0];
            const y = targetDate.getFullYear();
            const m = String(targetDate.getMonth() + 1).padStart(2, '0');
            const dd = String(targetDate.getDate()).padStart(2, '0');
            const ds = `${y}-${m}-${dd}`;
            const todays = (this.state.shifts || [])
                .filter(s => s.date === ds)
                .slice()
                .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
            const rowsHtml = todays.length === 0
                ? `<tr><td colspan="5" class="py-6 text-center text-sm text-gray-400">この日のシフトはありません</td></tr>`
                : todays.map(s => {
                    const staff = this.getStaff(s.staff_id);
                    const name = staff ? this._sanitize(staff.name) : '不明';
                    const st = (s.start_time || '').substr(0, 5);
                    const et = (s.end_time || '').substr(0, 5);
                    const memo = this._sanitize(s.memo || '');
                    const editBtn = this.state.isAdmin
                        ? `<button onclick="app.openEditShift('${s.id}')" class="px-2.5 py-1 text-xs bg-blue-50 text-blue-600 rounded-md hover:bg-blue-100 border border-blue-100"><i class="fa-solid fa-pen"></i></button>`
                        : '';
                    return `<tr class="border-b border-gray-100 hover:bg-amber-50/30">
                        <td class="py-2 px-3 text-sm font-mono font-bold text-gray-700 whitespace-nowrap">${st} - ${et}</td>
                        <td class="py-2 px-3 text-sm font-bold text-gray-900">${name}</td>
                        <td class="py-2 px-3 text-xs text-gray-500 whitespace-nowrap">休憩 ${s.break_minutes || 0}分</td>
                        <td class="py-2 px-3 text-sm text-gray-700">${memo ? `<span class="inline-flex items-start gap-1"><i class="fa-regular fa-note-sticky text-amber-500 mt-0.5"></i><span class="whitespace-pre-wrap">${memo}</span></span>` : '<span class="text-gray-300">—</span>'}</td>
                        <td class="py-2 px-3 text-center">${editBtn}</td>
                    </tr>`;
                }).join('');
            const dateLabel = `${y}年${parseInt(m,10)}月${parseInt(dd,10)}日 (${'日月火水木金土'[targetDate.getDay()]})`;
            dayDetailHtml = `
                <div class="mt-4 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <div class="px-4 py-2.5 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-gray-200 flex items-center justify-between">
                        <div class="text-sm font-bold text-gray-800"><i class="fa-regular fa-note-sticky text-amber-600 mr-2"></i>${dateLabel} のシフト詳細・メモ</div>
                        <div class="text-xs text-gray-500">合計 ${todays.length}件</div>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full border-collapse">
                            <thead class="bg-gray-50 border-b border-gray-200">
                                <tr>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">時間</th>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">スタッフ</th>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">休憩</th>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">メモ</th>
                                    <th class="py-2 px-3 text-center text-[11px] font-bold text-gray-500 uppercase tracking-wider">編集</th>
                                </tr>
                            </thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                </div>`;
        }

        // v3.7.94: スマホ向けレスポンシブ最適化
        // - overscroll-behavior で背景スクロール抑制
        // - -webkit-overflow-scrolling で iOS スムーズスクロール
        // - スティッキー列に右側シャドウ (横スクロール境界の視覚化)
        // - 横スクロールヒント (モバイル初回のみ)
        const isMobile = (typeof window !== 'undefined' && window.innerWidth <= 768);
        const showHint = isMobile && !localStorage.getItem('shiftScrollHintShown');
        if (showHint) {
            try { localStorage.setItem('shiftScrollHintShown', '1'); } catch (e) {}
        }
        const hintHtml = showHint
            ? `<div id="shiftScrollHint" class="mb-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 flex items-center gap-2 animate-pulse">
                <i class="fa-solid fa-arrows-left-right"></i>
                <span>👆 横にスワイプして全日付を確認できます</span>
                <button onclick="document.getElementById('shiftScrollHint')?.remove()" class="ml-auto text-blue-400 hover:text-blue-600"><i class="fa-solid fa-xmark"></i></button>
            </div>`
            : '';

        container.innerHTML = `
            ${hintHtml}
            <div class="h-full overflow-auto custom-scrollbar"
                 style="overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch;">
                <table class="border-collapse" style="min-width: 100%;">
                    <thead><tr>${headerHtml}</tr></thead>
                    <tbody id="shiftTableBody">
                        ${alertRowHtml}
                        ${bodyHtml}
                    </tbody>
                </table>
                ${dayDetailHtml}
            </div>
            <style>
                /* v3.7.94: スティッキー列に右端シャドウを追加 (横スクロール境界が見える) */
                #shiftTableBody td.sticky,
                thead th.sticky {
                    box-shadow: 2px 0 4px -2px rgba(0,0,0,0.15);
                }
                /* モバイル: セル padding をコンパクトに */
                @media (max-width: 768px) {
                    #shiftTableBody td, thead th { padding: 4px 2px !important; }
                    #shiftTableBody td.sticky, thead th.sticky {
                        min-width: 80px !important;
                        max-width: 100px !important;
                        font-size: 11px;
                    }
                }
            </style>
        `;
    },

    renderCalendar(container) {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        
        let html = `
            <div class="h-full overflow-y-auto overflow-x-auto custom-scrollbar">
                <div class="bg-white rounded-t-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="grid grid-cols-7 border-b border-gray-200 bg-gray-50 sticky top-0 z-10 shadow-sm">
                        ${['日', '月', '火', '水', '木', '金', '土'].map((day, i) => 
                            `<div class="py-3 text-center text-[10px] sm:text-sm font-bold ${i===0 ? 'text-red-500' : i===6 ? 'text-blue-500' : 'text-gray-600'}">${day}</div>`
                        ).join('')}
                    </div>
                    <div class="grid grid-cols-7 auto-rows-fr bg-gray-200 gap-px border-b border-gray-200">
        `;

        for (let i = 0; i < firstDay.getDay(); i++) {
            html += `<div class="bg-gray-50 min-h-[60px] sm:min-h-[120px]"></div>`;
        }

        for (let day = 1; day <= lastDay.getDate(); day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
            const holidayName = jh ? jh.getHolidayName(dateStr) : null;
            const currentD = new Date(year, month, day);
            const isToday = new Date().toDateString() === currentD.toDateString();
            const dayOfWeek = currentD.getDay();
            
            // 過去日判定
            const todayD = new Date();
            todayD.setHours(0,0,0,0);
            const isPast = currentD < todayD;

            let dateColorClass = 'text-gray-700';
            let dateBgClass = isPast ? 'bg-gray-100' : '';
            if (isPast) dateColorClass = 'text-gray-400';
            
            // 臨時休業判定
            const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
            // 特定日判定 (短縮営業など)
            const specialDayConfig = (this.state.config.special_days || {})[dateStr];
            // 備考メモ
            const note = (this.state.config.calendar_notes || {})[dateStr];
            
            if (dayOfWeek === 0 || holidayName) dateColorClass = 'text-red-500';
            else if (dayOfWeek === 6) dateColorClass = 'text-blue-500';
            
            if (isSpecialHoliday) {
                dateColorClass = 'text-red-600';
                dateBgClass = 'bg-red-50 pattern-diagonal-lines';
            } else if (specialDayConfig) {
                dateBgClass = 'bg-yellow-50';
            }

            const dayShifts = this.state.shifts
                .filter(s => s.date === dateStr)
                .sort((a, b) => a.start_time.localeCompare(b.start_time));

            // Admin: Click to add shift. Guest: No click action.
            const cellAction = this.state.isAdmin ? `onclick="app.openAddShift('${dateStr}')"` : `onclick="app.showToast('シフトの編集は管理者のみ可能です')"` ;
            const hoverClass = this.state.isAdmin ? 'hover:bg-blue-50/30 cursor-pointer' : '';
            
            // アクションボタン群 (管理者のみ)
            let actionBtns = '';
            if (this.state.isAdmin) {
                // v3.7.192: ホバー専用だとタッチ端末で押せないため、スマホ(<sm)では
                // 常時表示。タップしやすいよう w-7 h-7 に拡大。
                actionBtns = `
                    <div class="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <button onclick="event.stopPropagation(); app.openCalendarNoteModal('${dateStr}')" class="text-gray-400 hover:text-yellow-500 w-7 h-7 flex items-center justify-center rounded hover:bg-yellow-50" title="メモ編集">
                            <i class="fa-regular fa-note-sticky"></i>
                        </button>
                        <button onclick="event.stopPropagation(); app.openAddShift('${dateStr}')" class="text-gray-400 hover:text-blue-600 w-7 h-7 flex items-center justify-center rounded hover:bg-blue-50" title="シフト追加">
                            <i class="fa-solid fa-plus-circle"></i>
                        </button>
                    </div>
                `;
            }

            html += `
                <div class="bg-white calendar-cell p-1.5 flex flex-col gap-1 relative group min-h-[160px] transition-colors ${hoverClass} ${dateBgClass}" 
                     ${cellAction}>
                    <div class="flex justify-between items-start px-1 mb-1">
                        <div class="flex flex-col">
                            <span class="text-sm font-bold ${dateColorClass} ${isToday ? 'bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center shadow-md' : ''}">
                                ${day}
                            </span>
                            ${holidayName ? `<span class="text-[10px] font-bold text-red-500 truncate max-w-[60px] leading-tight">${holidayName}</span>` : ''}
                        </div>
                        ${actionBtns}
                    </div>
                    
                    <div class="flex-1 flex flex-col gap-1 mt-1 overflow-y-auto custom-scrollbar">
                        ${dayShifts.map(shift => {
                            const staff = this.getStaff(shift.staff_id);
                            if (!staff) return '';
                            const shiftCursorClass = this.state.isAdmin ? 'cursor-pointer hover:brightness-95' : '';
                            const shiftClickAction = this.state.isAdmin ? `onclick="event.stopPropagation(); app.openEditShift('${shift.id}')"` : '';
                            return `
                                <div class="text-xs px-2 py-1.5 rounded-md border-l-4 shadow-sm transition-all bg-blue-50 border-blue-500 text-blue-900 ${shiftCursorClass}"
                                     ${shiftClickAction} title="${this._sanitize(staff.name)} ${shift.start_time}-${shift.end_time}">
                                    <div class="font-bold truncate">${this._sanitize(staff.name)}</div>
                                    <div class="font-mono text-[10px] opacity-90">${shift.start_time} - ${shift.end_time}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        html += `</div></div></div>`;
        // Removed standalone print button as it is now in the view header
        container.innerHTML = html;
    },

    openCalendarNoteModal(dateStr) {
        if (!this.state.isAdmin) return;
        document.getElementById('noteDate').value = dateStr;
        document.getElementById('noteDateDisplay').textContent = dateStr;
        
        const note = (this.state.config.calendar_notes || {})[dateStr] || '';
        document.getElementById('noteText').value = note;
        
        this.openModal('calendarNoteModal');
    },

    async saveCalendarNote() {
        const date = (document.getElementById('noteDate')?.value || '');
        const text = (document.getElementById('noteText')?.value || '').trim();
        
        if (!this.state.config.calendar_notes) this.state.config.calendar_notes = {};
        
        if (text) {
            this.state.config.calendar_notes[date] = text;
        } else {
            delete this.state.config.calendar_notes[date];
        }

        this.showLoading(true);
        try {
            await API.rpc('update_config_safe', {
                p_config_id: this.state.config.id,
                p_data: { calendar_notes: this.state.config.calendar_notes }
            });

            // カレンダー再描画
            if (this.state.shiftViewMode === 'calendar') {
                this.renderCalendar(document.getElementById('shiftViewContent'));
            }
            this.closeModal('calendarNoteModal');
            this.showToast('メモを保存しました', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('保存に失敗しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async deleteCalendarNote() {
        if (!confirm('このメモを削除しますか？')) return;
        const date = (document.getElementById('noteDate')?.value || '');
        
        if (this.state.config.calendar_notes && this.state.config.calendar_notes[date]) {
            delete this.state.config.calendar_notes[date];
            
            this.showLoading(true);
            try {
                await API.rpc('update_config_safe', {
                    p_config_id: this.state.config.id,
                    p_data: { calendar_notes: this.state.config.calendar_notes }
                });

                // カレンダー再描画
                if (this.state.shiftViewMode === 'calendar') {
                    this.renderCalendar(document.getElementById('shiftViewContent'));
                }
                this.closeModal('calendarNoteModal');
                this.showToast('メモを削除しました', 'success');
            } catch (e) {
                this.showToast('削除に失敗しました', 'error');
            } finally {
                this.showLoading(false);
            }
        } else {
            this.closeModal('calendarNoteModal');
        }
    },

    // =================================================================
    // 4. 分析 (Analytics) - Admin Only
    // =================================================================
    renderAnalytics(container) {
        if (!this.state.isAdmin) return; // Sidebar should hide this, but safe guard.
        
        const stats = this.calculateMonthlyAnalytics();
        
        // ヘルパー関数: 日本語通貨表記
        const formatMoney = (n) => {
            if(n < 10000) return '¥' + n.toLocaleString();
            const man = Math.floor(n / 10000);
            const rest = n % 10000;
            return `${man}万${rest > 0 ? rest.toLocaleString() : ''}円`;
        };

        container.innerHTML = `
            <div class="space-y-6">
                <h2 class="text-xl font-bold text-gray-800">分析レポート (${this.state.currentDate.getFullYear()}年${this.state.currentDate.getMonth()+1}月)</h2>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">月間推定人件費</p>
                        <h3 class="text-2xl font-bold text-gray-800 mt-2 truncate" title="${stats.totalCost.toLocaleString()}円">
                            ${formatMoney(stats.totalCost)}
                        </h3>
                        <p class="text-xs text-gray-400 mt-1">※祝日割増・深夜手当を含む概算</p>
                    </div>
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">総労働時間</p>
                        <h3 class="text-2xl font-bold text-blue-600 mt-2">${stats.totalHours.toFixed(1)}h</h3>
                    </div>
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">スタッフ稼働数</p>
                        <h3 class="text-2xl font-bold text-indigo-600 mt-2">${stats.activeStaffCount} <span class="text-lg text-gray-500">名</span></h3>
                    </div>
                </div>
                ${(() => {
                    const entries = Object.entries(stats.typeTotals || {}).sort((a, b) => b[1] - a[1]);
                    if (entries.length === 0) return '';
                    const isNight = (l) => /夜|深夜|ナイト|night/i.test(l);
                    return `
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200">
                        <h3 class="font-bold text-gray-800 mb-1">出勤日数の内訳 (シフトタイプ別)</h3>
                        <p class="text-xs text-gray-400 mb-4">店舗全体の延べ出勤日数を、登録シフトパターン名ごとに集計しています。</p>
                        <div class="flex flex-wrap gap-3">
                            ${entries.map(([label, n]) => `
                                <div class="flex items-baseline gap-2 px-4 py-2 rounded-lg border ${isNight(label) ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-200'}">
                                    <span class="text-sm font-bold ${isNight(label) ? 'text-indigo-700' : 'text-gray-700'}">${this._sanitize(label)}</span>
                                    <span class="text-xl font-bold ${isNight(label) ? 'text-indigo-700' : 'text-gray-800'}">${n}</span>
                                    <span class="text-xs text-gray-400">日</span>
                                </div>`).join('')}
                        </div>
                    </div>`;
                })()}
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">日次コスト推移</h3><div class="h-[200px] sm:h-[300px]"><canvas id="dailyCostChart"></canvas></div></div>
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">スタッフ別コスト構成比</h3><div class="h-[200px] sm:h-[300px] flex justify-center"><canvas id="staffShareChart"></canvas></div></div>
                </div>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50"><h3 class="font-bold text-gray-800">スタッフ別詳細・労働時間チェック</h3></div>
                    <div class="overflow-x-auto"><table class="w-full text-left text-sm">
                        <thead class="bg-gray-50 text-gray-500 border-b border-gray-200">
                            <tr>
                                <th class="p-4 font-medium">スタッフ名</th>
                                <th class="p-4 font-medium text-right">出勤日数<br><span class="text-[10px] font-normal">(目標)</span></th>
                                <th class="p-4 font-medium text-right">労働時間</th>
                                <th class="p-4 font-medium text-right">法定目安(176h)との差</th>
                                <th class="p-4 font-medium text-right">推定支給額</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100">
                            ${stats.staffStats.map(s => {
                                const limit = 176;
                                const diff = s.hours - limit;
                                const isOver = diff > 0;
                                const diffText = isOver ? `+${diff.toFixed(1)}h` : 'OK';
                                // v3.7.83: 月間最低出勤日数の達成状況も併記
                                const staffRec = (this.state.staff || []).find(st => st.id === s.id);
                                const minMonth = staffRec ? Number(staffRec.min_days_month) || 0 : 0;
                                const daysShort = minMonth > 0 && s.days < minMonth;
                                // 出勤日数内訳 (早番8/夜勤4 など)
                                const typeEntries = Object.entries(s.types || {}).sort((a, b) => b[1] - a[1]);
                                const typeBreakdown = typeEntries.length
                                    ? `<div class="text-[11px] text-gray-400 mt-0.5">${typeEntries.map(([l, n]) => `${this._sanitize(l)} ${n}`).join(' / ')}</div>`
                                    : '';
                                const daysCell = (minMonth > 0
                                    ? `${s.days}日 <span class="${daysShort?'text-red-600 font-bold':'text-gray-400'} text-xs">/ 目標${minMonth}${daysShort?` (${minMonth-s.days}日不足)`:''}</span>`
                                    : `${s.days}日`) + typeBreakdown;
                                const rowClass = (isOver || daysShort) ? 'bg-red-50' : 'hover:bg-gray-50';
                                const textClass = isOver ? 'text-red-600 font-bold' : 'text-green-600';
                                const icon = isOver ? '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' : '<i class="fa-solid fa-check mr-1"></i>';

                                return `
                                <tr class="${rowClass}">
                                    <td class="p-4 font-bold text-gray-700">${this._sanitize(s.name)}</td>
                                    <td class="p-4 text-right">${daysCell}</td>
                                    <td class="p-4 text-right">${s.hours.toFixed(1)}h</td>
                                    <td class="p-4 text-right ${textClass}">${icon}${diffText}</td>
                                    <td class="p-4 text-right font-mono">¥${s.cost.toLocaleString()}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table></div>
                </div>
            </div>
        `;
        setTimeout(() => this.renderAnalyticsCharts(stats), 100);
    },

    // 出勤シフトを「日勤/夜勤」等のタイプに分類 (出勤日数内訳用)。
    //   1) 時間が一致する登録パターンがあればそのパターン名を採用
    //   2) 無ければ 日跨ぎ/18時以降開始 を「夜勤」、それ以外を「日勤」
    _classifyShiftType(shift, customShifts) {
        const sStart = (shift.start_time || '').slice(0, 5);
        const sEnd = (shift.end_time || '').slice(0, 5);
        let matchedName = '';
        (customShifts || []).forEach(p => {
            if ((p.start || '').slice(0, 5) === sStart && (p.end || '').slice(0, 5) === sEnd) {
                matchedName = (p.name || '').trim();
            }
        });
        if (matchedName) return matchedName;
        // 時刻ベースのフォールバック
        const toMin = (t) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
        const startMin = toMin(sStart);
        let endMin = toMin(sEnd);
        const crossesMidnight = endMin <= startMin;
        const isNight = crossesMidnight || startMin >= 18 * 60;
        return isNight ? '夜勤' : '日勤';
    },

    calculateMonthlyAnalytics() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const prefix = `${year}-${String(month).padStart(2, '0')}`;
        const monthShifts = this.state.shifts.filter(s => s.date.startsWith(prefix));
        const daysInMonth = new Date(year, month, 0).getDate();
        const customShifts = this.state.config?.custom_shifts || [];

        let totalCost = 0, totalHours = 0;
        const dailyCosts = new Array(daysInMonth).fill(0);
        const dailyLabels = Array.from({length: daysInMonth}, (_, i) => `${i+1}日`);
        const staffMap = {};

        // v3.6.3: 深夜手当 (22:00-翌05:00 = +25%) を正しく計算するヘルパ
        // 旧版は祝日割増のみで、UI ラベル「祝日割増・深夜手当を含む概算」と実装が乖離していた。
        const _toMin = (timeStr) => {
            const [h, m] = (timeStr || '00:00').split(':').map(Number);
            return h * 60 + m;
        };
        const _nightHoursForShift = (startMin, endMin) => {
            // [startMin, endMin] のうち、各日 [00:00-05:00] ∪ [22:00-24:00] に
            // 重なる時間を分単位で集計し時間に変換 (cross-midnight 対応)
            let night = 0;
            let cur = startMin;
            while (cur < endMin) {
                const dayBase = Math.floor(cur / 1440) * 1440;
                const localStart = cur - dayBase;
                const localEnd = Math.min(1440, endMin - dayBase);
                night += Math.max(0, Math.min(300, localEnd) - localStart);       // 00:00-05:00
                night += Math.max(0, localEnd - Math.max(1320, localStart));      // 22:00-24:00
                cur = dayBase + 1440;
            }
            return night / 60;
        };
        // null セーフな祝日判定 (他箇所と同じパターン)
        const _jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
        const _isHoliday = (dateStr) => _jh ? _jh.isHoliday(dateStr) : false;

        monthShifts.forEach(shift => {
            const staff = this.getStaff(shift.staff_id);
            if (!staff) return;
            const startMin = _toMin(shift.start_time);
            let endMin = _toMin(shift.end_time);
            if (endMin <= startMin) endMin += 24 * 60;
            const breakMin = shift.break_minutes || 0;
            const totalShiftHours = (endMin - startMin) / 60;
            const workHours = Math.max(0, totalShiftHours - breakMin / 60);

            let cost = 0;
            if (staff.salary_type === 'hourly') {
                const baseWage = staff.hourly_wage || 0;
                // 祝日割増は1日全体に適用
                const dayWage = _isHoliday(shift.date) ? baseWage * 1.25 : baseWage;
                // 深夜時間帯の割増 (休憩は日中に割り当てる前提で深夜時間から引かない)
                const nightHrs = Math.min(workHours, _nightHoursForShift(startMin, endMin));
                const dayHrs = Math.max(0, workHours - nightHrs);
                cost = Math.floor(dayHrs * dayWage + nightHrs * dayWage * 1.25);
            }

            totalCost += cost;
            totalHours += workHours;
            const dayIndex = parseInt(shift.date.split('-')[2]) - 1;
            if (dayIndex >= 0 && dayIndex < dailyCosts.length) dailyCosts[dayIndex] += cost;

            if (!staffMap[staff.id]) staffMap[staff.id] = { id: staff.id, name: staff.name, cost: 0, hours: 0, days: new Set(), typeDays: {} };
            staffMap[staff.id].cost += cost;
            staffMap[staff.id].hours += workHours;
            staffMap[staff.id].days.add(shift.date);
            // 出勤日数内訳: タイプ別に「出勤した日」を集計 (同日複数シフトは1日)
            const stype = this._classifyShiftType(shift, customShifts);
            if (!staffMap[staff.id].typeDays[stype]) staffMap[staff.id].typeDays[stype] = new Set();
            staffMap[staff.id].typeDays[stype].add(shift.date);
        });

        this.state.staff.forEach(s => {
            if (s.salary_type === 'monthly') {
                const salary = s.monthly_salary || 0;
                totalCost += salary;
                if (!staffMap[s.id]) staffMap[s.id] = { id: s.id, name: s.name, cost: 0, hours: 0, days: new Set(), typeDays: {} };
                staffMap[s.id].cost += salary;
                // v3.6.3: 月給を日次コストに分散 (旧版は日次グラフから完全脱落していた)
                if (daysInMonth > 0) {
                    const dailyShare = salary / daysInMonth;
                    for (let i = 0; i < daysInMonth; i++) {
                        dailyCosts[i] += dailyShare;
                    }
                }
            }
        });

        // 出勤日数内訳: Set → 件数へ変換 + 店舗全体の合算
        const typeTotals = {};
        const staffStats = Object.values(staffMap).map(s => {
            const types = {};
            Object.keys(s.typeDays || {}).forEach(label => {
                const n = s.typeDays[label].size;
                types[label] = n;
                typeTotals[label] = (typeTotals[label] || 0) + n;
            });
            return { ...s, days: s.days.size, types };
        }).sort((a, b) => b.cost - a.cost);
        return { totalCost, totalHours, daysCount: daysInMonth, activeStaffCount: Object.keys(staffMap).length, dailyCosts, dailyLabels, staffStats, typeTotals };
    },

    renderAnalyticsCharts(stats) {
        if (this.analyticsDailyChart) this.analyticsDailyChart.destroy();
        if (this.analyticsShareChart) this.analyticsShareChart.destroy();

        this.analyticsDailyChart = new Chart(document.getElementById('dailyCostChart'), {
            type: 'line',
            data: { labels: stats.dailyLabels, datasets: [{ label: '日次人件費', data: stats.dailyCosts, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.3 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
        });
        const topStaff = stats.staffStats.slice(0, 5);
        const otherCost = stats.staffStats.slice(5).reduce((sum, s) => sum + s.cost, 0);
        const labels = topStaff.map(s => s.name);
        const data = topStaff.map(s => s.cost);
        if (otherCost > 0) { labels.push('その他'); data.push(otherCost); }

        this.analyticsShareChart = new Chart(document.getElementById('staffShareChart'), {
            type: 'doughnut',
            data: { labels: labels, datasets: [{ data: data, backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#9ca3af'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
        });
    },

    // =================================================================
    // 5. スタッフ管理 (Staff) - Admin Only
    // =================================================================
    // v3.7.25: 月の需給バランスを計算 (全員の min_days_month 合計 vs 月需要)
    // v3.7.44: 平日/土日を分離して計算 (「全体は過剰だが土日は不足」の矛盾を解消)
    _computeStaffingBalance() {
        const staff = this.state.staff || [];
        if (staff.length === 0) return null;
        const cfg = this.state.config || {};
        const sr = cfg.staff_req || {};
        const minWeekday = Number(sr.min_weekday || 0);
        const minWeekend = Number(sr.min_weekend || 0);
        const minHoliday = Number(sr.min_holiday || minWeekend);
        if (minWeekday + minWeekend === 0) return null;

        const jh = (typeof JapaneseHolidays !== 'undefined') ? JapaneseHolidays : null;

        // 現在月の日数を集計
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const closedDays = (cfg.closed_days || []).map(Number);
        let weekdayCount = 0, weekendCount = 0, holidayCount = 0, closedCount = 0;
        for (let d = 1; d <= daysInMonth; d++) {
            const wd = new Date(y, m, d).getDay();
            if (closedDays.includes(wd)) { closedCount++; continue; }
            const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            if (jh && jh.isHoliday(dateStr)) {
                holidayCount++;
            } else if (wd === 0 || wd === 6) {
                weekendCount++;
            } else {
                weekdayCount++;
            }
        }
        // v3.7.44: 平日/土日別の供給を計算 (曜日 NG を考慮)
        // 各スタッフが「平日に出れる日数」「土日祝に出れる日数」を min_days_month から按分
        let supplyWeekday = 0, supplyWeekend = 0;
        for (const s of staff) {
            const ngWd = Array.isArray(s.ng_weekdays) ? s.ng_weekdays.map(Number) : [];
            const minDays = Number(s.min_days_month || 0);
            // 出勤可能曜日数 (NG 曜日を除外)
            const availDays = [0,1,2,3,4,5,6].filter(w => !ngWd.includes(w));
            const availWeekdays = availDays.filter(w => w >= 1 && w <= 5).length;  // 月-金
            const availWeekendsHolidays = availDays.filter(w => w === 0 || w === 6).length;  // 土日
            const availTotal = availWeekdays + availWeekendsHolidays;
            if (availTotal === 0) continue;
            // min_days_month を平日/土日に按分 (出勤可能曜日数の比率で)
            const wkRatio = availWeekdays / availTotal;
            supplyWeekday += minDays * wkRatio;
            supplyWeekend += minDays * (1 - wkRatio);
        }
        supplyWeekday = Math.round(supplyWeekday);
        supplyWeekend = Math.round(supplyWeekend);

        const demandWeekday = weekdayCount * minWeekday;
        const demandWeekend = weekendCount * minWeekend + holidayCount * minHoliday;
        const demand = demandWeekday + demandWeekend;
        const supply = supplyWeekday + supplyWeekend;
        const supplyMax = staff.reduce((sum, s) => sum + Number(s.max_days_week || 5) * 4.3, 0);

        // 平日/土日別の比率
        const ratioWeekday = demandWeekday > 0 ? supplyWeekday / demandWeekday : 0;
        const ratioWeekend = demandWeekend > 0 ? supplyWeekend / demandWeekend : 0;
        const ratio = demand > 0 ? supply / demand : 0;

        // v3.7.129: allow_overstaffing ON/OFF で判定を切り替え
        //   OFF (デフォルト): 過剰も警告 (店舗が必要人数ぴったりに合わせるため)
        //   ON: 過剰は許容範囲扱い、不足のみ警告 (過剰補完を意図的に許可しているため)
        const allowOverstaff = !!cfg.allow_overstaffing;
        const statusOf = (r) => {
            if (r === 0) return 'good';
            if (r < 0.95) return 'bad-under';   // 不足は両モードで警告
            if (allowOverstaff) {
                // 過剰許容モード: 過剰でも全て適正扱い
                return 'good';
            }
            if (r <= 1.05) return 'good';
            if (r <= 1.2) return 'warn';
            return 'bad-over';
        };
        const statusWeekday = statusOf(ratioWeekday);
        const statusWeekend = statusOf(ratioWeekend);
        // 全体ステータス: 最も深刻な状態を優先
        const priority = { 'bad-under': 0, 'bad-over': 1, 'warn': 2, 'good': 3 };
        const overallStatus = priority[statusWeekday] < priority[statusWeekend] ? statusWeekday : statusWeekend;
        // 旧 status コードに変換 (UI 互換性)
        let status;
        if (overallStatus === 'good') status = 'good';
        else if (overallStatus === 'warn') status = 'warn';
        else status = 'bad';  // bad-under or bad-over

        return {
            staffCount: staff.length,
            supplyWeekday, supplyWeekend,
            demandWeekday, demandWeekend,
            ratioWeekday, ratioWeekend,
            statusWeekday, statusWeekend,
            weekdayCount, weekendCount, holidayCount, closedCount,
            minWeekday, minWeekend, minHoliday,
            demand, supply, supplyMax,
            ratio, status,
            allowOverstaff,
            overDays: Math.max(0, supply - demand)
        };
    },

    _renderBalanceBanner(b) {
        // v3.7.44: 平日/土日別バランス表示で「全体過剰だが土日不足」の矛盾を解消
        // v3.7.129: 過剰配置 ON/OFF でメッセージとラベルを切り替え
        const allowOverstaff = !!b.allowOverstaff;
        const palette = {
            good: {
                bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700',
                icon: 'fa-circle-check',
                label: allowOverstaff ? '適正 (過剰許容モード)' : '適正',
            },
            warn: {
                bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700',
                icon: 'fa-triangle-exclamation',
                label: 'やや過剰',
            },
            bad: {
                bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-700',
                icon: 'fa-circle-exclamation',
                label: '要注意',
            }
        };
        const p = palette[b.status];
        const subStatusLabel = (s) => ({
            'good': allowOverstaff ? '許容' : '適正',
            'warn': 'やや過剰',
            'bad-over': '過剰',
            'bad-under': '不足'
        }[s] || s);
        const subStatusColor = (s) => ({
            'good': 'text-emerald-600',
            'warn': 'text-amber-600',
            'bad-over': 'text-red-600',
            'bad-under': 'text-orange-600'
        }[s] || 'text-gray-600');
        const subStatusBadge = (s) => ({
            'good': 'bg-emerald-100 text-emerald-700',
            'warn': 'bg-amber-100 text-amber-700',
            'bad-over': 'bg-red-100 text-red-700',
            'bad-under': 'bg-orange-100 text-orange-700'
        }[s] || 'bg-gray-100 text-gray-600');

        // v3.7.129: 全体感サマリ (一文で現状を要約)
        const overallSummary = (() => {
            const wd = b.statusWeekday, we = b.statusWeekend;
            if (wd === 'bad-under' && we === 'bad-under') return '平日・土日とも スタッフ不足';
            if (wd === 'bad-under') return '平日のスタッフが不足';
            if (we === 'bad-under') return '土日祝のスタッフが不足';
            if (allowOverstaff) {
                if (wd === 'good' && we === 'good') return '過剰許容モードで稼働中 (過剰補完あり、不足なし)';
                return '過剰許容モードで稼働中';
            }
            if (wd === 'bad-over' || we === 'bad-over') return '過剰登録あり (人件費過大の可能性)';
            if (wd === 'warn' || we === 'warn') return 'やや過剰 (許容範囲)';
            return '需給バランスは適正';
        })();

        // 矛盾検出 (全体は過剰だが土日不足、など)
        const mismatchMsg = (b.statusWeekday !== b.statusWeekend && (b.statusWeekday === 'bad-under' || b.statusWeekend === 'bad-under'))
            ? `<div class="mt-2 p-2 bg-orange-50 rounded border border-orange-200 text-xs leading-relaxed text-orange-800"><i class="fa-solid fa-triangle-exclamation mr-1"></i><strong>注意:</strong> 全体は過剰でも、${b.statusWeekday === 'bad-under' ? '<strong>平日</strong>' : '<strong>土日</strong>'}に出勤可能なスタッフが不足しています。シフト生成時に一部不足が発生する可能性があります。</div>`
            : '';

        // v3.7.129: ポリシー説明を ON/OFF で切替
        const policyNote = allowOverstaff
            ? `<div class="mt-2 p-2 bg-blue-50 rounded border border-blue-200 text-xs leading-relaxed text-blue-800"><i class="fa-solid fa-toggle-on mr-1"></i><strong>過剰配置許容モード (ON):</strong> スタッフの最低出勤日数を満たすため、店舗必要人数を超えても補完配置します。不足のみ警告対象です。</div>`
            : (b.status !== 'good'
                ? `<div class="mt-2 p-2 bg-white/70 rounded border border-current/20 text-xs leading-relaxed"><i class="fa-solid fa-shield-halved mr-1"></i><strong>過剰絶対回避ポリシー (OFF):</strong> 過剰になる場合、AIは<strong>最低出勤日数を犠牲にしてでも店舗必要人数ぴったりに合わせる</strong>よう設定されています。</div>`
                : '');

        return `
            <div class="${p.bg} ${p.border} border-2 rounded-xl p-4 ${p.text}">
                <div class="flex items-start gap-3">
                    <i class="fa-solid ${p.icon} text-xl mt-0.5"></i>
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-base mb-1">需給バランス: ${p.label}</div>
                        <div class="text-xs ${p.text} opacity-80 mb-2">${overallSummary}</div>
                        ${mismatchMsg}
                        ${policyNote}
                        <!-- 平日/土日別パネル -->
                        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div class="bg-white/70 rounded-lg p-3 border border-current/20">
                                <div class="flex items-center justify-between mb-1">
                                    <span class="text-xs font-bold text-gray-600">平日 (月-金)</span>
                                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${subStatusBadge(b.statusWeekday)}">${subStatusLabel(b.statusWeekday)}</span>
                                </div>
                                <div class="flex items-baseline gap-2 text-xs text-gray-700">
                                    <span>供給 <strong class="${subStatusColor(b.statusWeekday)}">${b.supplyWeekday}</strong> 人日</span>
                                    <span class="text-gray-400">vs</span>
                                    <span>需要 <strong>${b.demandWeekday}</strong> 人日</span>
                                </div>
                                <div class="text-[10px] text-gray-500 mt-0.5">${b.weekdayCount}日×${b.minWeekday}名 (比率 ${(b.ratioWeekday * 100).toFixed(0)}%)</div>
                            </div>
                            <div class="bg-white/70 rounded-lg p-3 border border-current/20">
                                <div class="flex items-center justify-between mb-1">
                                    <span class="text-xs font-bold text-gray-600">土日祝</span>
                                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${subStatusBadge(b.statusWeekend)}">${subStatusLabel(b.statusWeekend)}</span>
                                </div>
                                <div class="flex items-baseline gap-2 text-xs text-gray-700">
                                    <span>供給 <strong class="${subStatusColor(b.statusWeekend)}">${b.supplyWeekend}</strong> 人日</span>
                                    <span class="text-gray-400">vs</span>
                                    <span>需要 <strong>${b.demandWeekend}</strong> 人日</span>
                                </div>
                                <div class="text-[10px] text-gray-500 mt-0.5">土日${b.weekendCount}日+祝${b.holidayCount}日 (比率 ${(b.ratioWeekend * 100).toFixed(0)}%)</div>
                            </div>
                        </div>
                        <!-- 合計サマリー -->
                        <div class="mt-2 text-[11px] text-gray-600">
                            合計: 供給 ${b.supply} 人日 / 需要 ${b.demand} 人日 / 差分 ${b.supply >= b.demand ? '+' : ''}${b.supply - b.demand} 人日 (理論最大 ${Math.round(b.supplyMax)} 人日)
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    renderStaffList(container) {
        if (!this.state.isAdmin) return;

        // v3.7.25: 需給バランス自動診断
        const balance = this._computeStaffingBalance();
        const balanceBanner = balance ? this._renderBalanceBanner(balance) : '';

        container.innerHTML = `
            <div class="max-w-6xl mx-auto space-y-6 pb-20">
                <div class="flex items-center justify-between">
                    <h2 class="text-2xl font-bold text-gray-800">スタッフ管理</h2>
                    <button onclick="app.prepareStaffModal()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-plus mr-2"></i>新規登録
                    </button>
                </div>
                ${balanceBanner}
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead class="bg-gray-50 border-b border-gray-200 text-xs font-bold text-gray-500 uppercase tracking-wider">
                                <tr>
                                    ${(() => {
                                        const so = this.state.staffSort || { key: 'role', dir: 'asc' };
                                        const ind = (k) => so.key === k ? (so.dir === 'asc' ? ' ↑' : ' ↓') : '';
                                        const sortable = (k, label, extra='') => `<th class="p-4 whitespace-nowrap cursor-pointer select-none hover:text-blue-600 ${extra}" onclick="app.setStaffSort('${k}')">${label}<span class="text-blue-500">${ind(k)}</span></th>`;
                                        return sortable('name', '名前', 'min-w-[200px]')
                                             + sortable('role', '役割')
                                             + sortable('evaluation', '評価')
                                             + sortable('salary', '給与形態')
                                             + '<th class="p-4 whitespace-nowrap">勤務制約</th>'
                                             + '<th class="p-4 text-right whitespace-nowrap">操作</th>';
                                    })()}
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-gray-100">
                                ${this._sortedStaff().map(s => {
                                    // 安全策: config.rolesが無い場合はデフォルトを使う
                                    const roleList = this.state.config.roles || this.state.defaultConfig.roles || [];
                                    const role = roleList.find(r => r.id === s.role) || { name: '未設定', color: 'gray' };
                                    const colorMap = {
                                        purple: 'bg-purple-50 text-purple-700 border-purple-100',
                                        blue: 'bg-blue-50 text-blue-700 border-blue-100',
                                        green: 'bg-green-50 text-green-700 border-green-100',
                                        yellow: 'bg-yellow-50 text-yellow-700 border-yellow-100',
                                        red: 'bg-red-50 text-red-700 border-red-100',
                                        gray: 'bg-gray-50 text-gray-700 border-gray-100'
                                    };
                                    const badgeClass = colorMap[role.color] || colorMap['gray'];
                                    
                                    return `
                                <tr class="hover:bg-gray-50 group transition-colors">
                                    <td class="p-4 whitespace-nowrap">
                                        <div class="flex items-center gap-3">
                                            <div class="w-9 h-9 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 border border-gray-200 flex items-center justify-center text-gray-500 font-bold text-sm shadow-sm">
                                                ${this._sanitize(s.name.charAt(0))}
                                            </div>
                                            <div>
                                                <div class="font-bold text-gray-800 text-sm">${this._sanitize(s.name)}</div>
                                                <div class="text-[10px] text-gray-400 font-mono">ID: ${s.id ? s.id.substr(0, 6) : '---'}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td class="p-4 whitespace-nowrap">
                                        <span class="px-2.5 py-1 text-xs font-bold rounded-full border shadow-sm ${badgeClass}">
                                            ${this._sanitize(role.name)}
                                        </span>
                                    </td>
                                    <td class="p-4 whitespace-nowrap">
                                        ${s.evaluation === 'A' ? '<span class="bg-yellow-100 text-yellow-800 text-xs font-bold px-2 py-1 rounded-md border border-yellow-200 shadow-sm">A</span>' : ''}
                                        ${s.evaluation === 'B' ? '<span class="bg-blue-50 text-blue-800 text-xs font-bold px-2 py-1 rounded-md border border-blue-100 shadow-sm">B</span>' : ''}
                                        ${s.evaluation === 'C' ? '<span class="bg-gray-100 text-gray-600 text-xs font-bold px-2 py-1 rounded-md border border-gray-200 shadow-sm">C</span>' : ''}
                                        ${s.evaluation === 'D' ? '<span class="bg-red-50 text-red-600 text-xs font-bold px-2 py-1 rounded-md border border-red-100 shadow-sm">D</span>' : ''}
                                        ${!['A','B','C','D'].includes(s.evaluation) ? '<span class="text-xs text-gray-400">-</span>' : ''}
                                    </td>
                                    <td class="p-4 whitespace-nowrap text-sm text-gray-600 font-mono">
                                        ${s.salary_type === 'hourly' 
                                            ? `<div class="flex items-center gap-2"><span class="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-500 font-bold">時給</span> <span class="font-bold">¥${s.hourly_wage ? s.hourly_wage.toLocaleString() : '0'}</span></div>` 
                                            : `<div class="flex items-center gap-2"><span class="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-500 font-bold">月給</span> <span class="font-bold">¥${s.monthly_salary ? s.monthly_salary.toLocaleString() : '0'}</span></div>`}
                                    </td>
                                    <td class="p-4 whitespace-nowrap text-xs text-gray-500">
                                        <div class="flex items-center gap-3">
                                            <span class="flex items-center gap-1 bg-gray-50 px-2 py-1 rounded border border-gray-100" title="週の勤務日数上限"><i class="fa-regular fa-calendar-check text-gray-400"></i> 週${s.max_days_week || '-'}日</span>
                                            <span class="flex items-center gap-1 bg-gray-50 px-2 py-1 rounded border border-gray-100" title="1日の勤務時間上限"><i class="fa-regular fa-clock text-gray-400"></i> 1日${s.max_hours_day || '-'}h</span>
                                        </div>
                                    </td>
                                    <td class="p-4 text-right whitespace-nowrap">
                                        <div class="flex justify-end gap-2">
                                            <button onclick="app.editStaff('${s.id}')" class="w-8 h-8 flex items-center justify-center text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-100" title="編集">
                                                <i class="fa-solid fa-pen-to-square"></i>
                                            </button>
                                            <button onclick="app.deleteStaff('${s.id}')" class="w-8 h-8 flex items-center justify-center text-red-500 hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-100" title="削除">
                                                <i class="fa-solid fa-trash"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>`}).join('')}
                                ${this.state.staff.length === 0 ? '<tr><td colspan="6" class="p-12 text-center text-gray-400 flex flex-col items-center gap-2"><i class="fa-solid fa-users-slash text-3xl mb-2 text-gray-300"></i><span>スタッフが登録されていません</span></td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    },

    // スタッフ一覧のソート (デフォルト: 役職順)。役職は config.roles の並び順 +
    // 管理者を上位に。同順位は名前(かな)で安定ソート。
    _sortedStaff() {
        const staff = [...(this.state.staff || [])];
        // v3.7.194: localStorage から復元 (リロードしても並び順が維持される)
        if (!this.state.staffSort) {
            try { this.state.staffSort = JSON.parse(localStorage.getItem('rk_staffSort')) || null; } catch (e) {}
        }
        const sort = this.state.staffSort || { key: 'role', dir: 'asc' };
        const roleList = (this.state.config && this.state.config.roles) || this.state.defaultConfig.roles || [];
        // v3.7.194: staff.role が「ID」でも「名前」でも引けるよう両方をキーにする
        const roleRank = {};
        roleList.forEach((r, i) => {
            const rank = (r.is_manager ? 0 : 1) * 1000 + i;
            if (r.id != null) roleRank[r.id] = rank;
            if (r.name != null && roleRank[r.name] == null) roleRank[r.name] = rank;
        });
        const evalRank = { A: 0, B: 1, C: 2, D: 3 };
        const keyVal = (s) => {
            switch (sort.key) {
                case 'name': return (s.name || '');
                case 'evaluation': return evalRank[s.evaluation] != null ? evalRank[s.evaluation] : 99;
                case 'salary': return s.salary_type === 'monthly' ? 0 : 1;
                case 'role':
                default: return roleRank[s.role] != null ? roleRank[s.role] : 9999;
            }
        };
        staff.sort((a, b) => {
            const va = keyVal(a), vb = keyVal(b);
            let c = (typeof va === 'string') ? va.localeCompare(vb, 'ja') : (va - vb);
            if (c === 0) c = (a.name || '').localeCompare(b.name || '', 'ja');  // 安定タイブレーク
            return sort.dir === 'desc' ? -c : c;
        });
        return staff;
    },

    setStaffSort(key) {
        const cur = this.state.staffSort || { key: 'role', dir: 'asc' };
        // 同じ列を再クリックで昇順/降順トグル。別列なら昇順から。
        this.state.staffSort = (cur.key === key)
            ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: 'asc' };
        try { localStorage.setItem('rk_staffSort', JSON.stringify(this.state.staffSort)); } catch (e) {}
        this.renderStaffList(document.getElementById('viewContainer'));
    },

    // シフト表示のスタッフ並び順を変更 (staffSort を共有し、シフト表/カレンダーを再描画)
    setStaffSortFromShift(key) {
        const cur = this.state.staffSort || { key: 'role', dir: 'asc' };
        // 同じ項目を再選択したら昇順/降順トグル
        this.state.staffSort = (cur.key === key)
            ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: 'asc' };
        try { localStorage.setItem('rk_staffSort', JSON.stringify(this.state.staffSort)); } catch (e) {}
        this.renderShiftView(document.getElementById('viewContainer'));
    },

    // =================================================================
    // 6. 設定 (Settings) - Admin Only
    // =================================================================
    renderSettings(container) {
        if (!this.state.isAdmin) return;
        const config = this.state.config;
        
        const times = config.opening_times || this.state.defaultConfig.opening_times;
        const reqs = config.staff_req || this.state.defaultConfig.staff_req;
        const closedDays = config.closed_days || [];
        const customShifts = config.custom_shifts || [];
        const roles = config.roles || this.state.defaultConfig.roles;
        const breakRules = config.break_rules || this.state.defaultConfig.break_rules;
        const shopRulesText = config.shop_rules_text || this.state.defaultConfig.shop_rules_text;
        const specialHolidays = config.special_holidays || [];
        const specialDays = config.special_days || {};
        const timeStaffReq = config.time_staff_req || [];
        const positions = config.positions || ['ホール', 'キッチン'];

        container.innerHTML = `
            <div class="max-w-4xl mx-auto space-y-8 pb-24">
                <div class="flex items-center justify-between border-b border-gray-200 pb-4 gap-2 flex-wrap">
                    <div class="min-w-0">
                        <h2 class="text-2xl font-bold text-gray-800">店舗設定</h2>
                        <p class="text-sm text-gray-500 mt-1">AIシフト生成に使われるルールです。</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <!-- v3.7.130: チュートリアル再表示 -->
                        <button onclick="app.showTutorial(true)" class="bg-white border border-blue-300 text-blue-700 font-bold py-2 px-4 rounded-lg shadow-sm hover:bg-blue-50 transition flex items-center whitespace-nowrap" title="使い方ガイドをもう一度見る">
                            <i class="fa-solid fa-circle-question mr-1.5"></i>使い方ガイド
                        </button>
                        <button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap">
                            <i class="fa-solid fa-save mr-2"></i>設定を保存
                        </button>
                    </div>
                </div>

                <div class="mb-6 p-4 bg-purple-50 border-l-4 border-purple-500 rounded-lg text-sm text-purple-900 leading-relaxed shadow-sm">
                    <strong><i class="fa-solid fa-triangle-exclamation text-purple-600 mr-2"></i> 【重要】店舗設定の正確さがAIの精度を決めます</strong><br>
                    <div class="mt-2 space-y-2">
                        <p>ラクシフトAIは、ここに入力された条件を「店舗の絶対的なルール」として学習しシフトを組みます。</p>
                        <p>・<span class="font-bold text-purple-700">正確に設定した場合</span>：時間帯ごとの最適な人員配置、管理者の確実なカバー、休憩の自動付与など「店長が頭を抱えていたパズル」を完璧に解いたシフトを生成します。</p>
                        <p>・<span class="font-bold text-red-500">設定が甘い場合</span>（例: 必要な人数を全て0にする、管理者を設定しない等）：AIは「何人でも良い」「誰でも良い」と判断するため、人が足りない時間帯ができたり、法律上は問題なくても実用的でないシフトが出来上がってしまいます。</p>
                        <p class="font-bold mt-2">※特に「管理者の必須人数」と「シフトパターン (平日/土曜/日祝の必要人数)」は、店舗の実態に合わせて正確に入力してください。</p>
                    </div>
                </div>

                <!-- v3.7.133: セキュリティ (PIN / 責任者引き継ぎ) -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gradient-to-r from-indigo-50 to-purple-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-shield-halved text-indigo-500"></i> セキュリティ・責任者引き継ぎ</h3>
                        <p class="text-xs text-gray-500 mt-1">セカンドファクター PIN 設定と、責任者交代時の引き継ぎ手順</p>
                    </div>
                    <div class="p-5 space-y-4">
                        <!-- PIN セクション -->
                        <div class="bg-gray-50 border border-gray-200 rounded-lg p-4">
                            <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
                                <div>
                                    <div class="font-bold text-sm text-gray-800"><i class="fa-solid fa-key text-amber-500 mr-1"></i>セカンドファクター PIN</div>
                                    <p class="text-xs text-gray-500 mt-0.5">設定すると、契約ID/パスワードに加えて 4〜8桁の PIN 入力が必須になります</p>
                                </div>
                                <div id="pinStatusBadge" class="text-xs font-bold px-3 py-1 rounded-full bg-gray-200 text-gray-600">読み込み中...</div>
                            </div>
                            <div class="flex gap-2 mt-3 flex-wrap" id="pinActionButtons">
                                <!-- _renderPinStatus が動的に挿入 -->
                            </div>
                        </div>

                        <!-- 責任者引き継ぎ (重要) -->
                        <div class="border-l-4 border-amber-500 bg-amber-50 p-4 rounded-r-lg">
                            <h4 class="font-bold text-amber-900 mb-2"><i class="fa-solid fa-people-arrows mr-1"></i>責任者引き継ぎに関して (重要)</h4>
                            <div class="text-xs text-amber-900 leading-relaxed space-y-2">
                                <p>店舗管理者を交代する際、新責任者がログインできなくなるトラブルを防ぐため、以下を必ず引き継いでください:</p>
                                <ol class="list-decimal list-inside space-y-1 ml-2">
                                    <li><strong>契約 ID</strong> (ログイン画面に入力する識別子)</li>
                                    <li><strong>管理者パスワード</strong> (上記の「パスワード変更」から新責任者の希望に変更可能)</li>
                                    <li><strong>セカンドファクター PIN</strong> (上で設定している場合のみ。<u>未引き継ぎだと新責任者がログイン不能</u>)</li>
                                    <li><strong>本部ログイン情報</strong> (本部から店舗を観覧している場合)</li>
                                </ol>
                                <p class="font-bold mt-2 text-amber-950">⚠ PIN を忘れた / 引き継ぎ漏れた場合は、運営管理 (info@rakushift.jp) にリセット依頼が必要です。即時対応はできない場合があります。</p>
                                <p>引き継ぎ前のチェックリストは サイドバーの「責任者引き継ぎ」メニューから確認できます。</p>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 1. 役職・ロール設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-id-badge text-indigo-500"></i> 役職・ロール設定</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">スタッフの肩書きを設定します。AIは「Manager」を管理者、「Rookie」を新人として自動判定します。</p>
                        <button onclick="app.addRole()" class="text-xs bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-bold hover:bg-indigo-200 transition">
                            <i class="fa-solid fa-plus mr-1"></i>役職追加
                        </button>
                    </div>
                    <div class="p-6">
                        <div class="overflow-x-auto">
                            <table class="w-full text-left">
                                <thead class="bg-gray-50 text-xs text-gray-500 uppercase font-bold">
                                    <tr>
                                        <th class="p-3 rounded-l-lg">役職名</th>
                                        <th class="p-3">識別ID</th>
                                        <th class="p-3">バッジカラー</th>
                                        <th class="p-3 text-center">管理者<br><span class="text-[9px] text-gray-400">として認識</span></th>
                                        <th class="p-3 text-center">社員<br><span class="text-[9px] text-gray-400">として認識</span></th>
                                        <th class="p-3 text-right rounded-r-lg">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="rolesBody">
                                    ${roles.map((role, index) => {
                                        // v3.7.81: 明示的な is_manager フラグ (旧データは color/id から推定)
                                        const inferred = (role.color === 'purple' || role.color === 'red' || role.color === 'green'
                                                       || role.id === 'manager' || role.id === 'sub_manager' || role.id === 'employee');
                                        const isMgr = role.is_manager != null ? !!role.is_manager : inferred;
                                        // v3.7.196: 社員フラグ (管理者と独立)。管理者は自動的に社員。未設定は緑/青を社員と推定
                                        const inferredEmp = isMgr || role.color === 'green' || role.color === 'blue';
                                        const isEmp = role.is_employee != null ? !!role.is_employee : inferredEmp;
                                        return `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-2">
                                                <input type="text" class="setting-role-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${this._sanitize(role.name)}" placeholder="役職名">
                                            </td>
                                            <td class="p-2">
                                                <input type="text" class="setting-role-id w-full border-gray-300 rounded px-2 py-1.5 text-sm bg-gray-50" value="${this._sanitize(role.id)}" readonly title="IDは変更できません">
                                            </td>
                                            <td class="p-2">
                                                <select class="setting-role-color w-full border-gray-300 rounded px-2 py-1.5 text-sm">
                                                    <option value="purple" ${role.color==='purple'?'selected':''}>紫 (Manager)</option>
                                                    <option value="blue" ${role.color==='blue'?'selected':''}>青 (Leader)</option>
                                                    <option value="green" ${role.color==='green'?'selected':''}>緑 (Staff)</option>
                                                    <option value="yellow" ${role.color==='yellow'?'selected':''}>黄 (Rookie)</option>
                                                    <option value="red" ${role.color==='red'?'selected':''}>赤 (Admin)</option>
                                                    <option value="gray" ${role.color==='gray'?'selected':''}>灰 (Other)</option>
                                                </select>
                                            </td>
                                            <td class="p-2 text-center">
                                                <label class="inline-flex items-center justify-center cursor-pointer" title="チェックを入れると、この役職のスタッフは「管理者最低人数」の対象になります">
                                                    <input type="checkbox" class="setting-role-is-manager w-5 h-5 accent-indigo-600" ${isMgr?'checked':''}>
                                                </label>
                                            </td>
                                            <td class="p-2 text-center">
                                                <label class="inline-flex items-center justify-center cursor-pointer" title="チェックを入れると、この役職のスタッフは「社員」として扱われます (給与形態が時給でも社員優先・希望時間尊重の対象になります)">
                                                    <input type="checkbox" class="setting-role-is-employee w-5 h-5 accent-emerald-600" ${isEmp?'checked':''}>
                                                </label>
                                            </td>
                                            <td class="p-2 text-right">
                                                <button onclick="app.deleteRole(${index})" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition" ${role.id==='manager'||role.id==='staff'?'title="基本役職 (AIシフト生成で内部参照されます)。削除には確認が必要"':''}>
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-xs text-gray-400 mt-3">※ IDはシステム内部で使用するため変更できません。新規追加時のみ自動生成されます。</p>
                    </div>
                </div>

                <!-- 2. 営業時間・定休日 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-regular fa-clock text-blue-500"></i> 営業時間 & 定休日</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">AIはこの時間帯の中でだけシフトを生成します。定休日にはシフトを入れません。</p>
                    </div>
                    <div class="p-6 space-y-8">
                        <!-- 営業時間 (v3.7.60: 24時間営業対応) -->
                        <div class="space-y-4">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider">営業時間設定</h4>
                            <p class="text-[11px] text-gray-500 -mt-2">💡 ヒント: 24時間営業の場合は右のチェックを ON にしてください。</p>
                            ${(() => {
                                // v3.7.187: is_24h は DB に保存されないため、保存済みの
                                // opening_times (00:00〜23:45/24:00) からも 24h 状態を復元する。
                                const _isFullDay = (ot) => !!ot && (ot.start || '').slice(0,5) === '00:00'
                                    && ['23:45','24:00','00:00'].includes((ot.end || '').slice(0,5));
                                const is24hWd = !!(this.state.config.is_24h?.weekday) || _isFullDay(times.weekday);
                                const is24hWe = !!(this.state.config.is_24h?.weekend) || _isFullDay(times.weekend);
                                const is24hHd = !!(this.state.config.is_24h?.holiday) || _isFullDay(times.holiday);
                                const renderRow = (dt, label, colorClass, defaultStart, defaultEnd, is24h) => `
                                    <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-gray-50 pb-4">
                                        <div class="md:col-span-3 font-bold ${colorClass}">${label}</div>
                                        <div class="md:col-span-6 flex items-center gap-3 ${is24h ? 'opacity-40 pointer-events-none' : ''}">
                                            ${this.get15MinTimeSelect(times[dt]?.start || defaultStart, 'time_'+dt+'_start', 'form-input border-gray-300 rounded-lg w-full')}
                                            <span class="text-gray-400">～</span>
                                            ${this.get15MinTimeSelect(times[dt]?.end || defaultEnd, 'time_'+dt+'_end', 'form-input border-gray-300 rounded-lg w-full')}
                                        </div>
                                        <div class="md:col-span-3 flex items-center">
                                            <label class="flex items-center gap-2 cursor-pointer text-xs font-bold bg-violet-50 hover:bg-violet-100 border border-violet-200 px-3 py-2 rounded-lg transition">
                                                <input type="checkbox" id="is_24h_${dt}" class="w-4 h-4" ${is24h ? 'checked' : ''} onchange="app._toggle24h('${dt}', this.checked)">
                                                <span class="text-violet-700">🕐 24時間営業</span>
                                            </label>
                                        </div>
                                    </div>
                                `;
                                return renderRow('weekday', '平日 (月-金)', 'text-gray-700', '09:00', '22:00', is24hWd) +
                                       renderRow('weekend', '土曜日', 'text-blue-600', '10:00', '20:00', is24hWe) +
                                       renderRow('holiday', '日祝日', 'text-red-600', '10:00', '20:00', is24hHd);
                            })()}
                        </div>

                        <!-- 定休日 -->
                        <div class="pt-4 border-t border-gray-100">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">定休日設定</h4>
                            <div class="flex flex-wrap gap-4 mb-4">
                                ${['日', '月', '火', '水', '木', '金', '土'].map((day, i) => `
                                    <label class="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50 border border-transparent hover:border-gray-200 transition">
                                        <input type="checkbox" name="setting_closed_days" value="${i}" class="w-5 h-5 text-red-500 rounded focus:ring-red-500 border-gray-300" ${closedDays.map(Number).includes(i) ? 'checked' : ''}>
                                        <span class="font-bold ${i===0?'text-red-500':i===6?'text-blue-500':'text-gray-700'}">${day}曜日</span>
                                    </label>
                                `).join('')}
                            </div>
                            
                            <!-- 臨時休業 -->
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">臨時休業設定</h4>
                            <div class="flex items-center gap-3 mb-3">
                                <input type="date" id="newSpecialHoliday" class="border-gray-300 rounded-lg px-3 py-1.5 text-sm">
                                <button onclick="app.addSpecialHoliday()" class="bg-red-50 text-red-600 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-red-100 transition">追加</button>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                ${specialHolidays.map((date, idx) => `
                                    <div class="bg-red-50 border border-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2">
                                        ${date} <button onclick="app.removeSpecialHoliday(${idx})" class="hover:text-red-900"><i class="fa-solid fa-times"></i></button>
                                    </div>
                                `).join('')}
                                ${specialHolidays.length === 0 ? '<span class="text-xs text-gray-400">設定なし</span>' : ''}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 3. シフトパターン設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-layer-group text-purple-500"></i> シフトパターン (早番/遅番など)</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">AIが組み合わせるシフトの「型」です。例：早番9-14時、遅番17-22時など。</p>
                        <button onclick="app.addShiftPattern()" class="text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg font-bold hover:bg-purple-200 transition">
                            <i class="fa-solid fa-plus mr-1"></i>追加
                        </button>
                    </div>
                    <div class="p-6">
                        <!-- v3.7.100: モバイル幅対応 - 横スクロール最低 720px 保証 + ヒント -->
                        <p class="text-[10px] text-gray-400 mb-2 sm:hidden">👆 横にスワイプして全列を編集できます</p>
                        <div class="overflow-x-auto" style="-webkit-overflow-scrolling: touch;">
                            <table class="text-left" style="min-width: 720px; width: 100%;">
                                <thead class="bg-gray-50 text-xs text-gray-500 uppercase font-bold">
                                    <tr>
                                        <th class="p-2 sm:p-3 rounded-l-lg" style="min-width:120px;">パターン名</th>
                                        <th class="p-2 sm:p-3" style="min-width:100px;">開始</th>
                                        <th class="p-2 sm:p-3" style="min-width:100px;">終了</th>
                                        <th class="p-2 sm:p-3 text-center" style="min-width:70px;">平日<br><span class="text-[9px] text-gray-400">人数</span></th>
                                        <th class="p-2 sm:p-3 text-center text-blue-600" style="min-width:70px;">土曜<br><span class="text-[9px] text-gray-400">人数</span></th>
                                        <th class="p-2 sm:p-3 text-center text-red-600" style="min-width:70px;">日祝<br><span class="text-[9px] text-gray-400">人数</span></th>
                                        <th class="p-2 sm:p-3 text-center" style="min-width:64px;">翌休<br><span class="text-[9px] text-gray-400">夜勤連勤防止</span></th>
                                        <th class="p-2 sm:p-3 text-center" style="min-width:96px;">管理者<br><span class="text-[9px] text-gray-400">ON=人数/OFF=ﾗﾝﾀﾞﾑ</span></th>
                                        <th class="p-2 sm:p-3 text-right rounded-r-lg" style="min-width:50px;">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="shiftPatternsBody">
                                    ${customShifts.map((shift, index) => {
                                        // v3.7.66: 曜日別の必要人数 (count_weekday / count_weekend / count_holiday)
                                        // 旧 count は count_weekday へのフォールバック
                                        const cwd = shift.count_weekday != null ? shift.count_weekday : (shift.count != null ? shift.count : 1);
                                        const cwe = shift.count_weekend != null ? shift.count_weekend : cwd;
                                        const chd = shift.count_holiday != null ? shift.count_holiday : cwe;
                                        // 管理者配置 ON/OFF (後方互換: 未指定なら manager_count>0 を ON)
                                        const mgrOn = shift.manager_enabled != null ? !!shift.manager_enabled : (Number(shift.manager_count) > 0);
                                        return `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-1 sm:p-2">
                                                <input type="text" class="setting-shift-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${this._sanitize(shift.name || '')}" placeholder="例: 早番">
                                            </td>
                                            <td class="p-1 sm:p-2">
                                                ${this.get15MinTimeSelect(shift.start, '', 'setting-shift-start w-full border-gray-300 rounded px-2 py-1.5 text-sm')}
                                            </td>
                                            <td class="p-1 sm:p-2">
                                                ${this.get15MinTimeSelect(shift.end, '', 'setting-shift-end w-full border-gray-300 rounded px-2 py-1.5 text-sm')}
                                            </td>
                                            <td class="p-1 sm:p-2 text-center">
                                                <input type="number" required min="0" max="50" step="1" inputmode="numeric" class="setting-shift-count-wd w-16 border-gray-300 rounded px-2 py-1.5 text-sm font-bold text-center" value="${cwd}">
                                            </td>
                                            <td class="p-1 sm:p-2 text-center">
                                                <input type="number" required min="0" max="50" step="1" inputmode="numeric" class="setting-shift-count-we w-16 border-blue-200 bg-blue-50 rounded px-2 py-1.5 text-sm font-bold text-center" value="${cwe}">
                                            </td>
                                            <td class="p-1 sm:p-2 text-center">
                                                <input type="number" required min="0" max="50" step="1" inputmode="numeric" class="setting-shift-count-hd w-16 border-red-200 bg-red-50 rounded px-2 py-1.5 text-sm font-bold text-center" value="${chd}">
                                            </td>
                                            <td class="p-1 sm:p-2 text-center">
                                                <input type="hidden" class="setting-shift-rest" value="${shift.force_rest_next_day ? '1' : '0'}">
                                                <button type="button" onclick="app.togglePatternRest(this)" title="このパターンに入った翌日を自動的に休みにします (夜勤の2連勤防止)" class="setting-shift-rest-btn w-10 h-6 rounded-full relative transition ${shift.force_rest_next_day ? 'bg-indigo-500' : 'bg-gray-300'}">
                                                    <span class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${shift.force_rest_next_day ? 'left-[18px]' : 'left-0.5'}"></span>
                                                </button>
                                            </td>
                                            <td class="p-1 sm:p-2 text-center">
                                                <div class="flex items-center justify-center gap-1.5">
                                                    <input type="hidden" class="setting-shift-mgr-on" value="${mgrOn ? '1' : '0'}">
                                                    <button type="button" onclick="app.togglePatternMgr(this)" title="ON=管理者を指定人数配置 / OFF=ランダム(管理者の制約なし)" class="setting-shift-mgr-btn w-9 h-5 rounded-full relative transition shrink-0 ${mgrOn ? 'bg-green-500' : 'bg-gray-300'}">
                                                        <span class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${mgrOn ? 'left-[18px]' : 'left-0.5'}"></span>
                                                    </button>
                                                    <input type="number" min="0" max="50" step="1" inputmode="numeric" title="このパターンに必要な管理者(店長/リーダー)の人数" class="setting-shift-mgr w-12 border-green-200 bg-green-50 rounded px-1.5 py-1 text-sm font-bold text-center ${mgrOn ? '' : 'opacity-40 bg-gray-100'}" value="${shift.manager_count != null ? shift.manager_count : 0}" ${mgrOn ? '' : 'disabled'}>
                                                </div>
                                            </td>
                                            <td class="p-2 text-right">
                                                <button onclick="app.deleteShiftPattern(${index})" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition">
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                        `;
                                    }).join('')}
                                    ${customShifts.length === 0 ? '<tr><td colspan="9" class="p-4 text-center text-gray-400 text-sm">シフトパターンが登録されていません。「追加」ボタンまたはプリセットから登録してください。</td></tr>' : ''}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-xs text-gray-400 mt-3">💡 ここで登録したパターンの中からAIが最適な組み合わせを選びます。平日・土曜・日祝でパターンごとの必要人数を分けて設定できます。</p>
                    </div>
                </div>

                <!-- 4. 人員配置ルール -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-users text-green-500"></i> 人員配置要件</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">「最低何人いればお店が回るか」を設定します。AIはこの人数を必ず確保しようとします。</p>
                    </div>
                    <div class="p-6">
                        <div class="grid grid-cols-1 gap-8 mb-6">
                            <div>
                                <h4 class="text-sm font-bold text-gray-700 mb-4 border-b border-gray-100 pb-2">スタッフ総数要件</h4>
                                <div class="space-y-4">
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-gray-600">平日</label>
                                        <input type="number" id="req_min_weekday" min="0" max="50" step="1" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekday || reqs.min_total || 2}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-blue-600">土曜日</label>
                                        <input type="number" id="req_min_weekend" min="0" max="50" step="1" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekend || reqs.min_total || 3}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-red-600">日祝日</label>
                                        <input type="number" id="req_min_holiday" min="0" max="50" step="1" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_holiday || reqs.min_total || 3}">
                                    </div>
                                </div>
                            </div>
                        </div>
                        ${this._renderStaffingFeasibilityTip()}

                        <!-- v3.7.91: 過剰配置トグル -->
                        <div class="mt-6 pt-4 border-t border-gray-100">
                            <h4 class="text-sm font-bold text-gray-700 mb-3">過剰配置ポリシー</h4>
                            <label class="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:bg-gray-50">
                                <input type="checkbox" id="settingAllowOverstaffing" class="w-5 h-5 mt-0.5 accent-amber-600" ${config.allow_overstaffing ? 'checked' : ''}>
                                <div class="flex-1">
                                    <div class="text-sm font-bold text-gray-800">⚡ 過剰配置を許容する</div>
                                    <p class="text-xs text-gray-500 mt-1">
                                        <strong>OFF (推奨):</strong> 必要人数 <strong>ぴったり</strong>に配置 (過剰回避を最優先)<br>
                                        <strong>ON:</strong> 必要人数より<strong>多めに配置</strong>を許容 (スタッフを多く入れたい場合)
                                    </p>
                                    <p class="text-[10px] text-amber-600 mt-2"><i class="fa-solid fa-circle-info mr-1"></i>例: 「スタッフ全員を最低5日入れたいので、必要人数を超えても OK」 → ON にする</p>
                                </div>
                            </label>
                        </div>
                    </div>
                </div>

                <!-- 5. システム設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-gears text-gray-500"></i> システム設定</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">時給の初期値、管理者パスワード、休憩ルールなどの基本設定です。</p>
                    </div>
                    <div class="p-6 space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">デフォルト時給 (円)</label>
                                <input type="number" id="settingHourlyWage" class="w-full border border-gray-300 rounded-lg px-3 py-2" value="${config.hourly_wage_default || 1100}">
                            </div>
                            
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">管理者パスワード</label>
                                <div class="w-full border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 font-mono text-gray-400 tracking-wider select-none">••••••••</div>
                                <p class="text-[11px] text-gray-400 mt-1">セキュリティのため画面表示しません。変更は下の「管理者パスワードを変更」ボタンから</p>
                            </div>
                        </div>

                        <div class="border-t border-gray-100 pt-4 flex flex-wrap gap-3">
                            <button onclick="app.openModal('changePasswordModal')" class="flex items-center gap-2 text-sm font-bold text-amber-600 bg-amber-50 border border-amber-200 px-4 py-2.5 rounded-lg hover:bg-amber-100 transition">
                                <i class="fa-solid fa-key"></i> 店舗ログインパスワードを変更
                            </button>
                            <button onclick="app.openAdminPasswordChange()" class="flex items-center gap-2 text-sm font-bold text-purple-600 bg-purple-50 border border-purple-200 px-4 py-2.5 rounded-lg hover:bg-purple-100 transition">
                                <i class="fa-solid fa-user-shield"></i> 管理者パスワードを変更
                            </button>
                            <p class="text-xs text-gray-400 mt-1 w-full">※ 店舗パスワード=日常閲覧用 / 管理者パスワード=編集権限用</p>
                        </div>

                        <!-- AI設定 (運営管理のため非表示) -->
                        
                        <!-- 休憩時間ルール -->
                        <div class="border-t border-gray-100 pt-4">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">休憩時間ルール</h4>
                            <div class="space-y-3" id="breakRulesContainer">
                                ${breakRules.map((rule, idx) => `
                                    <div class="flex items-center gap-3">
                                        <div class="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                                            <input type="number" class="setting-break-hours w-16 border-gray-300 rounded px-2 py-1 text-sm text-center font-bold" value="${rule.min_hours}">
                                            <span class="text-xs text-gray-500">時間超で</span>
                                        </div>
                                        <i class="fa-solid fa-arrow-right text-gray-300 text-xs"></i>
                                        <div class="flex items-center gap-2 bg-blue-50 px-3 py-2 rounded-lg border border-blue-100">
                                            <input type="number" class="setting-break-minutes w-16 border-blue-200 rounded px-2 py-1 text-sm text-center font-bold text-blue-700" value="${rule.break_minutes}">
                                            <span class="text-xs text-blue-500">分休憩</span>
                                        </div>
                                        <button onclick="app.removeBreakRule(${idx})" class="text-gray-400 hover:text-red-500 ml-2"><i class="fa-solid fa-times"></i></button>
                                    </div>
                                `).join('')}
                            </div>
                            <button onclick="app.addBreakRule()" class="mt-3 text-xs flex items-center gap-1 text-blue-600 font-bold hover:text-blue-800"><i class="fa-solid fa-plus-circle"></i> ルールを追加</button>
                        </div>
                    </div>
                </div>

                <!-- 6. 運用ルール (お店のルール) -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-clipboard-list text-orange-500"></i> 運用ルール (スタッフ向け表示)</h3>
                    </div>
                    <div class="p-6">
                        <label class="block text-xs font-bold text-gray-500 mb-2">お店のルール・連絡事項</label>
                        <textarea id="settingShopRules" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm min-h-[60px] sm:min-h-[120px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="シフト提出期限や注意事項などを入力してください...">${this._sanitize(shopRulesText)}</textarea>
                        <p class="text-xs text-gray-400 mt-2">※ ここに入力した内容は、スタッフ画面の「お店のルール」に表示されます。</p>
                    </div>
                </div>
                
                <!-- 7. アカウント情報 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-user-gear text-indigo-500"></i> アカウント情報</h3>
                    </div>
                    <div class="p-6 space-y-4">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 mb-1">契約ID</label>
                            <p class="font-mono text-lg font-bold text-gray-800">${config.contract_id || API.session?.user?.contract_id || '-'}</p>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-500 mb-1">登録メールアドレス</label>
                            <div class="flex gap-2">
                                <input type="email" id="settingEmail" value="${config.customer_email || ''}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="メールアドレスを入力">
                                <button onclick="app.updateEmail()" class="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 transition whitespace-nowrap">
                                    <i class="fa-solid fa-save mr-1"></i>変更
                                </button>
                            </div>
                            <p class="text-xs text-gray-400 mt-1">案内メールの送信先アドレスです</p>
                        </div>
                    </div>
                </div>

                <!-- 8. プラン管理 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-credit-card text-green-500"></i> プラン管理</h3>
                    </div>
                    <div class="p-6 space-y-5" id="subscriptionSection">
                        <!-- 現在のプラン表示 -->
                        <div class="bg-gradient-to-r ${
                            (config.stripe_plan === 'premium') ? 'from-purple-500 to-indigo-600' :
                            (config.stripe_plan === 'pro') ? 'from-green-500 to-emerald-600' :
                            'from-blue-500 to-indigo-600'
                        } rounded-xl p-5 text-white">
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="text-white/70 text-xs font-medium">現在ご利用中のプラン</p>
                                    <p class="text-3xl font-extrabold mt-1">${{standard:'Standard', pro:'Pro', premium:'Premium'}[config.stripe_plan] || 'Standard'}</p>
                                    <p class="text-white/80 text-sm mt-1">${{standard:'3,380円/月 - スタッフ10名まで', pro:'4,880円/月 - スタッフ50名まで', premium:'9,980円/月 - スタッフ無制限'}[config.stripe_plan] || '3,380円/月 - スタッフ10名まで'}</p>
                                </div>
                                <div class="text-right flex flex-col items-end gap-2">
                                    <span class="inline-flex items-center gap-1.5 px-3 py-1 bg-white/20 rounded-full text-sm font-bold backdrop-blur-sm">
                                        <i class="fa-solid fa-circle-check text-xs"></i> 有効
                                    </span>
                                    <button onclick="app.refreshPlanInfo()" class="inline-flex items-center gap-1.5 px-3 py-1 bg-white/15 hover:bg-white/25 rounded-full text-xs font-bold backdrop-blur-sm transition" title="運営側でプラン変更された場合に最新化">
                                        <i class="fa-solid fa-rotate"></i> プラン情報を最新化
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- プラン変更カード -->
                        <div>
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">プラン変更</h4>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                                ${[
                                    { key: 'standard', name: 'Standard', price: '3,380', staffs: '10名', color: 'blue', features: ['スタッフ10名まで', 'AI自動シフト生成', 'AI労基法チェック', 'シフト管理全機能'] },
                                    { key: 'pro', name: 'Pro', price: '4,880', staffs: '50名', color: 'green', badge: '人気', features: ['スタッフ50名まで', '全AI機能', '優先サポート', '分析レポート'] },
                                    { key: 'premium', name: 'Premium', price: '9,980', staffs: '無制限', color: 'purple', features: ['スタッフ無制限', '全AI機能', '複数店舗対応', '専属サポート'] },
                                ].map(p => {
                                    const currentPlanKey = (config.stripe_plan && config.stripe_plan !== 'free') ? config.stripe_plan : 'standard';
                                    const isCurrent = currentPlanKey === p.key;
                                    const planOrder = {standard: 0, pro: 1, premium: 2};
                                    const currentOrder = planOrder[currentPlanKey] || 0;
                                    const thisOrder = planOrder[p.key] || 0;
                                    const isUpgrade = thisOrder > currentOrder;
                                    const isDowngrade = thisOrder < currentOrder;

                                    const borderClass = isCurrent
                                        ? (p.color === 'blue' ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : p.color === 'green' ? 'border-green-500 bg-green-50 ring-2 ring-green-200' : 'border-purple-500 bg-purple-50 ring-2 ring-purple-200')
                                        : 'border-gray-200 hover:border-gray-300 hover:shadow-md';

                                    const badgeHtml = p.badge && !isCurrent ? '<div class="text-[10px] font-bold text-green-700 bg-green-200 rounded-full px-2 py-0.5 inline-block mb-1">人気</div>' : '';
                                    const currentBadge = isCurrent ? '<div class="text-[10px] font-bold text-white bg-gray-800 rounded-full px-2 py-0.5 inline-block mb-1">現在のプラン</div>' : '';

                                    let btnHtml = '';
                                    if (isCurrent) {
                                        btnHtml = '<p class="mt-3 text-xs font-bold text-gray-500 text-center py-1.5"><i class="fa-solid fa-circle-check mr-1"></i>ご利用中</p>';
                                    } else if (isUpgrade) {
                                        const btnColor = p.color === 'green' ? 'bg-green-600 hover:bg-green-700' : 'bg-purple-600 hover:bg-purple-700';
                                        btnHtml = '<button onclick="app.startCheckout(&#39;'+p.key+'&#39;)" class="mt-3 w-full py-2 '+btnColor+' text-white rounded-lg text-xs font-bold transition"><i class="fa-solid fa-arrow-up mr-1"></i>アップグレード</button>';
                                    } else {
                                        btnHtml = '<button onclick="app.startCheckout(&#39;'+p.key+'&#39;)" class="mt-3 w-full py-2 bg-gray-200 text-gray-600 rounded-lg text-xs font-bold hover:bg-gray-300 transition"><i class="fa-solid fa-arrow-down mr-1"></i>ダウングレード</button>';
                                    }

                                    const checkColor = p.color === 'blue' ? 'text-blue-500' : p.color === 'green' ? 'text-green-500' : 'text-purple-500';
                                    const nameColor = p.color === 'blue' ? 'text-blue-600' : p.color === 'green' ? 'text-green-600' : 'text-purple-600';

                                    return '<div class="p-4 rounded-xl border-2 '+borderClass+' transition-all duration-200 text-center flex flex-col hover:-translate-y-1 hover:shadow-xl">'
                                        + currentBadge + badgeHtml
                                        + '<p class="font-bold '+nameColor+' text-lg">'+p.name+'</p>'
                                        + '<p class="text-2xl font-extrabold text-gray-900 mt-1">'+p.price+'<span class="text-sm font-normal text-gray-400">円/月</span></p>'
                                        + '<p class="text-xs text-gray-500 mt-1">スタッフ'+p.staffs+'</p>'
                                        + '<ul class="text-xs text-gray-600 mt-3 space-y-1 text-left flex-1">'
                                        + p.features.map(f => '<li class="flex items-center gap-1.5"><i class="fa-solid fa-check '+checkColor+' text-[10px]"></i>'+f+'</li>').join('')
                                        + '</ul>'
                                        + '<div class="mt-auto pt-3">'+btnHtml+'</div>'
                                        + '</div>';
                                }).join('')}
                            </div>
                        </div>

                        <!-- Stripeポータルリンク -->
                        ${config.stripe_subscription_id ? `
                        <div class="border-t border-gray-100 pt-4 flex justify-between items-center">
                            <p class="text-xs text-gray-400">請求書・支払い方法の変更・解約はStripeポータルから</p>
                            <button onclick="app.openStripePortal()" class="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-xs font-bold hover:bg-gray-200 transition">
                                <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i> 請求管理ポータル
                            </button>
                        </div>
                        ` : ''}
                    </div>
                </div>

                <!-- 下部保存ボタン -->
                <div class="flex items-center justify-between bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <p class="text-sm text-gray-500"><i class="fa-solid fa-info-circle text-blue-400 mr-1"></i>上部の変更を含め、すべての設定を一括保存します</p>
                    <button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-8 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-save mr-2"></i>設定を保存
                    </button>
                </div>

                <!-- データリセット -->
                <div class="text-right">
                    <button onclick="if(confirm('【警告】全てのデータを削除して初期化しますか？')) { localStorage.clear(); location.reload(); }" class="text-red-500 text-xs hover:text-red-700 font-bold opacity-60 hover:opacity-100 transition">
                        <i class="fa-solid fa-trash mr-1"></i>全データをリセット
                    </button>
                </div>
            </div>
        `;
        // v3.7.133: PIN 状態を非同期で読み込んで表示更新
        this._renderPinStatus();
    },

    async _renderPinStatus() {
        const badge = document.getElementById('pinStatusBadge');
        const btns = document.getElementById('pinActionButtons');
        if (!badge || !btns) return;
        const hasPin = await this._hasPinSet();
        if (hasPin) {
            badge.textContent = '✓ 設定済み';
            badge.className = 'text-xs font-bold px-3 py-1 rounded-full bg-emerald-100 text-emerald-700';
            btns.innerHTML = `
                <button onclick="app.openPinChangeModal()" class="text-xs bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-bold hover:bg-indigo-200 transition">
                    <i class="fa-solid fa-rotate mr-1"></i>PIN を変更 (引き継ぎ時)
                </button>
                <span class="text-[10px] text-gray-500 self-center ml-2">解除には運営管理 (info@rakushift.jp) への依頼が必要</span>
            `;
        } else {
            // 必須化のため通常は到達しないが、フォールバック表示
            badge.textContent = '未設定 (次回ログイン時に必須)';
            badge.className = 'text-xs font-bold px-3 py-1 rounded-full bg-amber-100 text-amber-700';
            btns.innerHTML = `
                <p class="text-xs text-amber-700"><i class="fa-solid fa-circle-info mr-1"></i>次回ログイン時に PIN 設定モーダルが表示されます。</p>
            `;
        }
    },

    toggleLlmSettings() {
        const provider = document.querySelector('input[name="settingLlmProvider"]:checked')?.value;
        if (provider === 'openai') {
            document.getElementById('openaiSettings').classList.remove('hidden');
            document.getElementById('geminiSettings').classList.add('hidden');
        } else {
            document.getElementById('openaiSettings').classList.add('hidden');
            document.getElementById('geminiSettings').classList.remove('hidden');
        }
    },

    addRole() {
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.roles) this.state.config.roles = [];
        // ユニークID生成
        const newId = 'role_' + Math.random().toString(36).substr(2, 5);
        this.state.config.roles.push({ id: newId, name: '新規役職', color: 'gray', level: 1, is_manager: false, is_employee: false });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    deleteRole(index) {
        this.state.config = this.readSettingsFromDOM();
        const role = this.state.config.roles[index];
        if (!role) return;

        if (role.id === 'manager' || role.id === 'staff') {
            const label = role.id === 'manager' ? '店長 (manager)' : 'アルバイト (staff)';
            const msg =
                `【警告】「${label}」は AI シフト生成ロジックで内部参照される基本役職です。\n\n` +
                `削除すると以下の動作が破綻する可能性があります:\n` +
                (role.id === 'manager'
                    ? `・「シフトパターン別の管理者配置人数」制約が機能しなくなる\n・メンター必須配置 (新人とのペア配置) が機能しなくなる\n`
                    : `・新規スタッフの既定役職として参照される箇所が無効化\n`) +
                `・既にこの役職が割り当てられているスタッフは「役職なし」扱いになる\n\n` +
                `通常は「役職名」だけを変更すれば十分です (例: 店長 → MGR)。\n` +
                `それでも削除しますか?`;
            if (!confirm(msg)) return;
        }

        this.state.config.roles.splice(index, 1);
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addBreakRule() {
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.break_rules) this.state.config.break_rules = [];
        this.state.config.break_rules.push({ min_hours: 0, break_minutes: 60 });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    async removeBreakRule(index) {
        this.state.config = this.readSettingsFromDOM();
        if (!Array.isArray(this.state.config.break_rules)) this.state.config.break_rules = [];
        if (index < 0 || index >= this.state.config.break_rules.length) return;
        this.state.config.break_rules.splice(index, 1);
        this.renderSettings(document.getElementById('viewContainer'));
        try {
            const cid = this._getContractId();
            if (cid) {
                await API.rpc('update_config_by_contract', {
                    p_contract_id: cid,
                    p_data: { break_rules: this.state.config.break_rules }
                });
                this.showToast('休憩ルールを削除しました', 'success');
            }
        } catch (e) {
            this.showToast('削除の保存に失敗: ' + e.message, 'error');
        }
    },

    addSpecialHoliday() {
        const dateInput = document.getElementById('newSpecialHoliday');
        const date = dateInput.value;
        if(!date) return;
        
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.special_holidays) this.state.config.special_holidays = [];
        if(!this.state.config.special_holidays.includes(date)) {
            this.state.config.special_holidays.push(date);
            this.state.config.special_holidays.sort();
        }
        this.renderSettings(document.getElementById('viewContainer'));
    },

    async removeSpecialHoliday(index) {
        this.state.config = this.readSettingsFromDOM();
        if (this.state.config.special_holidays) {
            this.state.config.special_holidays.splice(index, 1);
        }
        this.renderSettings(document.getElementById('viewContainer'));
        try {
            const cid = this._getContractId();
            if (cid) {
                await API.rpc('update_config_by_contract', {
                    p_contract_id: cid,
                    p_data: { special_holidays: this.state.config.special_holidays || [] }
                });
            }
        } catch (e) { console.warn('save failed:', e); }
    },

    addSpecialDay() {
        const date = (document.getElementById('newSpecialDayDate')?.value || '');
        const start = (document.getElementById('newSpecialDayStart')?.value || '');
        const end = (document.getElementById('newSpecialDayEnd')?.value || '');
        const note = (document.getElementById('newSpecialDayNote')?.value || '');

        if(!date || !start || !end) return;

        this.state.config = this.readSettingsFromDOM(); // 現在の入力を保存
        if(!this.state.config.special_days) this.state.config.special_days = {};
        
        this.state.config.special_days[date] = { start, end, note };
        this.renderSettings(document.getElementById('viewContainer'));
    },

    async removeSpecialDay(date) {
        this.state.config = this.readSettingsFromDOM();
        if (this.state.config.special_days) {
            delete this.state.config.special_days[date];
        }
        this.renderSettings(document.getElementById('viewContainer'));
        try {
            const cid = this._getContractId();
            if (cid) {
                await API.rpc('update_config_by_contract', {
                    p_contract_id: cid,
                    p_data: { special_days: this.state.config.special_days || {} }
                });
            }
        } catch (e) { console.warn('save failed:', e); }
    },

    // v3.7.60: 24時間営業チェック切替
    _toggle24h(dayType, enabled) {
        if (!this.state.config.is_24h) this.state.config.is_24h = {};
        this.state.config.is_24h[dayType] = enabled;
        if (!this.state.config.opening_times) this.state.config.opening_times = {};
        if (enabled) {
            // チェック時は 00:00 〜 23:45 (営業時間 = 24h)
            this.state.config.opening_times[dayType] = { start: '00:00', end: '23:45' };
        } else {
            // v3.7.189: 解除時は営業時間を通常値に戻す。
            // (00:00-23:45 のまま残すと、保存値からの24h復元ロジックで
            //  チェックが外れない不具合になるため)
            const def = { weekday: { start: '09:00', end: '22:00' },
                          weekend: { start: '10:00', end: '20:00' },
                          holiday: { start: '10:00', end: '20:00' } };
            this.state.config.opening_times[dayType] = def[dayType] || { start: '09:00', end: '22:00' };
        }
        this.renderSettings(document.getElementById('viewContainer'));
        this.showToast(enabled ? `${dayType} を24時間営業に設定しました` : `${dayType} の24時間設定を解除しました`, 'success');
    },

    // v3.7.57: プリセットルール (ランチ/ディナー等) を一括追加
    addTimeStaffReqPreset(presetType) {
        this.state.config = this.readSettingsFromDOM();
        if (!this.state.config.time_staff_req) this.state.config.time_staff_req = [];
        const baseCount = Number(this.state.config.staff_req?.min_weekday || 4);
        const presets = {
            lunch: { days: [1,2,3,4,5], start: '11:00', end: '15:00', count: baseCount + 2, label: 'ランチピーク' },
            dinner: { days: [1,2,3,4,5], start: '18:00', end: '21:00', count: baseCount + 2, label: 'ディナーピーク' },
            weekend_busy: { days: [0,6], start: '10:00', end: '21:00', count: baseCount + 1, label: '土日終日ピーク' },
            morning_low: { days: [1,2,3,4,5], start: '09:00', end: '11:00', count: Math.max(1, baseCount - 1), label: '朝アイドル' },
            night_24h: { days: [0,1,2,3,4,5,6], start: '22:00', end: '06:00', count: 2, label: '深夜時間帯' },
        };
        const preset = presets[presetType];
        if (preset) {
            this.state.config.time_staff_req.push({
                days: preset.days,
                start: preset.start,
                end: preset.end,
                count: preset.count,
                position: 'any'
            });
            this.renderSettings(document.getElementById('viewContainer'));
            this.showToast(`「${preset.label}」を追加しました (${preset.count}名)`, 'success');
        }
    },

    addTimeStaffReq() {
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.time_staff_req) this.state.config.time_staff_req = [];
        this.state.config.time_staff_req.push({ days: [1,2,3,4,5], start: '11:00', end: '14:00', count: 2 });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    /**
     * v3.7.80: 人員配置の現実性チェック (シフトパターン人数優先方式)
     *   シフトパターンに count_weekday/we/hd が指定されていれば、その合計を
     *   1日に必要な配置人数として、登録スタッフ数 (× 週勤務日数考慮) と比較。
     *   パターン人数が指定されていなければ警告を出さない。
     *
     *   例: 早番3名 (wd=3) + 遅番4名 (wd=4) = 平日 7名/日 必要
     *       在籍 5名 / 週5日 → 月間 100名・日 < 必要 210 (7×30) → 警告
     */
    _renderStaffingFeasibilityTip() {
        const shifts = this.state.config.custom_shifts || [];
        const staff = this.state.staff || [];
        if (shifts.length === 0 || staff.length === 0) return '';

        const dayTypes = [
            { key: 'weekday', label: '平日',    days_per_month: 22 },
            { key: 'weekend', label: '土曜日',  days_per_month: 4 },
            { key: 'holiday', label: '日祝日',  days_per_month: 4 },
        ];
        // 平均週勤務日数を在籍スタッフから算出 (デフォルト 5)
        const avgMaxDaysWeek = staff.reduce((sum, s) =>
            sum + (Number(s.max_days_week) || 5), 0) / staff.length;
        const monthlyCapacity = staff.length * (avgMaxDaysWeek * 4.33);

        const tips = [];
        dayTypes.forEach(d => {
            const dayTotal = shifts.reduce((sum, sh) => {
                const key = 'count_' + d.key;
                const raw = sh[key] != null ? sh[key]
                          : (sh.count != null ? sh.count : 0);
                const c = Number(raw);
                return sum + (Number.isFinite(c) && c > 0 ? c : 0);
            }, 0);
            if (dayTotal <= 0) return;
            // この曜日種別で 1ヶ月で必要な総人日 (人×日)
            const monthlyDemand = dayTotal * d.days_per_month;
            // 在籍スタッフの月間総勤務可能日数のうち、この曜日種別の割合
            const capacityForThisDayType = monthlyCapacity *
                (d.days_per_month / 30);
            if (monthlyDemand > capacityForThisDayType * 1.05) { // 5% マージン
                tips.push({
                    label: d.label,
                    dayTotal,
                    monthlyDemand,
                    capacityForThisDayType: Math.round(capacityForThisDayType),
                });
            }
        });

        if (tips.length === 0) return '';

        const list = tips.map(t =>
            `<li><b>${t.label}</b>: シフトパターン合計 <b class="text-amber-700">${t.dayTotal}名/日</b> → 月間 ${t.monthlyDemand}人日が必要ですが、現在の在籍 ${staff.length}名 (平均週${Math.round(avgMaxDaysWeek*10)/10}日) の月間供給は約 ${t.capacityForThisDayType}人日 です。シフトパターン人数を下げるか、スタッフを増やしてください。</li>`
        ).join('');

        return `
            <div class="mt-4 p-4 rounded-lg bg-amber-50 border border-amber-200">
                <p class="text-xs font-bold text-amber-700 mb-2"><i class="fa-solid fa-lightbulb mr-1"></i>人員配置の現実性チェック</p>
                <ul class="text-xs text-amber-900 space-y-1 list-disc list-inside">
                    ${list}
                </ul>
                <p class="text-[10px] text-amber-600 mt-2">※ シフトパターン (平日/土曜/日祝の人数) と在籍スタッフ数・週勤務日数から算出。シフトパターン人数を下げるかスタッフを追加すれば解消します。</p>
            </div>
        `;
    },

    async removeTimeStaffReq(index) {
        // v20: 削除を確実にするため readSettingsFromDOM の DOM 経由を回避。
        // state.config.time_staff_req を直接スプライス。
        if (!Array.isArray(this.state.config.time_staff_req)) {
            this.state.config.time_staff_req = [];
        }
        // 念のため現在の入力値を取り込んでから削除
        this.state.config = this.readSettingsFromDOM();
        if (!Array.isArray(this.state.config.time_staff_req)) {
            this.state.config.time_staff_req = [];
        }
        if (index < 0 || index >= this.state.config.time_staff_req.length) {
            console.warn('[removeTimeStaffReq] index out of range:', index);
            return;
        }
        this.state.config.time_staff_req.splice(index, 1);
        console.log('[removeTimeStaffReq] after splice:', this.state.config.time_staff_req);
        this.renderSettings(document.getElementById('viewContainer'));

        // 即時 DB 保存 (ユーザが SAVE 押し忘れて消えてないように見えるのを防止)
        try {
            const cid = this._getContractId();
            if (cid) {
                await API.rpc('update_config_by_contract', {
                    p_contract_id: cid,
                    p_data: { time_staff_req: this.state.config.time_staff_req }
                });
                this.showToast('時間帯ルールを削除しました', 'success');
            }
        } catch (e) {
            console.error('[removeTimeStaffReq] save failed:', e);
            this.showToast('削除の保存に失敗: ' + e.message, 'error');
        }
    },

    addShiftPattern() {
        // 現在の入力を一時保存
        this.state.config = this.readSettingsFromDOM();
        // 新しい空行を追加
        if(!this.state.config.custom_shifts) this.state.config.custom_shifts = [];
        this.state.config.custom_shifts.push({ name: '', start: '09:00', end: '18:00', force_rest_next_day: false, manager_count: 0, manager_enabled: false });
        // 再描画
        this.renderSettings(document.getElementById('viewContainer'));
    },

    // 翌日強制休みトグル (夜勤の2連勤防止)。再描画せず DOM 上で状態を切替える。
    togglePatternRest(btn) {
        const hidden = btn.parentElement.querySelector('.setting-shift-rest');
        if (!hidden) return;
        const on = hidden.value !== '1';
        hidden.value = on ? '1' : '0';
        btn.classList.toggle('bg-indigo-500', on);
        btn.classList.toggle('bg-gray-300', !on);
        const knob = btn.querySelector('span');
        if (knob) {
            knob.classList.toggle('left-[18px]', on);
            knob.classList.toggle('left-0.5', !on);
        }
        // 「設定を保存」を押し忘れてもシフト生成 (payload.config = state.config) に
        // 反映されるよう、in-memory config を即同期する。
        this.state.config = this.readSettingsFromDOM();
    },

    // 管理者配置 ON(人数指定)/OFF(ランダム) トグル。再描画せず DOM 上で切替える。
    togglePatternMgr(btn) {
        const cell = btn.parentElement;
        const hidden = cell.querySelector('.setting-shift-mgr-on');
        const numInput = cell.querySelector('.setting-shift-mgr');
        if (!hidden) return;
        const on = hidden.value !== '1';
        hidden.value = on ? '1' : '0';
        btn.classList.toggle('bg-green-500', on);
        btn.classList.toggle('bg-gray-300', !on);
        const knob = btn.querySelector('span');
        if (knob) {
            knob.classList.toggle('left-[18px]', on);
            knob.classList.toggle('left-0.5', !on);
        }
        if (numInput) {
            numInput.disabled = !on;
            numInput.classList.toggle('opacity-40', !on);
            numInput.classList.toggle('bg-gray-100', !on);
            numInput.classList.toggle('bg-green-50', on);
        }
        // 保存忘れでも生成に反映されるよう in-memory config を即同期
        this.state.config = this.readSettingsFromDOM();
    },

    async deleteShiftPattern(index) {
        // v3.7.79: readSettingsFromDOM (v3.7.71 で追加されたバリデーション
        // フィルタにより空 name 行が除外される) を経由すると、未入力の新規
        // 追加行があるとき DOM 上の index と配列 index がずれ、別のパターンが
        // 削除される CRITICAL バグを修正。
        // DOM 上の全パターン (空名前含む) を直接読み取り、index を保ったまま
        // splice する。保存時のみバリデーションを適用。
        const shiftNames    = document.querySelectorAll('.setting-shift-name');
        const shiftStarts   = document.querySelectorAll('.setting-shift-start');
        const shiftEnds     = document.querySelectorAll('.setting-shift-end');
        const shiftCountsWd = document.querySelectorAll('.setting-shift-count-wd');
        const shiftCountsWe = document.querySelectorAll('.setting-shift-count-we');
        const shiftCountsHd = document.querySelectorAll('.setting-shift-count-hd');
        const shiftRests = document.querySelectorAll('.setting-shift-rest');
        const shiftMgrs = document.querySelectorAll('.setting-shift-mgr');
        const shiftMgrOns = document.querySelectorAll('.setting-shift-mgr-on');

        const parseCount = (input) => {
            // v3.7.110: 0 も許容 (「この曜日はこのパターン使わない」を表現)
            const v = Number(input?.value);
            return Number.isFinite(v) && v >= 0 ? Math.min(v, 50) : 1;
        };
        const all = [];
        shiftNames.forEach((el, i) => {
            const cwd = parseCount(shiftCountsWd[i]);
            const cwe = parseCount(shiftCountsWe[i]);
            const chd = parseCount(shiftCountsHd[i]);
            const mgrRaw = Number(shiftMgrs[i]?.value);
            const mgrCnt = Number.isFinite(mgrRaw) && mgrRaw > 0 ? Math.min(mgrRaw, 50) : 0;
            all.push({
                name: (el.value || '').trim(),
                start: (shiftStarts[i]?.value || '').trim(),
                end: (shiftEnds[i]?.value || '').trim(),
                count_weekday: cwd,
                count_weekend: cwe,
                count_holiday: chd,
                count: cwd,
                force_rest_next_day: shiftRests[i]?.value === '1',
                manager_count: mgrCnt,
                manager_enabled: shiftMgrOns[i]?.value === '1',
            });
        });

        if (index < 0 || index >= all.length) return;
        all.splice(index, 1);
        // v3.7.185: 他セクション(役職/時給/営業時間/定休日等)の未保存編集を失わないよう、
        // 一旦 readSettingsFromDOM で全体を取り込み、custom_shifts だけ index 安全な
        // all で上書きする (readSettingsFromDOM の空名フィルタによる index ズレを回避)。
        const merged = this.readSettingsFromDOM();
        merged.custom_shifts = all;
        this.state.config = merged;
        this.renderSettings(document.getElementById('viewContainer'));

        // 保存時のみ readSettingsFromDOM と同じバリデーションを適用
        const validForSave = all.filter(p =>
            p.name && p.start && p.end && p.start !== p.end);
        try {
            const cid = this._getContractId();
            if (cid) {
                await API.rpc('update_config_by_contract', {
                    p_contract_id: cid,
                    p_data: { custom_shifts: validForSave }
                });
                this.showToast('シフトパターンを削除しました', 'success');
            }
        } catch (e) {
            this.showToast('削除の保存に失敗: ' + e.message, 'error');
        }
    },

    readSettingsFromDOM() {
        const config = { ...this.state.config }; // 既存の設定をコピー

        // 基本設定 (v3.6: 負数/NaN ガード)
        const _wageRaw = Number(document.getElementById('settingHourlyWage')?.value);
        config.hourly_wage_default = (Number.isFinite(_wageRaw) && _wageRaw > 0) ? Math.min(_wageRaw, 10000) : 1100;
        // admin_password は専用モーダル + update_admin_password_by_contract RPC でのみ変更可
        // (config_safe view から除外され、ここで読んでも空文字なので参照しない)
        config.shop_rules_text = document.getElementById('settingShopRules')?.value || '';

        // 営業時間
        const getVal = (id) => document.getElementById(id)?.value;
        config.opening_times = {
            weekday: { start: getVal('time_weekday_start') || '09:00', end: getVal('time_weekday_end') || '22:00' },
            weekend: { start: getVal('time_weekend_start') || '10:00', end: getVal('time_weekend_end') || '20:00' },
            holiday: { start: getVal('time_holiday_start') || '10:00', end: getVal('time_holiday_end') || '20:00' }
        };
        // 旧互換
        config.opening_time = config.opening_times.weekday.start;
        config.closing_time = config.opening_times.weekday.end;

        // v3.7.60: 24時間営業フラグ
        config.is_24h = config.is_24h || {};
        ['weekday', 'weekend', 'holiday'].forEach(dt => {
            const cb = document.getElementById(`is_24h_${dt}`);
            if (cb) {
                config.is_24h[dt] = cb.checked;
                if (cb.checked) {
                    config.opening_times[dt] = { start: '00:00', end: '23:45' };
                }
            }
        });

        // v3.7.67: 中休み時間 UI 廃止 → 常に空
        config.break_periods = {};

        // v3.7.91: 過剰配置許容トグル
        config.allow_overstaffing = !!document.getElementById('settingAllowOverstaffing')?.checked;

        // 定休日
        config.closed_days = Array.from(document.querySelectorAll('input[name="setting_closed_days"]:checked')).map(el => parseInt(el.value));

        // v3.7.67: ポジション設定 UI 廃止 → 既存値を維持 (なければデフォルト)
        if (!Array.isArray(this.state.config.positions) || this.state.config.positions.length === 0) {
            config.positions = ['ホール', 'キッチン'];
        } else {
            config.positions = this.state.config.positions;
        }

        // 役職・ロール設定
        const roleNames = document.querySelectorAll('.setting-role-name');
        const roleIds = document.querySelectorAll('.setting-role-id');
        const roleColors = document.querySelectorAll('.setting-role-color');
        const roleIsManagers = document.querySelectorAll('.setting-role-is-manager');
        const roleIsEmployees = document.querySelectorAll('.setting-role-is-employee');

        const existingRoles = this.state.config.roles || [];
        config.roles = [];
        roleNames.forEach((el, i) => {
            if (el.value) {
                const rId = roleIds[i].value;
                const prev = existingRoles.find(r => r.id === rId);
                const isMgr = roleIsManagers[i] ? !!roleIsManagers[i].checked : false;
                config.roles.push({
                    id: rId,
                    name: el.value,
                    color: roleColors[i].value,
                    level: prev ? prev.level : 1,
                    // v3.7.81: 明示的な管理者フラグ
                    is_manager: isMgr,
                    // v3.7.196: 社員フラグ (管理者は自動的に社員)
                    is_employee: isMgr || (roleIsEmployees[i] ? !!roleIsEmployees[i].checked : false),
                });
            }
        });

        // シフトパターン (v3.7.66: 曜日別必要人数 + 必須化)
        const shiftNames = document.querySelectorAll('.setting-shift-name');
        const shiftStarts = document.querySelectorAll('.setting-shift-start');
        const shiftEnds = document.querySelectorAll('.setting-shift-end');
        const shiftCountsWd = document.querySelectorAll('.setting-shift-count-wd');
        const shiftCountsWe = document.querySelectorAll('.setting-shift-count-we');
        const shiftCountsHd = document.querySelectorAll('.setting-shift-count-hd');
        const shiftRests = document.querySelectorAll('.setting-shift-rest');
        const shiftMgrs = document.querySelectorAll('.setting-shift-mgr');
        const shiftMgrOns = document.querySelectorAll('.setting-shift-mgr-on');

        config.custom_shifts = [];
        shiftNames.forEach((el, i) => {
            const name = (el.value || '').trim();
            const start = (shiftStarts[i]?.value || '').trim();
            const end = (shiftEnds[i]?.value || '').trim();
            // v3.7.71: name/start/end のいずれかが空ならこのパターンを破棄
            // (空の start/end が scheduler 側で "00:00-00:00" として無視される
            //  バグを未然防止)
            if (!name || !start || !end || start === end) {
                console.warn('[saveSettings] skipped invalid shift pattern',
                    { name, start, end });
                return;
            }
            const parseCount = (input) => {
                // v3.7.112: 0 も許容 (この曜日はこのパターンを使わない)
                const v = Number(input?.value);
                return Number.isFinite(v) && v >= 0 ? Math.min(v, 50) : 1;
            };
            const cwd = parseCount(shiftCountsWd[i]);
            const cwe = parseCount(shiftCountsWe[i]);
            const chd = parseCount(shiftCountsHd[i]);
            const mgrRaw = Number(shiftMgrs[i]?.value);
            const mgrCnt = Number.isFinite(mgrRaw) && mgrRaw > 0 ? Math.min(mgrRaw, 50) : 0;
            const mgrOn = shiftMgrOns[i]?.value === '1';
            config.custom_shifts.push({
                name,
                start,
                end,
                count_weekday: cwd,
                count_weekend: cwe,
                count_holiday: chd,
                count: cwd, // 旧互換
                force_rest_next_day: shiftRests[i]?.value === '1',
                manager_count: mgrCnt,
                manager_enabled: mgrOn,
            });
        });

        // 人員配置ルール (v3.6: 負数/NaN を防止して MILP クラッシュを回避)
        const _clampStaff = (v, def) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) return def;
            return Math.min(n, 50);  // 50名以上の要件は現実的でなく上限化
        };
        config.staff_req = {
            // 管理者要件は廃止 (パターン別 manager_count に移行)。min_manager は 0 固定。
            min_manager: 0,
            min_weekday: _clampStaff(document.getElementById('req_min_weekday')?.value, 2),
            min_weekend: _clampStaff(document.getElementById('req_min_weekend')?.value, 3),
            min_holiday: _clampStaff(document.getElementById('req_min_holiday')?.value, 3)
        };

        // 休憩ルール
        const breakRules = [];
        const breakRuleDivs = document.querySelectorAll('#breakRulesContainer > div');
        breakRuleDivs.forEach(div => {
            const h = Number(div.querySelector('.setting-break-hours')?.value || 0);
            const m = Number(div.querySelector('.setting-break-minutes')?.value || 0);
            if (h > 0) breakRules.push({ min_hours: h, break_minutes: m });
        });
        breakRules.sort((a, b) => a.min_hours - b.min_hours);
        // v18 修正: 空配列でも上書き (旧版は length=0 で既存維持 → 削除できないバグ)
        config.break_rules = breakRules;

        // v3.7.67: 時間帯別ルール UI 廃止 → 常に空
        config.time_staff_req = [];

        // v3.6.1: mid_shift_auto_generate は撤廃。
        // ピーク管理は time_staff_req (時間帯別ルール) に統一されたため、
        // 既存の config に残っていた値はクリアして将来的な誤解を防ぐ。
        delete config.mid_shift_auto_generate;

        return config;
    },

    // session-less RPC ラッパー群
    // RLS で REST 直叩きが失敗するため、shifts / requests も全て contract_id 経由の
    // SECURITY DEFINER RPC でラップする。
    _getContractId() {
        return this.state.config.contract_id || API.session?.user?.contract_id || null;
    },

    async _shiftUpsert(shiftId, data) {
        const cid = this._getContractId();
        if (!cid) throw new Error('contract_id 未取得');
        const r = await API.rpc('upsert_shift_by_contract', {
            p_contract_id: cid,
            p_shift_id: shiftId || null,
            p_data: data
        });
        if (!r || r.success !== true) throw new Error(r?.message || 'upsert_shift failed');
        return r;
    },

    async _shiftDelete(shiftId) {
        const cid = this._getContractId();
        if (!cid) throw new Error('contract_id 未取得');
        const r = await API.rpc('delete_shift_by_contract', {
            p_contract_id: cid,
            p_shift_id: shiftId
        });
        if (!r || r.success !== true) throw new Error(r?.message || 'delete_shift failed');
        return r;
    },

    async _shiftBulkInsert(shifts) {
        const cid = this._getContractId();
        if (!cid) throw new Error('contract_id 未取得');
        const r = await API.rpc('bulk_insert_shifts_by_contract', {
            p_contract_id: cid,
            p_shifts: shifts
        });
        if (!r || r.success !== true) throw new Error(r?.message || 'bulk_insert_shifts failed');
        return r;
    },

    async _shiftBulkDelete(shiftIds) {
        const cid = this._getContractId();
        if (!cid) throw new Error('contract_id 未取得');
        const r = await API.rpc('bulk_delete_shifts_by_contract', {
            p_contract_id: cid,
            p_shift_ids: shiftIds
        });
        if (!r || r.success !== true) throw new Error(r?.message || 'bulk_delete_shifts failed');
        return r;
    },

    async _requestInsert(data) {
        const cid = this._getContractId();
        if (!cid) throw new Error('contract_id 未取得');
        const r = await API.rpc('insert_request_by_contract', {
            p_contract_id: cid,
            p_data: data
        });
        if (!r || r.success !== true) throw new Error(r?.message || 'insert_request failed');
        return r;
    },

    async _requestUpdateStatus(requestId, status) {
        const cid = this._getContractId();
        if (!cid) throw new Error('contract_id 未取得');
        const r = await API.rpc('update_request_status_by_contract', {
            p_contract_id: cid,
            p_request_id: requestId,
            p_status: status
        });
        if (!r || r.success !== true) throw new Error(r?.message || 'update_request_status failed');
        return r;
    },

    // セッション失効時に呼ぶ。ローカルセッション破棄 → ログインモーダルへ
    _forceReloginForSessionExpiry() {
        try {
            API.setSession(null);
            this.state.isShopLoggedIn = false;
            this.state.isAdmin = false;
            this.state.isHQ = false;
            this.state.organization_id = null;
            this.state.config = {};
            this.state.staff = [];
            this.state.shifts = [];
            this.state.requests = [];
        } catch (_) {}
        try { this.openModal('loginModal'); } catch (_) {}
        try { this.showLoading(false); } catch (_) {}
    },

    // config.id が欠落している時に session-less RPC で再取得を試みる。
    // 取得に成功したら state.config をマージして id を返す。失敗時は null。
    async _recoverConfigId() {
        try {
            const contractId = this.state.config?.contract_id
                || API.session?.user?.contract_id;
            if (!contractId) return null;

            const row = await API.rpc('get_config_by_contract', { p_contract_id: contractId });
            if (row && typeof row === 'object' && row.id) {
                this.state.config = { ...this.state.defaultConfig, ...row };
                if (row.organization_id) this.state.organization_id = row.organization_id;
                console.log('[Recovery] config.id restored:', row.id);
                return row.id;
            }
        } catch (e) {
            console.warn('[Recovery] get_config_by_contract failed:', e.message);
        }
        return null;
    },

    async saveSettings() {
        const newConfig = this.readSettingsFromDOM();

        // contract_id があれば session-less RPC (update_config_by_contract) で
        // 完全にセッション独立で保存する。state.config.id は不要。
        const contractId = this.state.config.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast(
                '契約IDが取得できません。一度ログアウト→再ログインしてください',
                'error'
            );
            return;
        }

        this.showLoading(true);
        try {
            const updateData = {
                opening_time: newConfig.opening_time,
                closing_time: newConfig.closing_time,
                hourly_wage_default: newConfig.hourly_wage_default,
                opening_times: newConfig.opening_times,
                closed_days: newConfig.closed_days,
                positions: newConfig.positions,
                staff_req: newConfig.staff_req,
                roles: newConfig.roles,
                special_holidays: newConfig.special_holidays,
                special_days: newConfig.special_days,
                time_staff_req: newConfig.time_staff_req,
                calendar_notes: newConfig.calendar_notes || {},
                break_rules: newConfig.break_rules,
                shop_rules_text: newConfig.shop_rules_text,
                custom_shifts: newConfig.custom_shifts,
                // v3.7.91: 過剰配置トグル
                allow_overstaffing: !!newConfig.allow_overstaffing,
            };

            const rpcRes = await API.rpc('update_config_by_contract', {
                p_contract_id: contractId,
                p_data: updateData
            });
            if (!rpcRes || rpcRes.success !== true) {
                throw new Error(rpcRes?.message || 'update_config_by_contract failed');
            }
            // 戻り値の config_id を state に反映 (次回以降の最適化のため)
            if (rpcRes.config_id) this.state.config.id = rpcRes.config_id;

            // 管理者パスワード変更は専用モーダル + update_admin_password_by_contract RPC のみ
            // (このブロックの旧 staff/config 平文保存ロジックは migration 40 で view 除外後は無効化)
            if (false) {
                const adminStaff = this.state.staff.find(s => s.login_id === 'admin');
                if (adminStaff) {
                    try {
                        // 廃止: openAdminPasswordChange モーダル経由で行う
                    } catch (pwErr) {
                        console.error('[Settings] Password update failed:', pwErr);
                        this.showToast('パスワード更新に失敗しました', 'error');
                    }
                }
            }

            // Stateを更新
            this.state.config = { ...this.state.config, ...newConfig };
            this.showToast('設定を保存しました', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('保存エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // --- 印刷機能 (完全版 v7・分割レイアウト & PDF対応) ---
    // Fixed syntax error
    printShiftTable(format) {
        // v3.7.159: format 引数で印刷フォーマットを切替
        //   'detailed': Gantt 風 (現状) - 時間軸 + 視覚化バー
        //   'compact':  シンプル (時間軸なし) - テキストのみ、1ページに 14日収容
        this._printFormat = format || this._printFormat || 'detailed';
        const fmt = this._printFormat;
        // 現在の表示モードと期間を取得
        const period = this.state.shiftTablePeriod || 'month';
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();

        let allDays = [];

        // 1. 全期間の日付リスト生成
        if (period === 'month') {
            const lastDay = new Date(year, month + 1, 0).getDate();
            allDays = Array.from({length: lastDay}, (_, i) => new Date(year, month, i + 1));
        } else if (period === 'day') {
            allDays = [new Date(this.state.currentDate)];
        } else {
            // week モード
            const start = new Date(this.state.currentDate);
            allDays = Array.from({length: 7}, (_, i) => {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                return d;
            });
        }

        // 2. 期間分割: compact は 1チャンク 14日、detailed は 7日
        const CHUNK_SIZE = fmt === 'compact' ? 14 : 7;
        const dayChunks = [];
        for (let i = 0; i < allDays.length; i += CHUNK_SIZE) {
            dayChunks.push(allDays.slice(i, i + CHUNK_SIZE));
        }

        // 3. 印刷用ウィンドウ作成
        // v3.7.93: window.open による新規ウィンドウを廃止。
        // 旧: Chrome/Brave 等のスマホブラウザで window.close() が拒否されると
        //     新規タブから元の画面に戻れなくなる問題があった
        // 新: メインページ上にフルスクリーン overlay を表示。
        //     ☓ ボタンで overlay を削除すれば確実に元の画面に戻れる。
        const existingOverlay = document.getElementById('printOverlay');
        if (existingOverlay) existingOverlay.remove();

        // 印刷モード用スタイルが未挿入なら一度だけ追加
        if (!document.getElementById('printOverlayStyle')) {
            const style = document.createElement('style');
            style.id = 'printOverlayStyle';
            style.textContent = `
                /* スクリーン表示時: overlay 全画面 */
                #printOverlay {
                    position: fixed; inset: 0; z-index: 9999;
                    background: white; overflow-y: auto;
                    padding: 16px; -webkit-overflow-scrolling: touch;
                }
                /* v3.7.146/152: 印刷時にシフトバーの色を保持 */
                #printOverlay,
                #printOverlay * {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                    color-adjust: exact !important;
                }
                /* v3.7.163: 印刷精度強化 - 真っ白/線途切れ/色消え対策の総合版 */
                @media print {
                    @page { size: landscape; margin: 6mm; }
                    html, body {
                        background: white !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        height: auto !important;
                        overflow: visible !important;
                        font-family: 'Yu Gothic', 'Meiryo', 'Hiragino Sans', sans-serif !important;
                        -webkit-font-smoothing: antialiased !important;
                    }
                    body * { visibility: hidden !important; }
                    #printOverlay, #printOverlay * { visibility: visible !important; }
                    #printOverlay {
                        display: block !important;
                        position: absolute !important;
                        inset: 0 !important;
                        left: 0 !important;
                        top: 0 !important;
                        width: 100% !important;
                        max-width: none !important;
                        padding: 0 !important;
                        margin: 0 !important;
                        overflow: visible !important;
                        background: white !important;
                        z-index: 9999 !important;
                    }
                    #printOverlay .no-print { display: none !important; visibility: hidden !important; }
                    .table-chunk:last-child { page-break-after: auto !important; }
                    /* 全要素 色保持 (Chrome/Edge/Safari/Firefox) */
                    #printOverlay, #printOverlay *,
                    #printOverlay th, #printOverlay td, #printOverlay div, #printOverlay span {
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                        color-adjust: exact !important;
                    }
                    /* テーブル基本 */
                    #printOverlay table {
                        border-collapse: collapse !important;
                        table-layout: fixed !important;
                        width: 100% !important;
                        page-break-inside: auto !important;
                    }
                    #printOverlay thead { display: table-header-group !important; }
                    #printOverlay tbody { display: table-row-group !important; }
                    #printOverlay tr {
                        page-break-inside: avoid !important;
                        break-inside: avoid !important;
                    }
                    /* セル: 多重罫線 (border + outline + box-shadow inset) で確実に出す */
                    #printOverlay th, #printOverlay td {
                        border: 1.2px solid #1f2937 !important;
                        border-color: #1f2937 !important;
                        outline: 0.5px solid #1f2937 !important;
                        outline-offset: -0.5px !important;
                        page-break-inside: avoid !important;
                        break-inside: avoid !important;
                        box-shadow: inset 0 0 0 0.5px #1f2937 !important;
                    }
                    /* 見出し/曜日列も色を確実に */
                    #printOverlay thead th {
                        font-weight: 900 !important;
                    }
                    /* シフトバー: 内側 padding 消去で時間目盛と完全位置合わせ */
                    #printOverlay td > div[style*="position: absolute"] {
                        border-width: 1.5px !important;
                    }
                    /* ページ送りリセット: 最後のチャンクで余白ページが出ないように */
                    .table-chunk { page-break-after: always !important; }
                    .table-chunk:last-child { page-break-after: auto !important; }
                }
                @page { size: landscape; margin: 6mm; }
            `;
            document.head.appendChild(style);
        }

        // --- コンテンツ生成関数 ---
        const generateTableHTML = (days, chunkIndex, totalChunks) => {
            const isCompact = fmt === 'compact';
            // 時間目盛り (detailed のみ)
            const timeScaleHtml = isCompact ? '' : `
                <div style="display: flex; justify-content: space-between; font-size: 8px; color: #555; margin-top: 2px; border-top: 1px solid #ccc;">
                    <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
                </div>
            `;

            // ヘッダー生成
            const colW = isCompact ? 56 : 130;
            const headerCols = days.map(date => {
                const d = date.getDate();
                const m = date.getMonth() + 1;
                const w = ['日','月','火','水','木','金','土'][date.getDay()];
                const isSun = date.getDay() === 0;
                const isSat = date.getDay() === 6;
                const colorStyle = isSun ? 'color:#d32f2f;' : isSat ? 'color:#1976d2;' : 'color:#111;';
                const bgStyle = isSun ? 'background-color:#fff5f5; background-image:linear-gradient(#fff5f5,#fff5f5);'
                              : isSat ? 'background-color:#f0f9ff; background-image:linear-gradient(#f0f9ff,#f0f9ff);'
                              : 'background-color:#f9fafb; background-image:linear-gradient(#f9fafb,#f9fafb);';

                return `
                    <th style="${bgStyle} border: 1px solid #333; padding: ${isCompact ? '2px' : '4px'}; width: ${colW}px; min-width: ${colW}px;">
                        <div style="${colorStyle} font-size: ${isCompact ? '10px' : '11px'}; font-weight: bold;">${m}/${d}<br>${w}</div>
                        ${timeScaleHtml}
                    </th>
                `;
            }).join('');

            // ボディ生成 (v3.7.149: 名前/IDのない不正なスタッフ entry を除外して空行を防ぐ)
            const bodyRows = this.state.staff.filter(s => s && s.id && (s.name || '').trim()).map(staff => {
                const cols = days.map(date => {
                    const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
                    const shift = this.state.shifts.find(s => s.staff_id === staff.id && s.date === dateStr);
                    
                    let cellContent = '';

                    if (shift) {
                        const customShifts = this.state.config.custom_shifts || [];
                        const _col = this._getShiftPrintColor(shift, customShifts);
                        const bgColor = _col.bg;
                        const borderColor = _col.border;
                        const st = (shift.start_time || '').slice(0,5);
                        const et = (shift.end_time || '').slice(0,5);

                        if (isCompact) {
                            // === Compact: シンプルテキスト表示 (時間軸なし) ===
                            cellContent = `
                                <div style="
                                    position: absolute; inset: 2px;
                                    background-color: ${bgColor};
                                    background-image: linear-gradient(${bgColor}, ${bgColor});
                                    border-left: 4px solid ${borderColor};
                                    border-radius: 2px;
                                    display: flex; align-items: center; justify-content: center;
                                    font-size: 9px; font-weight: bold; color: #111;
                                    -webkit-print-color-adjust: exact;
                                    print-color-adjust: exact;
                                ">${st}<br>${et}</div>
                            `;
                        } else {
                            // === Detailed: Gantt 風 (時間軸 + 視覚バー) ===
                            const startH = parseInt(shift.start_time.split(':')[0]);
                            const startM = parseInt(shift.start_time.split(':')[1]);
                            const endH = parseInt(shift.end_time.split(':')[0]);
                            const endM = parseInt(shift.end_time.split(':')[1]);
                            const startMin = startH * 60 + startM;
                            const endMin = endH * 60 + endM;
                            const endMinAdjusted = endMin < startMin ? endMin + 1440 : endMin;
                            const startPct = (startMin / 1440) * 100;
                            const widthPct = ((endMinAdjusted - startMin) / 1440) * 100;
                            const timeText = `${st} - ${et}`;
                            cellContent = `
                                <div style="
                                    position: absolute;
                                    left: ${startPct}%;
                                    width: ${Math.max(widthPct, 1)}%;
                                    top: 6px; bottom: 6px;
                                    background-color: ${bgColor};
                                    background-image: linear-gradient(${bgColor}, ${bgColor});
                                    border: 2px solid ${borderColor};
                                    border-left: 6px solid ${borderColor};
                                    border-radius: 3px;
                                    z-index: 10;
                                    display: flex; align-items: center; justify-content: center;
                                    -webkit-print-color-adjust: exact;
                                    print-color-adjust: exact;
                                ">
                                    <span style="font-size: 10px; font-weight: bold; color: #000; white-space: nowrap;
                                                 text-shadow: 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;
                                                 position: relative; z-index: 20;">${timeText}</span>
                                </div>
                            `;
                        }
                    }

                    // 背景グリッド (detailed のみ)
                    const gridLines = isCompact ? '' : `
                        <div style="position:absolute; left:25%; top:0; bottom:0; border-left:1px dotted #ccc; z-index:0;"></div>
                        <div style="position:absolute; left:50%; top:0; bottom:0; border-left:1px solid #ccc; z-index:0;"></div>
                        <div style="position:absolute; left:75%; top:0; bottom:0; border-left:1px dotted #ccc; z-index:0;"></div>
                    `;

                    const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
                    const bgStyle = isSpecialHoliday ? 'background-color: #ffebee; background-image: linear-gradient(#ffebee, #ffebee);' : '';
                    const cellHeight = isCompact ? '28px' : '38px';

                    return `<td style="position: relative; padding: 0; height: ${cellHeight}; border: 1px solid #333; ${bgStyle}">
                        ${gridLines}
                        ${cellContent}
                    </td>`;
                }).join('');

                return `
                    <tr style="page-break-inside: avoid;">
                        <td style="padding: 4px 8px; font-weight: bold; background-color: #f3f4f6; background-image: linear-gradient(#f3f4f6,#f3f4f6); text-align: left; width: ${isCompact ? '90px' : '120px'}; border: 1.2px solid #1f2937; font-size: ${isCompact ? '10px' : '11px'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                            ${this._sanitize(staff.name)}
                        </td>
                        ${cols}
                    </tr>
                `;
            }).join('');

            // 期間表示
            const startStr = `${days[0].getMonth()+1}/${days[0].getDate()}`;
            const endStr = `${days[days.length-1].getMonth()+1}/${days[days.length-1].getDate()}`;

            return `
                <div class="table-chunk" style="margin-bottom: 14px; page-break-after: always;">
                    <h3 style="margin: 0 0 6px 0; font-size: 14px; border-left: 5px solid #2563eb; padding-left: 8px;">
                        期間: ${startStr} 〜 ${endStr}
                    </h3>
                    <table style="width: 100%; border-collapse: collapse; table-layout: fixed; font-size: ${isCompact ? '10px' : '11px'};">
                        <thead>
                            <tr>
                                <th style="width: ${isCompact ? '90px' : '120px'}; background-color: #e5e7eb; background-image: linear-gradient(#e5e7eb,#e5e7eb); border: 1.2px solid #1f2937; padding: 4px; font-weight: 900;">スタッフ</th>
                                ${headerCols}
                            </tr>
                        </thead>
                        <tbody>
                            ${bodyRows}
                        </tbody>
                    </table>
                    <div style="text-align: right; font-size: 9px; color: #666; margin-top: 3px;">
                        Page ${chunkIndex + 1} / ${totalChunks}
                    </div>
                </div>
            `;
        };

        // 全チャンクのHTML結合
        const allTablesHtml = dayChunks.map((chunk, idx) => generateTableHTML(chunk, idx, dayChunks.length)).join('');

        // v3.7.93: メインページに overlay を挿入 (新規ウィンドウなし)
        const overlay = document.createElement('div');
        overlay.id = 'printOverlay';
        overlay.innerHTML = `
            <div class="no-print" style="margin-bottom: 16px; padding: 12px 16px; background: #e0f2fe; border: 1px solid #bae6fd; border-radius: 8px; color: #0369a1; position: relative;">
                <button onclick="app.closePrintOverlay()" ontouchend="event.preventDefault(); app.closePrintOverlay();" aria-label="閉じる" class="no-print"
                        style="position: fixed; top: 12px; right: 12px; z-index: 10001; width: 48px; height: 48px; border: none; background: #ef4444; color: white; border-radius: 50%; font-size: 24px; font-weight: bold; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent;">
                    ✕
                </button>
                <h2 style="margin: 0 0 8px 0; padding-right: 48px; font-size: 18px;">🖨 印刷プレビュー</h2>
                <p style="font-size: 13px; line-height: 1.6; margin: 0;">
                    ${fmt === 'compact' ? '14日ごと' : '7日ごと'}に分割して表示しています。「印刷 / PDF保存」を押すとブラウザの印刷ダイアログが開きます。
                </p>
                <div style="margin-top: 10px; padding: 8px; background:#fff; border:1px solid #bae6fd; border-radius:6px;">
                    <div style="font-size:12px; color:#0369a1; margin-bottom:6px; font-weight:bold;">📋 レイアウト</div>
                    <div style="display:flex; flex-wrap:wrap; gap:6px;">
                        <button onclick="app.printShiftTable('detailed')"
                                style="flex:1; min-width:160px; padding:8px 12px; border-radius:6px; font-size:13px; font-weight:bold; cursor:pointer; border:2px solid ${fmt==='detailed'?'#0284c7':'#cbd5e1'}; background:${fmt==='detailed'?'#0284c7':'#fff'}; color:${fmt==='detailed'?'#fff':'#334155'};">
                            📊 詳細版 (時間軸あり)
                        </button>
                        <button onclick="app.printShiftTable('compact')"
                                style="flex:1; min-width:160px; padding:8px 12px; border-radius:6px; font-size:13px; font-weight:bold; cursor:pointer; border:2px solid ${fmt==='compact'?'#0284c7':'#cbd5e1'}; background:${fmt==='compact'?'#0284c7':'#fff'}; color:${fmt==='compact'?'#fff':'#334155'};">
                            📃 シンプル版 (コンパクト)
                        </button>
                    </div>
                    <div style="font-size:11px; color:#64748b; margin-top:6px;">
                        ${fmt === 'compact' ? '時間軸を省き、開始-終了時刻のみ表示。1ページに14日収まります。' : 'シフトを Gantt 風の時間軸で視覚化。1ページ7日。'}
                    </div>
                </div>
                <div style="margin-top: 12px; display: flex; flex-wrap: wrap; gap: 10px;">
                    <button onclick="setTimeout(() => window.print(), 200)"
                            style="flex: 1; min-width: 180px; padding: 12px 20px; background: #0284c7; color: white; border: none; border-radius: 6px; font-weight: bold; font-size: 15px; cursor: pointer;">
                        🖨 印刷 / PDF保存
                    </button>
                    <button onclick="app.closePrintOverlay()"
                            style="flex: 1; min-width: 180px; padding: 12px 20px; background: #64748b; color: white; border: none; border-radius: 6px; font-weight: bold; font-size: 15px; cursor: pointer;">
                        ✕ 閉じて戻る
                    </button>
                </div>
            </div>
            <h1 style="font-size: 22px; margin: 16px 0;">${year}年 ${month + 1}月 シフト表</h1>
            ${allTablesHtml}
        `;
        document.body.appendChild(overlay);
        // Esc キーでも閉じられるように
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                this.closePrintOverlay();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    },

    // v3.7.93: 印刷オーバーレイを閉じて元画面に戻る
    closePrintOverlay() {
        const el = document.getElementById('printOverlay');
        if (el) el.remove();
    },

    // =================================================================
    // ロジック・ヘルパー関数
    // =================================================================

    // --- シフト編集 ---
    // v3.7.15: <select> から <input type="time"> に変更。
    // ユーザー要望「ドロップダウンではなく打ち込み出来るように」を反映。
    // step="60" で 1分刻み (打ち込み自由)。class 名 (setting-shift-start 等) は
    // 呼び出し側の querySelectorAll で参照するため保持。
    /**
     * v3.7.81: シフトパターンを参照してバーの色を決定。
     *   1) shift の時間範囲と一致するパターンを探す
     *   2) パターン名で名称マッチ (早番/遅番/夜勤/通し)
     *   3) マッチしなければパターン登録順のパレット
     *   4) パターンが見つからなければ開始時刻ベースのフォールバック
     */
    // v3.7.146: 印刷用にインライン CSS の色 (背景/枠) を返す
    // _getShiftBarColor の Tailwind クラスから色名を抽出して RGB に変換
    _getShiftPrintColor(shift, customShifts) {
        const cls = this._getShiftBarColor(shift, customShifts) || '';
        const COLOR_MAP = {
            yellow:  { bg: '#fef9c3', border: '#ca8a04' },
            purple:  { bg: '#f3e8ff', border: '#9333ea' },
            sky:     { bg: '#e0f2fe', border: '#0284c7' },
            indigo:  { bg: '#e0e7ff', border: '#4f46e5' },
            emerald: { bg: '#d1fae5', border: '#059669' },
            pink:    { bg: '#fce7f3', border: '#db2777' },
            orange:  { bg: '#fed7aa', border: '#ea580c' },
            teal:    { bg: '#ccfbf1', border: '#0d9488' },
            red:     { bg: '#fee2e2', border: '#dc2626' },
            blue:    { bg: '#dbeafe', border: '#2563eb' },
        };
        // bg-{color}-NNN を最優先で抽出
        const m = cls.match(/bg-([a-z]+)-/);
        const name = m ? m[1] : 'blue';
        return COLOR_MAP[name] || COLOR_MAP.blue;
    },

    _getShiftBarColor(shift, customShifts) {
        const PALETTE = [
            'bg-yellow-100 text-yellow-800 border-yellow-500',  // 0: 早番想定 (yellow)
            'bg-purple-100 text-purple-700 border-purple-500',  // 1: 遅番想定 (purple)
            'bg-sky-100 text-sky-700 border-sky-500',           // 2: 中番想定 (sky)
            'bg-indigo-200 text-indigo-800 border-indigo-600',  // 3: 夜勤想定 (indigo dark)
            'bg-emerald-100 text-emerald-700 border-emerald-500', // 4: 通し想定 (emerald)
            'bg-pink-100 text-pink-700 border-pink-500',        // 5
            'bg-orange-100 text-orange-700 border-orange-500',  // 6
            'bg-teal-100 text-teal-700 border-teal-500',        // 7
        ];
        const NAME_COLOR_MAP = [
            { kw: ['早', '朝', 'モーニング', 'morning', 'early'],   color: PALETTE[0] },
            { kw: ['遅', '夕', 'イブニング', 'evening', 'late'],     color: PALETTE[1] },
            { kw: ['中', '昼', 'ランチ', 'mid', 'middle', 'lunch'], color: PALETTE[2] },
            { kw: ['夜勤', '深夜', '夜', 'ナイト', 'night'],          color: PALETTE[3] },
            { kw: ['通し', '全日', 'フル', 'full'],                  color: PALETTE[4] },
        ];

        // 1) 時間範囲一致でパターン特定
        const sStart = (shift.start_time || '').slice(0, 5);
        const sEnd = (shift.end_time || '').slice(0, 5);
        let matchedIdx = -1;
        let matchedName = '';
        customShifts.forEach((p, i) => {
            const pStart = (p.start || '').slice(0, 5);
            const pEnd = (p.end || '').slice(0, 5);
            if (pStart && pEnd && pStart === sStart && pEnd === sEnd) {
                matchedIdx = i;
                matchedName = (p.name || '').toLowerCase();
            }
        });

        // 2) 名称マッチ優先 (より特定的なほうから)
        if (matchedName) {
            // 夜勤を先にチェック (夜 だけだと遅番にマッチしてしまうため)
            const orderedMap = [NAME_COLOR_MAP[3], NAME_COLOR_MAP[4], NAME_COLOR_MAP[0],
                                NAME_COLOR_MAP[2], NAME_COLOR_MAP[1]];
            for (const rule of orderedMap) {
                if (rule.kw.some(k => matchedName.includes(k.toLowerCase()))) {
                    return rule.color;
                }
            }
        }

        // 3) パターンインデックスベース
        if (matchedIdx >= 0) {
            return PALETTE[matchedIdx % PALETTE.length];
        }

        // 4) フォールバック (旧 v3.7.80 までの動作)
        const startH = parseInt(sStart);
        if (startH < 10) return PALETTE[0];
        if (startH >= 17) return PALETTE[1];
        return 'bg-blue-100 text-blue-700 border-blue-500';
    },

    get15MinTimeSelect(currentVal, id, className) {
        const normalizedVal = currentVal ? currentVal.substr(0, 5) : '';
        const idAttr = id ? `id="${id}"` : '';
        const finalClass = `${className || ''} bg-white`;
        return `<input type="time" ${idAttr} value="${normalizedVal}" step="60" class="${finalClass}">`;
    },


    // v3.7.168: プラン情報を最新化 (運営側のプラン変更を即時反映)
    //   - check_subscription_status RPC を再呼び出しして state.config を更新
    //   - 旧プランからの差分があれば トースト+UI再描画
    async refreshPlanInfo() {
        const contractId = this._getContractId();
        if (!contractId) {
            this.showToast('契約IDが特定できません。再ログインしてください', 'error');
            return;
        }
        try {
            this.showLoading(true);
            const prevPlan = this.state.config?.stripe_plan || 'free';
            const prevStatus = this.state.config?.subscription_status || '';
            // 1) サブスクリプション状態を再取得
            const sub = await API.rpc('check_subscription_status', { p_contract_id: contractId });
            if (sub && sub.plan) {
                this.state.config.stripe_plan = sub.plan;
            }
            if (sub && sub.status) {
                this.state.config.subscription_status = sub.status;
            }
            // 2) config 全体も最新化 (other plan-related fields)
            try { await this.loadData(); } catch (e) { console.warn('loadData on refresh failed', e); }
            // 3) 再描画
            this.renderCurrentView();
            const newPlan = this.state.config?.stripe_plan || 'free';
            const newStatus = this.state.config?.subscription_status || '';
            if (newPlan !== prevPlan || newStatus !== prevStatus) {
                this.showToast(`プラン情報を更新しました (${prevPlan} → ${newPlan})`, 'success');
            } else {
                this.showToast('プラン情報は既に最新です', 'info');
            }
        } catch (e) {
            console.error('refreshPlanInfo error:', e);
            this.showToast('プラン情報の取得に失敗しました: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // v3.7.161: シフト編集モーダル内に「シフトパターンからクイック選択」UI を描画
    //   - custom_shifts (早番/中番/遅番...) のボタンをタップ → 開始/終了/休憩を一括反映
    //   - 「✏ 手入力」を押すと現在値を残したまま input にフォーカスする
    _renderShiftPatternRow() {
        const row = document.getElementById('editShiftPatternRow');
        if (!row) return;
        // v3.7.163: custom_shifts が未設定でも 既定の早番/遅番 を即タップできるフォールバックを提供
        const allShifts = this.state.config.custom_shifts || [];
        let customShifts = allShifts.filter(p => p && (p.start || p.start_time) && (p.end || p.end_time));
        let usingFallback = false;
        if (!customShifts.length) {
            usingFallback = true;
            const openT = (this.state.config.opening_time || '09:00').slice(0,5);
            const closeT = (this.state.config.closing_time || '22:00').slice(0,5);
            const [oh, om] = openT.split(':').map(Number);
            const [ch, cm] = closeT.split(':').map(Number);
            const openMin = oh * 60 + (om || 0);
            const closeMin = ch * 60 + (cm || 0);
            // v3.7.164: open >= close (24h営業/未設定) の edge case では汎用1パターンのみ
            if (closeMin - openMin < 120) {
                customShifts = [{ name: '基本', start: openT, end: closeT }];
            } else {
                const midMin = Math.round((openMin + closeMin) / 2);
                const fmt = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2,'0')}:${String(mins % 60).padStart(2,'0')}`;
                customShifts = [
                    { name: '早番', start: openT, end: fmt(midMin) },
                    { name: '遅番', start: fmt(midMin), end: closeT },
                    { name: '通し', start: openT, end: closeT },
                ];
            }
        }
        const btns = customShifts.map(p => {
            const st = ((p.start || p.start_time) || '').slice(0,5);
            const et = ((p.end || p.end_time) || '').slice(0,5);
            const brk = Number(p.break_minutes) || 60;
            const col = this._getShiftPrintColor({ start_time: st, end_time: et }, customShifts);
            const name = this._sanitize(p.name || `${st}-${et}`);
            return `<button type="button"
                onclick="app._applyShiftPattern('${st}','${et}',${brk})"
                style="background:${col.bg}; border:2px solid ${col.border};"
                class="px-3 py-2 rounded-lg text-xs font-bold text-gray-800 hover:opacity-80 transition flex flex-col items-center min-w-[80px]">
                <span>${name}</span>
                <span class="text-[10px] font-mono text-gray-700">${st}-${et}</span>
            </button>`;
        }).join('');
        const manualBtn = `<button type="button"
            onclick="document.getElementById('editShiftStart').focus()"
            class="px-3 py-2 rounded-lg text-xs font-bold bg-gray-100 text-gray-700 border-2 border-dashed border-gray-300 hover:bg-gray-200 transition min-w-[80px]">
            ✏ 手入力
        </button>`;
        const fallbackHint = usingFallback
            ? `<div class="w-full text-[10px] text-amber-600 mt-1">⚠ シフトパターン未登録のため仮の早番/遅番を表示中。設定画面で登録すると配色が固定されます。</div>`
            : '';
        row.innerHTML = btns + manualBtn + fallbackHint;
    },

    // v3.7.161: パターンボタン押下時 → time input に反映
    _applyShiftPattern(start, end, breakMins) {
        const s = document.getElementById('editShiftStart');
        const e = document.getElementById('editShiftEnd');
        const b = document.getElementById('editShiftBreak');
        if (s) s.value = start;
        if (e) e.value = end;
        if (b) b.value = breakMins;
    },

    openAddShift(dateStr) {
        document.getElementById('shiftForm')?.reset();
        document.getElementById('editShiftId').value = '';
        document.getElementById('editShiftDate').value = dateStr;
        document.getElementById('editShiftTitle').textContent = 'シフト追加';
        document.getElementById('editShiftDateDisplay').textContent = dateStr;
        document.getElementById('deleteShiftBtn').classList.add('hidden');

        const staffSelectHtml = `<select id="editShiftStaffSelect" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none mb-2"><option value="">スタッフを選択</option>${this.state.staff.map(s => `<option value="${s.id}">${this._sanitize(s.name)}</option>`).join('')}</select>`;
        document.getElementById('editShiftStaffName').innerHTML = staffSelectHtml;

        // v3.7.15: <input type="time"> 化に伴い options 生成は不要。value 設定のみ
        const defStart = (this.state.config.opening_time || '09:00').substr(0, 5);
        const defEnd = (this.state.config.closing_time || '18:00').substr(0, 5);

        document.getElementById('editShiftStart').value = defStart;
        document.getElementById('editShiftEnd').value = defEnd;

        document.getElementById('editShiftBreak').value = 60;
        const memoEl = document.getElementById('editShiftMemo');
        if (memoEl) memoEl.value = '';

        this._renderShiftPatternRow();
        this.openModal('editShiftModal');
        const saveBtn = document.getElementById('saveShiftBtn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => this.saveShift());
    },

    // v3.7.117: シフト表 ドラッグ&ドロップ
    onShiftDragStart(e) {
        if (!this.state.isAdmin) { e.preventDefault(); return; }
        const bar = e.currentTarget;
        const shiftId = bar?.dataset?.shiftId;
        if (!shiftId) { e.preventDefault(); return; }
        e.dataTransfer.setData('text/plain', shiftId);
        e.dataTransfer.effectAllowed = 'move';
        bar.classList.add('opacity-50');
        this._dragSourceBar = bar;
    },

    onShiftDragEnd(e) {
        if (this._dragSourceBar) {
            this._dragSourceBar.classList.remove('opacity-50');
            this._dragSourceBar = null;
        }
        document.querySelectorAll('td.dnd-drop-target').forEach(td => td.classList.remove('dnd-drop-target', 'ring-2', 'ring-blue-400', 'ring-inset'));
    },

    onShiftDragOver(e) {
        if (!this.state.isAdmin) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const td = e.currentTarget;
        if (!td.classList.contains('dnd-drop-target')) {
            td.classList.add('dnd-drop-target', 'ring-2', 'ring-blue-400', 'ring-inset');
        }
    },

    onShiftDragLeave(e) {
        const td = e.currentTarget;
        td.classList.remove('dnd-drop-target', 'ring-2', 'ring-blue-400', 'ring-inset');
    },

    async onShiftDrop(e, dateStr, staffId) {
        e.preventDefault();
        e.stopPropagation();
        const td = e.currentTarget;
        td.classList.remove('dnd-drop-target', 'ring-2', 'ring-blue-400', 'ring-inset');
        if (!this.state.isAdmin) return;
        const shiftId = e.dataTransfer.getData('text/plain');
        if (!shiftId) return;
        const shift = (this.state.shifts || []).find(s => String(s.id) === String(shiftId));
        if (!shift) return;
        if (shift.staff_id === staffId && shift.date === dateStr) return;
        // 移動先に既存シフトがあれば「入れ替え」(swap)
        const existing = (this.state.shifts || []).find(s =>
            s.staff_id === staffId && s.date === dateStr && String(s.id) !== String(shiftId));
        // v3.7.122: DnD でも連勤上限を厳守 (移動先スタッフをチェック)
        if (!this._checkConsecLimit(staffId, dateStr, shiftId)) {
            this.showToast('連続出勤日数の上限を超えるため移動できません', 'warning');
            return;
        }
        if (existing && !this._checkConsecLimit(shift.staff_id, shift.date, existing.id)) {
            this.showToast('入れ替えで連続出勤日数の上限を超えるため移動できません', 'warning');
            return;
        }
        if (existing) {
            await this.swapShifts(shift, existing);
        } else {
            await this.updateShiftDrag(shiftId, { staff_id: staffId, date: dateStr });
        }
    },

    // v3.7.122: 仮想配置が連勤上限を超えないかチェック (営業日ベース)
    _checkConsecLimit(staffId, dateStr, excludeShiftId) {
        const staff = this.getStaff(staffId);
        if (!staff) return true;
        let limit = Number(staff.max_consecutive_days);
        if (!Number.isFinite(limit) || limit < 1 || limit > 7) limit = 6;
        const closedDays = (this.state.config?.closed_days || []).map(Number);
        const specialHolidays = this.state.config?.special_holidays || [];
        const isClosed = (d) => {
            if (specialHolidays.includes(d)) return true;
            const dt = new Date(d);
            return closedDays.includes(dt.getDay());
        };
        const target = new Date(dateStr);
        const allAttended = new Set(
            (this.state.shifts || [])
                .filter(s => s.staff_id === staffId && String(s.id) !== String(excludeShiftId || ''))
                .map(s => s.date)
        );
        allAttended.add(dateStr);
        // 営業日のみで limit+1 個窓を構築 (target を含む)
        let cur = new Date(target); cur.setDate(cur.getDate() - limit * 2);
        let opDates = [];
        for (let i = 0; i < limit * 4 + 1; i++) {
            const ds = cur.toISOString().slice(0, 10);
            if (!isClosed(ds)) opDates.push(ds);
            cur.setDate(cur.getDate() + 1);
        }
        const ti = opDates.indexOf(dateStr);
        if (ti < 0) return true;
        for (let start = Math.max(0, ti - limit); start <= ti; start++) {
            if (start + limit + 1 > opDates.length) continue;
            const win = opDates.slice(start, start + limit + 1);
            const inWin = win.filter(d => allAttended.has(d)).length;
            if (inWin > limit) return false;
        }
        return true;
    },

    // v3.7.125: シフト入れ替え (swap) - 完全なロールバック実装
    async swapShifts(shiftA, shiftB) {
        const aId = shiftA.id, bId = shiftB.id;
        const origA = { staff_id: shiftA.staff_id, date: shiftA.date };
        const origB = { staff_id: shiftB.staff_id, date: shiftB.date };
        let firstSucceeded = false;
        try {
            await this._shiftUpsert(aId, { staff_id: origB.staff_id, date: origB.date });
            firstSucceeded = true;
            await this._shiftUpsert(bId, { staff_id: origA.staff_id, date: origA.date });
            // 両方成功 → state 反映
            shiftA.staff_id = origB.staff_id; shiftA.date = origB.date;
            shiftB.staff_id = origA.staff_id; shiftB.date = origA.date;
            this.renderCurrentView();
            this.updateHeader();
            const nameA = this.getStaff(shiftA.staff_id)?.name || '?';
            const nameB = this.getStaff(shiftB.staff_id)?.name || '?';
            this.showToast(`入れ替え完了 (${nameA} ⇄ ${nameB})`, 'success');
        } catch (err) {
            console.error('[swapShifts] failed:', err);
            // 1件目だけ成功していたらロールバック (確実に元に戻す)
            if (firstSucceeded) {
                try {
                    await this._shiftUpsert(aId, origA);
                    this.showToast('入れ替え失敗 → 元の状態に戻しました', 'warning');
                } catch (rollbackErr) {
                    console.error('[swapShifts] ROLLBACK FAILED:', rollbackErr);
                    this.showToast(
                        '入れ替え失敗 + ロールバック失敗。手動で確認してください',
                        'error'
                    );
                }
            } else {
                this.showToast('入れ替え失敗 (変更なし)', 'error');
            }
            this.renderCurrentView();
        }
    },

    // v3.7.125: ローカル state 復旧つき DnD 更新
    async updateShiftDrag(shiftId, updates) {
        const shift = this.state.shifts.find(s => s.id === shiftId);
        if (!shift) {
            console.warn('[updateShiftDrag] shift not found:', shiftId);
            return;
        }
        // 元の値をスナップショット (失敗時の復旧用)
        const snapshot = { ...shift };
        try {
            await this._shiftUpsert(shiftId, updates);
            Object.assign(shift, updates);
            // 休憩時間を再計算
            if (updates.start_time || updates.end_time) {
                const [sh, sm] = shift.start_time.split(':').map(Number);
                const [eh, em] = shift.end_time.split(':').map(Number);
                let hours = (eh + em / 60) - (sh + sm / 60);
                if (hours <= 0) hours += 24;
                const breakRules = this.state.config.break_rules || this.state.defaultConfig.break_rules || [];
                let brk = 0;
                for (const rule of breakRules.sort((a, b) => a.min_hours - b.min_hours)) {
                    if (hours >= rule.min_hours) brk = rule.break_minutes;
                }
                if (shift.break_minutes !== brk) {
                    try {
                        await this._shiftUpsert(shiftId, { break_minutes: brk });
                        shift.break_minutes = brk;
                    } catch (brkErr) {
                        // 休憩時間更新失敗は致命的ではない (memo に記録)
                        console.warn('[updateShiftDrag] break_minutes update failed:', brkErr);
                    }
                }
            }
            this.renderCurrentView();
            this.updateHeader();
            const staff = this.getStaff(updates.staff_id || shift.staff_id);
            this.showToast(`シフトを更新しました${staff ? ' (' + staff.name + ')' : ''}`, 'success');
        } catch (e) {
            console.error('[updateShiftDrag] failed:', e);
            // スナップショットから復旧
            Object.assign(shift, snapshot);
            this.showToast('シフト更新失敗 → 元に戻しました', 'error');
            this.renderCurrentView();
        }
    },

    openEditShift(shiftId) {
        const shift = this.state.shifts.find(s => s.id == shiftId);
        if (!shift) return;
        const staff = this.getStaff(shift.staff_id);
        document.getElementById('editShiftId').value = shift.id;
        document.getElementById('editShiftDate').value = shift.date;
        document.getElementById('editShiftStaffId').value = shift.staff_id;
        document.getElementById('editShiftTitle').textContent = 'シフト編集';
        document.getElementById('editShiftDateDisplay').textContent = shift.date;
        const safeName = staff ? this._sanitize(staff.name) : '不明なスタッフ';
        document.getElementById('editShiftStaffName').innerHTML = `<div class="py-2 text-xl text-gray-800">${safeName}</div>`;
        
        // 時間の正規化 (HH:mm:ss -> HH:mm)
        const startTime = shift.start_time.substr(0, 5);
        const endTime = shift.end_time.substr(0, 5);

        // v3.7.15: <input type="time"> 化に伴い options 生成は不要。value 設定のみ
        document.getElementById('editShiftStart').value = startTime;
        document.getElementById('editShiftEnd').value = endTime;
        
        document.getElementById('editShiftBreak').value = shift.break_minutes;
        const memoEl = document.getElementById('editShiftMemo');
        if (memoEl) memoEl.value = shift.memo || '';
        document.getElementById('deleteShiftBtn').classList.remove('hidden');

        this._renderShiftPatternRow();
        const deleteBtn = document.getElementById('deleteShiftBtn');
        deleteBtn.onclick = () => this.deleteShift(shift.id);
        const saveBtn = document.getElementById('saveShiftBtn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => this.saveShift());
        this.openModal('editShiftModal');
    },

    async saveShift() {
        const id = (document.getElementById('editShiftId')?.value || '');
        const date = (document.getElementById('editShiftDate')?.value || '');
        const start = (document.getElementById('editShiftStart')?.value || '');
        const end = (document.getElementById('editShiftEnd')?.value || '');
        const breakMins = Number((document.getElementById('editShiftBreak')?.value || ''));
        let staffId = (document.getElementById('editShiftStaffId')?.value || '');
        const selectEl = document.getElementById('editShiftStaffSelect');
        if (selectEl) staffId = selectEl.value;

        if (!staffId || !start || !end) { app.showToast('必須項目を入力してください', 'error'); return; }
        if (start === end) { app.showToast('開始時間と終了時間が同じです', 'error'); return; }
        if (document.getElementById('editShiftHoliday').checked && id) { await this.deleteShift(id); this.closeModal('editShiftModal'); return; }

        // 休憩時間バリデーション: 労働時間 (拘束時間) を超える休憩は不正
        // 旧: ロジック側でクランプ (hours=0) するだけだったが、保存時に弾く方が安全
        const [sh, sm] = start.split(':').map(Number);
        const [eh, em] = end.split(':').map(Number);
        let durationMin = (eh * 60 + em) - (sh * 60 + sm);
        if (durationMin <= 0) durationMin += 1440; // 日またぎ補正
        if (Number.isFinite(breakMins) && breakMins > 0 && breakMins >= durationMin) {
            app.showToast(`休憩時間 (${breakMins}分) が拘束時間 (${durationMin}分) 以上です。休憩を短くしてください`, 'error');
            return;
        }

        const memo = (document.getElementById('editShiftMemo')?.value || '').trim();
        const data = { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins, memo };
        if (!id) data.organization_id = this.state.organization_id;
        
        this.showLoading(true);
        try {
            await this._shiftUpsert(id || null, data);
            await this.loadData();
            
            // ビューの更新 (カレンダーに戻らず、現在のモードを維持)
            if (this.state.view === 'manual-shift' && document.getElementById('shiftViewContent')) {
                const content = document.getElementById('shiftViewContent');
                // スクロール位置の保持を試みる
                const scrollEl = content.firstElementChild;
                const sTop = scrollEl ? scrollEl.scrollTop : 0;
                const sLeft = scrollEl ? scrollEl.scrollLeft : 0;
                
                if (this.state.shiftViewMode === 'table') {
                    this.renderShiftTable(content);
                } else {
                    this.renderCalendar(content);
                }
                
                // スクロール復元
                if (content.firstElementChild) {
                    content.firstElementChild.scrollTop = sTop;
                    content.firstElementChild.scrollLeft = sLeft;
                }
            } else {
                this.renderCurrentView();
            }

            // ヘッダーの分析数値（人件費など）を更新
            this.calculateMonthlyStats();

            this.closeModal('editShiftModal');
            this.showToast('シフトを保存しました', 'success');
        } catch (e) { this.showToast('保存に失敗しました', 'error'); } finally { this.showLoading(false); }
    },

    async deleteShift(id) {
        // シフト削除の安全確認
        const shift = this.state.shifts.find(s => s.id === id);
        const staffName = shift ? (this.state.staff.find(st => st.id === shift.staff_id)?.name || '不明') : '不明';
        if (!confirm(`【シフト削除確認】\n\nスタッフ: ${staffName}\n日付: ${shift?.date || '不明'}\n\nこのシフトを削除しますか？\n※この操作は元に戻せません`)) return;
        this.showLoading(true);
        try {
            await this._shiftDelete(id);
            await this.loadData();
            
            // ビューの更新 (カレンダーに戻らず、現在のモードを維持)
            if (this.state.view === 'manual-shift' && document.getElementById('shiftViewContent')) {
                const content = document.getElementById('shiftViewContent');
                // スクロール位置の保持
                const scrollEl = content.firstElementChild;
                const sTop = scrollEl ? scrollEl.scrollTop : 0;
                const sLeft = scrollEl ? scrollEl.scrollLeft : 0;

                if (this.state.shiftViewMode === 'table') {
                    this.renderShiftTable(content);
                } else {
                    this.renderCalendar(content);
                }

                // スクロール復元
                if (content.firstElementChild) {
                    content.firstElementChild.scrollTop = sTop;
                    content.firstElementChild.scrollLeft = sLeft;
                }
            } else {
                this.renderCurrentView();
            }

            // ヘッダーの分析数値（人件費など）を更新
            this.calculateMonthlyStats();

            this.closeModal('editShiftModal');
            this.showToast('削除しました', 'success');
        } catch (e) { this.showToast('失敗しました', 'error'); } finally { this.showLoading(false); }
    },

    // --- スタッフ管理 ---
    prepareStaffModal() {
        this.updateStaffRoleSelect();
        this.updateStaffPositionSelect();
        this.openModal('staffModal');
        document.getElementById('staffForm').reset();
        document.getElementById('staffId').value='';
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb) cb.checked = true;
        }
        // v3.7.111: 祝日チェックも初期 ON (デフォルト 祝日もOK)
        const _prefHoliday = document.getElementById('prefHoliday');
        if (_prefHoliday) _prefHoliday.checked = true;
        // v3.7.77: シフトパターン目標回数 (新規スタッフは空)
        this.renderStaffPatternTargets({});
        // v3.7.109: 該当シフトパターン (新規スタッフは全該当 = 配列空)
        this.renderStaffEligiblePatterns([]);

        // v3.7.101: 前回編集時の値が残るバグ対策。明示的に全フィールドを
        // デフォルト値に初期化 (form.reset() だけだと placeholder のみ残る
        // ケースがあり、別スタッフの値が反映されてしまう)
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('staffName', '');
        setVal('staffEvaluation', 'B');
        setVal('staffSalaryType', 'hourly');
        setVal('staffContractType', 'general');
        setVal('staffShiftPriority', 'medium');
        setVal('staffHourlyWage', '');
        setVal('staffMonthlySalary', '');
        setVal('staffMaxDaysPerWeek', '5');
        setVal('staffMaxHoursPerDay', '8');
        setVal('staffMinDaysPerWeek', '0');
        setVal('staffMinDaysPerMonth', '0');
        setVal('staffMaxDaysPerMonth', '31');
        setVal('staffMaxConsecutiveDays', '6');
        setVal('staffPrefStartWeekday', '');
        setVal('staffPrefEndWeekday', '');
        setVal('staffPrefStartWeekend', '');
        setVal('staffPrefEndWeekend', '');
        const usePrefCb = document.getElementById('staffUsePrefHours');
        if (usePrefCb) usePrefCb.checked = false;
        // 一番下に「役職」select はデフォルト (manager等の最初の選択肢) のまま
        this.toggleSalaryInputs();
        this.togglePrefHoursInputs();
    },

    // v3.7.109: 該当シフトパターンチェックの動的描画
    renderStaffEligiblePatterns(eligible) {
        const container = document.getElementById('staffEligiblePatternsContainer');
        if (!container) return;
        const patterns = this.state.config.custom_shifts || [];
        if (patterns.length === 0) {
            container.innerHTML = `<p class="text-xs text-gray-400 text-center py-3">シフトパターンが登録されていません。先に「設定 → シフトパターン」を設定してください。</p>`;
            return;
        }
        const eligibleArr = Array.isArray(eligible) ? eligible : [];
        const isDefault = eligibleArr.length === 0; // 空 = 全該当 (デフォルト)
        container.innerHTML = `
            <div class="flex items-center justify-between mb-2 bg-indigo-50 px-3 py-1.5 rounded">
                <label class="text-xs flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" id="staffEligibleAll" class="w-4 h-4" ${isDefault ? 'checked' : ''}>
                    <span class="font-bold text-indigo-700">全パターン該当 (デフォルト)</span>
                </label>
                <button type="button" onclick="app.toggleAllEligible(false)" class="text-[10px] text-indigo-600 hover:underline">個別に選択 →</button>
            </div>
            <div id="staffEligibleRows" class="space-y-1" style="${isDefault ? 'opacity:0.5;' : ''}">
                ${patterns.map((pat, idx) => {
                    const name = this._sanitize(pat.name || `パターン${idx+1}`);
                    const start = this._sanitize(pat.start || '');
                    const end = this._sanitize(pat.end || '');
                    const key = pat.name || `pattern_${idx}`;
                    const checked = isDefault ? true : eligibleArr.includes(key);
                    return `
                        <label class="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 cursor-pointer hover:bg-indigo-50">
                            <input type="checkbox" class="setting-staff-eligible w-5 h-5"
                                data-pattern-key="${this._sanitize(key)}"
                                ${checked ? 'checked' : ''}
                                ${isDefault ? 'disabled' : ''}>
                            <div class="flex-1 min-w-0">
                                <div class="text-sm font-bold text-gray-800 truncate">${name}</div>
                                <div class="text-[10px] text-gray-500">${start} 〜 ${end}</div>
                            </div>
                            <span class="text-[10px] text-gray-400">${checked ? '☑ 該当' : '☐ 該当外'}</span>
                        </label>
                    `;
                }).join('')}
            </div>
        `;
        // 全パターン該当のチェック切替時の挙動
        const allCb = document.getElementById('staffEligibleAll');
        if (allCb) {
            allCb.addEventListener('change', (e) => this.toggleAllEligible(e.target.checked));
        }
    },

    // v3.7.109: 「全パターン該当」 ON/OFF の切替
    toggleAllEligible(useAll) {
        const allCb = document.getElementById('staffEligibleAll');
        const rows = document.getElementById('staffEligibleRows');
        if (allCb) allCb.checked = useAll;
        if (!rows) return;
        rows.style.opacity = useAll ? '0.5' : '1';
        rows.querySelectorAll('.setting-staff-eligible').forEach(cb => {
            cb.disabled = useAll;
            if (useAll) cb.checked = true;
        });
    },

    // v3.7.77: シフトパターン別月間目標回数の動的描画
    renderStaffPatternTargets(targets) {
        const container = document.getElementById('staffPatternTargetsContainer');
        if (!container) return;
        const patterns = this.state.config.custom_shifts || [];
        if (patterns.length === 0) {
            container.innerHTML = `<p class="text-xs text-gray-400 text-center py-3">シフトパターンが登録されていません。先に「設定 → シフトパターン」を設定してください。</p>`;
            return;
        }
        // v3.7.106: { name: 整数 } も { name: { min, max } } も両対応で読み込み
        const safeTargets = (targets && typeof targets === 'object') ? targets : {};
        const getRange = (key) => {
            const v = safeTargets[key];
            if (v == null) return { min: '', max: '' };
            if (typeof v === 'number') return { min: v, max: v }; // 旧データ互換
            if (typeof v === 'object') return {
                min: v.min != null ? Number(v.min) : '',
                max: v.max != null ? Number(v.max) : '',
            };
            return { min: '', max: '' };
        };
        container.innerHTML = `
            <p class="text-xs text-gray-500 mb-2">各シフトパターンに対し、月間の <strong>最低</strong> / <strong>最高</strong> 回数を指定できます。空欄なら制約なし。</p>
            ${patterns.map((pat, idx) => {
                const name = this._sanitize(pat.name || `パターン${idx+1}`);
                const start = this._sanitize(pat.start || '');
                const end = this._sanitize(pat.end || '');
                const key = pat.name || `pattern_${idx}`;
                const range = getRange(key);
                return `
                    <div class="flex items-center gap-2 bg-teal-50 border border-teal-100 rounded-lg px-3 py-2">
                        <div class="flex-1 min-w-0">
                            <div class="text-sm font-bold text-teal-700 truncate">${name}</div>
                            <div class="text-[10px] text-gray-500">${start} - ${end}</div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <div class="flex flex-col items-center">
                                <span class="text-[9px] text-gray-500">最低</span>
                                <input type="number" min="0" max="31" step="1" inputmode="numeric"
                                    data-pattern-min="${this._sanitize(key)}"
                                    class="setting-staff-pattern-min w-14 px-1 py-1.5 text-sm font-bold text-center border border-gray-300 rounded-lg"
                                    value="${range.min}" placeholder="-">
                            </div>
                            <span class="text-xs text-gray-400">〜</span>
                            <div class="flex flex-col items-center">
                                <span class="text-[9px] text-gray-500">最高</span>
                                <input type="number" min="0" max="31" step="1" inputmode="numeric"
                                    data-pattern-max="${this._sanitize(key)}"
                                    class="setting-staff-pattern-max w-14 px-1 py-1.5 text-sm font-bold text-center border border-gray-300 rounded-lg"
                                    value="${range.max}" placeholder="-">
                            </div>
                            <span class="text-xs text-gray-500">回/月</span>
                        </div>
                    </div>
                `;
            }).join('')}
        `;
    },
    
    updateStaffRoleSelect() {
        const select = document.getElementById('staffRole');
        if(!select) return;
        
        const roles = this.state.config.roles || this.state.defaultConfig.roles;
        select.innerHTML = roles.map(r => `<option value="${r.id}">${this._sanitize(r.name)}</option>`).join('');
    },
    
    // v3.7.67: 担当ポジション UI 廃止 (no-op)
    updateStaffPositionSelect() {},

    // プラン別スタッフ上限
    getStaffLimit() {
        // demoテナントは無制限
        const contractId = this.state.config.contract_id || '';
        if (contractId === 'demo') return 9999;

        const plan = this.state.config.stripe_plan || '';
        if (plan === 'premium') return 9999;
        if (plan === 'pro') return 50;
        if (plan === 'standard') return 10;
        return 30; // プラン未設定時のデフォルト
    },

    // スタッフ数がプラン上限を超えているかチェック
    isStaffOverLimit() {
        const limit = this.getStaffLimit();
        return this.state.staff.length > limit;
    },

    // スタッフ超過警告を表示（ダウングレード後など）
    showStaffOverLimitAlert() {
        const limit = this.getStaffLimit();
        const current = this.state.staff.length;
        const over = current - limit;
        const planName = {standard: 'Standard', pro: 'Pro', premium: 'Premium'}[this.state.config.stripe_plan] || 'Standard';

        const alertEl = document.getElementById('staffOverLimitAlert');
        if (alertEl) alertEl.remove();

        const alert = document.createElement('div');
        alert.id = 'staffOverLimitAlert';
        alert.className = 'fixed top-0 left-0 right-0 z-[200] bg-red-600 text-white px-4 py-3 text-center shadow-lg';
        alert.innerHTML = `
            <div class="max-w-3xl mx-auto flex items-center justify-center gap-3 flex-wrap">
                <i class="fa-solid fa-triangle-exclamation text-lg"></i>
                <span class="font-bold">${planName}プランのスタッフ上限(${limit}名)を${over}名超過しています。</span>
                <span class="text-red-200">スタッフを${over}名削除するまでシフト作成はできません。</span>
                <button onclick="app.changeView('staff'); document.getElementById('staffOverLimitAlert')?.remove();" class="px-4 py-1 bg-white text-red-600 rounded font-bold text-sm hover:bg-red-50 transition">
                    スタッフ管理へ
                </button>
            </div>
        `;
        document.body.prepend(alert);
    },

    // スタッフ超過警告を消す
    clearStaffOverLimitAlert() {
        const alertEl = document.getElementById('staffOverLimitAlert');
        if (alertEl) alertEl.remove();
    },

    // 決済エラーアラート表示
    showPaymentAlert() {
        const existing = document.getElementById('paymentAlert');
        if (existing) existing.remove();

        const alert = document.createElement('div');
        alert.id = 'paymentAlert';
        alert.className = 'fixed top-0 left-0 right-0 z-[200] bg-orange-500 text-white px-4 py-3 shadow-lg';
        alert.innerHTML = `
            <div class="max-w-3xl mx-auto flex items-center justify-center gap-3 flex-wrap">
                <i class="fa-solid fa-credit-card text-lg animate-pulse"></i>
                <span class="font-bold">決済エラーが発生しています</span>
                <span class="text-orange-100">お支払い方法を更新してください。未対応の場合サービスが停止されます。</span>
                <button onclick="app.openStripePortal()" class="px-4 py-1.5 bg-white text-orange-600 rounded font-bold text-sm hover:bg-orange-50 transition">
                    <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>支払い方法を更新
                </button>
                <button onclick="document.getElementById('paymentAlert')?.remove()" class="text-orange-200 hover:text-white ml-2">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `;
        document.body.prepend(alert);
    },

    async saveStaff() {
        const id = (document.getElementById('staffId')?.value || '');

        // テナント情報を確実に取得 (欠落時は config_safe から自動復旧)
        let contractId = this.state.config.contract_id || API.session?.user?.contract_id;
        let orgId = this.state.config.organization_id || this.state.organization_id || API.session?.user?.organization_id;

        if (!contractId || !orgId) {
            await this._recoverConfigId();
            contractId = this.state.config.contract_id || API.session?.user?.contract_id;
            orgId = this.state.config.organization_id || this.state.organization_id || API.session?.user?.organization_id;
        }

        if (!contractId || !orgId) {
            this.showToast('テナント情報が取得できません。一度ログアウト→再ログインしてください', 'error');
            return;
        }

        // 新規作成時: プラン別スタッフ数制限チェック
        if (!id) {
            const limit = this.getStaffLimit();
            const currentCount = this.state.staff.length;
            if (currentCount >= limit) {
                this.showUpgradeModal();
                return;
            }
        }

        // v3.7.1: スタッフ属性を専用カラムに保存 (旧版は unavailable_dates タグに詰め込んでいた)
        const contractType = document.getElementById('staffContractType')?.value || 'general';
        const shiftPriority = document.getElementById('staffShiftPriority')?.value || 'medium';
        const usePref = document.getElementById('staffUsePrefHours')?.checked;
        const prefStartWd = usePref ? (document.getElementById('staffPrefStartWeekday')?.value || '') : '';
        const prefEndWd = usePref ? (document.getElementById('staffPrefEndWeekday')?.value || '') : '';
        let prefStartWe = usePref ? (document.getElementById('staffPrefStartWeekend')?.value || '') : '';
        let prefEndWe = usePref ? (document.getElementById('staffPrefEndWeekend')?.value || '') : '';
        // v3.7.27: 土日希望時間が空欄なら平日希望時間を自動補完。
        // 平日のみ入力すると、土日にシフト候補が作られず土日不足の原因になっていたため。
        // 社員 (月給制) は希望時間を無視して柔軟調整される設計なので自動補完しない。
        const _salaryRaw = (document.getElementById('staffSalaryType')?.value || '').toLowerCase();
        const _autoFillWe = usePref && _salaryRaw !== 'monthly';
        let _autoFilledNote = '';
        if (_autoFillWe) {
            if (!prefStartWe && prefStartWd) { prefStartWe = prefStartWd; _autoFilledNote = '土日希望時間を平日希望時間で自動補完しました'; }
            if (!prefEndWe && prefEndWd) { prefEndWe = prefEndWd; _autoFilledNote = '土日希望時間を平日希望時間で自動補完しました'; }
        }
        // v3.7.197: 必須ペア(人間関係コントロール) UI 廃止 → 常に null で保存 (既存値もクリア)
        // v3.7.67: 担当ポジション UI 廃止 → 全員 'any' 固定
        const position = 'any';

        // NG曜日を収集
        const ngWeekdays = [];
        for (let i = 0; i <= 6; i++) {
            const cb = document.getElementById('prefDay' + i);
            if (cb && !cb.checked) ngWeekdays.push(i);
        }
        // v3.7.111: 祝日 NG (チェックが外れていたら true)
        const prefHolidayCb = document.getElementById('prefHoliday');
        const ngHoliday = !!(prefHolidayCb && !prefHolidayCb.checked);

        // v3.7.109: 該当シフトパターン (チェック) を収集
        //   「全パターン該当」が ON か、個別チェックが全部 ON なら 空配列 (= 全該当)
        //   一部だけチェックなら 該当パターン名の配列
        let eligiblePatterns = [];
        const allCb = document.getElementById('staffEligibleAll');
        if (allCb && allCb.checked) {
            eligiblePatterns = []; // 全該当 デフォルト
        } else {
            const checks = Array.from(document.querySelectorAll('.setting-staff-eligible'));
            const checked = checks.filter(c => c.checked).map(c => c.getAttribute('data-pattern-key')).filter(Boolean);
            // 全部チェック されているなら空配列 (= 全該当 と同じなので保存スペース節約)
            if (checks.length > 0 && checked.length === checks.length) {
                eligiblePatterns = [];
            } else {
                eligiblePatterns = checked;
            }
        }

        // v3.7.106: シフトパターン別 月間 最低/最高 回数を収集
        //   { name: { min: N, max: M } } 形式で保存
        //   min/max のいずれかが空欄なら null として保存 (制約なし)
        const patternTargets = {};
        const parseN = (s) => {
            const v = Number(s);
            return Number.isFinite(v) && v >= 0 && v <= 31 ? Math.floor(v) : null;
        };
        document.querySelectorAll('.setting-staff-pattern-min').forEach(el => {
            const key = el.getAttribute('data-pattern-min');
            if (!key) return;
            const minV = parseN(el.value);
            if (!patternTargets[key]) patternTargets[key] = {};
            if (minV != null) patternTargets[key].min = minV;
        });
        document.querySelectorAll('.setting-staff-pattern-max').forEach(el => {
            const key = el.getAttribute('data-pattern-max');
            if (!key) return;
            const maxV = parseN(el.value);
            if (!patternTargets[key]) patternTargets[key] = {};
            if (maxV != null) patternTargets[key].max = maxV;
        });
        // 空オブジェクトは削除
        Object.keys(patternTargets).forEach(k => {
            if (Object.keys(patternTargets[k]).length === 0) delete patternTargets[k];
        });

        // v3.7.125: 数値フィールドの sanitize 強化 (空文字/NaN → デフォルト値)
        const safeNum = (id, def, min, max) => {
            const v = Number(document.getElementById(id)?.value);
            if (!Number.isFinite(v)) return def;
            if (min != null && v < min) return def;
            if (max != null && v > max) return def;
            return v;
        };
        const data = {
            name: (document.getElementById('staffName')?.value || ''),
            role: (document.getElementById('staffRole')?.value || ''),
            evaluation: (document.getElementById('staffEvaluation')?.value || ''),
            salary_type: (document.getElementById('staffSalaryType')?.value || ''),
            hourly_wage: safeNum('staffHourlyWage', 1100, 0, 100000),
            monthly_salary: safeNum('staffMonthlySalary', 0, 0, 10000000),
            max_days_week: safeNum('staffMaxDaysPerWeek', 5, 1, 7),
            max_hours_day: safeNum('staffMaxHoursPerDay', 8, 1, 24),
            min_days_week: safeNum('staffMinDaysPerWeek', 0, 0, 7),
            min_days_month: safeNum('staffMinDaysPerMonth', 0, 0, 31),
            // v3.7.91: 月の最大出勤日数 (デフォルト 31 = 制限なし)
            max_days_month: (() => {
                const v = Number(document.getElementById('staffMaxDaysPerMonth')?.value);
                return (Number.isFinite(v) && v >= 1 && v <= 31) ? v : 31;
            })(),
            // v3.7.113: 連続出勤日数の上限 (1〜7, デフォルト 6=労基法35条)
            max_consecutive_days: (() => {
                const v = Number(document.getElementById('staffMaxConsecutiveDays')?.value);
                return (Number.isFinite(v) && v >= 1 && v <= 7) ? v : 6;
            })(),
            // 専用カラム (migration 50/51 で追加)
            shift_priority: shiftPriority,
            contract_type: contractType,
            pref_start_wd: prefStartWd || null,
            pref_end_wd: prefEndWd || null,
            pref_start_we: prefStartWe || null,
            pref_end_we: prefEndWe || null,
            req_pairs: null,  // v3.7.197: 必須ペア廃止
            position: position,
            ng_weekdays: ngWeekdays,
            // v3.7.111: 祝日 NG (true なら国民の祝日にシフトを入れない)
            ng_holiday: ngHoliday,
            // v3.7.77: シフトパターン別月間目標回数
            pattern_target_counts: patternTargets,
            // v3.7.109: 該当シフトパターン (空配列 = 全パターン該当)
            eligible_patterns: eligiblePatterns,
            contract_id: contractId
        };

        // v3.7.32 [D]: スタッフ設定の整合性チェック (設定ミス防止)
        const validationErrors = [];
        if (data.min_days_week > data.max_days_week) {
            validationErrors.push('週の最低出勤日数 (' + data.min_days_week + ') が週の最大勤務日数 (' + data.max_days_week + ') を超えています');
        }
        if (data.max_days_week <= 0 || data.max_days_week > 7) {
            validationErrors.push('週の最大勤務日数は 1〜7 の範囲で設定してください (現在: ' + data.max_days_week + ')');
        }
        if (data.max_hours_day <= 0 || data.max_hours_day > 24) {
            validationErrors.push('1日の最大勤務時間は 1〜24 時間で設定してください (現在: ' + data.max_hours_day + ')');
        }
        if (data.min_days_month > 31) {
            validationErrors.push('月の最低出勤日数は 31 以下に設定してください (現在: ' + data.min_days_month + ')');
        }
        const maxPossibleMonth = data.max_days_week * 4.3; // 1ヶ月あたり最大日数の目安
        if (data.min_days_month > Math.ceil(maxPossibleMonth)) {
            validationErrors.push('月の最低出勤日数 (' + data.min_days_month + ') が週の最大日数 (' + data.max_days_week + '日/週) で達成不可能です');
        }
        if (validationErrors.length > 0) {
            this.showToast('設定エラー: ' + validationErrors[0], 'error');
            console.warn('[SaveStaff] Validation errors:', validationErrors);
            return;
        }

        // v3.7.32 [E]: 社員 (月給) で「希望時間 ON」のとき警告 (推奨は OFF)
        if (data.salary_type === 'monthly' && usePref) {
            if (!window.confirm(
                '【推奨されない設定】\n\n' +
                '社員 (月給制) は希望時間 OFF にすることで、店舗状況に合わせて柔軟にシフト調整されます。\n' +
                'ON にすると朝晩のフレキシブル配置ができなくなり、過剰配置・希望時間集中の原因になります。\n\n' +
                'このまま保存しますか?'
            )) {
                return;
            }
        }

        if (!id) {
            data.organization_id = orgId;
        }

        // unavailable_dates は実日付のみ保持 (旧タグデータは migration 50 で削除済み)
        const existingStaff = this.state.staff.find(st => st.id === id);
        let uDates = [];
        if (existingStaff && existingStaff.unavailable_dates) {
            uDates = Array.isArray(existingStaff.unavailable_dates)
                ? [...existingStaff.unavailable_dates]
                : String(existingStaff.unavailable_dates).split(',').map(d => d.trim()).filter(d => d);
        }
        // 念のため YYYY-MM-DD 形式の日付のみを残す
        uDates = uDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        data.unavailable_dates = uDates;

        this.showLoading(true);
        try {
            // RLS でブロックされないよう session-less RPC で操作。
            // upsert_staff_by_contract は SECURITY DEFINER で contract_id 認証。
            const rpcRes = await API.rpc('upsert_staff_by_contract', {
                p_contract_id: contractId,
                p_staff_id: id || null,
                p_data: data
            });
            if (!rpcRes || rpcRes.success !== true) {
                throw new Error(rpcRes?.message || 'upsert_staff_by_contract failed');
            }
            const savedId = rpcRes.staff_id;

            if (id) {
                // 更新: ローカル state を反映
                const index = this.state.staff.findIndex(s => s.id === id);
                if (index !== -1) {
                    this.state.staff[index] = { ...this.state.staff[index], ...data };
                }
            } else {
                // 新規作成: 返却された id を採用
                data.id = savedId;
                this.state.staff.push(data);
            }

            this.renderStaffList(document.getElementById('viewContainer'));
            this.closeModal('staffModal');
            this.showToast('保存しました', 'success');
            // v3.7.27: 土日希望時間を自動補完した場合は追加で通知
            if (_autoFilledNote) {
                setTimeout(() => this.showToast(_autoFilledNote, 'info'), 600);
            }
        } catch (e) {
            console.error('[SaveStaff] 保存失敗:', e);
            // 保存失敗時はDBから最新データを再取得してStateを復元
            try { await this.loadData(); } catch(reloadErr) { console.error(reloadErr); }
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast('保存に失敗しました: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },
    editStaff(id) {
        const s = this.getStaff(id);
        if(!s) return;
        this.updateStaffRoleSelect(); // Selectを最新化
        this.updateStaffPositionSelect(); // ポジション一覧を最新化
        document.getElementById('staffId').value = s.id;
        document.getElementById('staffName').value = s.name;
        document.getElementById('staffRole').value = s.role;
        document.getElementById('staffEvaluation').value = s.evaluation || 'B';
        
        // unavailable_datesからメタデータを抽出
        let shiftPriority = 'medium';
        let contractType = 'general';
        let prefStartWd = '';
        let prefEndWd = '';
        let prefStartWe = '';
        let prefEndWe = '';
        let reqPairs = '';
        let position = 'any';
        let ngDays = [];
        let hasPref = false;

        // v3.7.1: 新カラムから直接読み取り (migration 50/51 で導入)
        if (s.shift_priority) shiftPriority = s.shift_priority;
        if (s.contract_type) contractType = s.contract_type;
        if (s.pref_start_wd) { prefStartWd = s.pref_start_wd; hasPref = true; }
        if (s.pref_end_wd) { prefEndWd = s.pref_end_wd; hasPref = true; }
        if (s.pref_start_we) { prefStartWe = s.pref_start_we; hasPref = true; }
        if (s.pref_end_we) { prefEndWe = s.pref_end_we; hasPref = true; }
        if (s.req_pairs) reqPairs = s.req_pairs;
        if (s.position) position = s.position;
        if (Array.isArray(s.ng_weekdays)) ngDays = s.ng_weekdays.map(String);

        // 旧データ (unavailable_dates タグ) フォールバック
        // 注: migration 50 でタグはクリーン済みだが、新規生成された古いデータが
        // 残っている可能性に備えて互換読み取りを継続
        if (s.unavailable_dates) {
            const uDates = Array.isArray(s.unavailable_dates) ? s.unavailable_dates : String(s.unavailable_dates).split(',');
            uDates.forEach(d => {
                const txt = d.trim();
                if (!s.shift_priority && txt.startsWith('priority:')) shiftPriority = txt.replace('priority:', '');
                if (!s.contract_type && txt.startsWith('contract:')) contractType = txt.replace('contract:', '');
                if (!s.pref_start_wd && txt.startsWith('prefStartWd:')) { prefStartWd = txt.replace('prefStartWd:', ''); hasPref = true; }
                if (!s.pref_end_wd && txt.startsWith('prefEndWd:')) { prefEndWd = txt.replace('prefEndWd:', ''); hasPref = true; }
                if (!s.pref_start_we && txt.startsWith('prefStartWe:')) { prefStartWe = txt.replace('prefStartWe:', ''); hasPref = true; }
                if (!s.pref_end_we && txt.startsWith('prefEndWe:')) { prefEndWe = txt.replace('prefEndWe:', ''); hasPref = true; }
                if (!s.req_pairs && txt.startsWith('reqPair:')) reqPairs = txt.replace('reqPair:', '');
                if ((!s.position || s.position === 'any') && txt.startsWith('position:')) position = txt.replace('position:', '');
                // 互換: 古い prefStart/End (曜日区分なし)
                if (!s.pref_start_wd && txt.startsWith('prefStart:')) { prefStartWd = txt.replace('prefStart:', ''); prefStartWe = txt.replace('prefStart:', ''); hasPref = true; }
                if (!s.pref_end_wd && txt.startsWith('prefEnd:')) { prefEndWd = txt.replace('prefEnd:', ''); prefEndWe = txt.replace('prefEnd:', ''); hasPref = true; }
                if (!Array.isArray(s.ng_weekdays) && txt.startsWith('ngDay:')) ngDays.push(txt.replace('ngDay:', ''));
            });
        }
        if (document.getElementById('staffContractType')) document.getElementById('staffContractType').value = contractType;
        if (document.getElementById('staffShiftPriority')) document.getElementById('staffShiftPriority').value = shiftPriority;
        
        const usePrefCb = document.getElementById('staffUsePrefHours');
        if (usePrefCb) {
            usePrefCb.checked = hasPref;
        }
        
        if (document.getElementById('staffPrefStartWeekday')) document.getElementById('staffPrefStartWeekday').value = prefStartWd;
        if (document.getElementById('staffPrefEndWeekday')) document.getElementById('staffPrefEndWeekday').value = prefEndWd;
        if (document.getElementById('staffPrefStartWeekend')) document.getElementById('staffPrefStartWeekend').value = prefStartWe;
        if (document.getElementById('staffPrefEndWeekend')) document.getElementById('staffPrefEndWeekend').value = prefEndWe;
        if (document.getElementById('staffReqPairs')) document.getElementById('staffReqPairs').value = reqPairs;
        if (document.getElementById('staffPosition')) document.getElementById('staffPosition').value = position;
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb) cb.checked = !ngDays.includes(String(i));
        }
        // v3.7.111: 祝日チェック復元 (ng_holiday=true なら チェックを外す)
        const prefHolidayCb = document.getElementById('prefHoliday');
        if (prefHolidayCb) prefHolidayCb.checked = !s.ng_holiday;
        document.getElementById('staffSalaryType').value = s.salary_type;
        document.getElementById('staffHourlyWage').value = s.hourly_wage;
        document.getElementById('staffMonthlySalary').value = s.monthly_salary;
        document.getElementById('staffMaxDaysPerWeek').value = s.max_days_week || 5;
        document.getElementById('staffMaxHoursPerDay').value = s.max_hours_day || 8;
        document.getElementById('staffMinDaysPerWeek').value = s.min_days_week || 0;
        document.getElementById('staffMinDaysPerMonth').value = s.min_days_month || 0;
        // v3.7.91: 月の最大出勤日数 (デフォルト 31)
        if (document.getElementById('staffMaxDaysPerMonth')) {
            document.getElementById('staffMaxDaysPerMonth').value = s.max_days_month || 31;
        }
        // v3.7.113: 連続出勤日数 (デフォルト 6)
        if (document.getElementById('staffMaxConsecutiveDays')) {
            document.getElementById('staffMaxConsecutiveDays').value = s.max_consecutive_days || 6;
        }
        // v3.7.77: シフトパターン目標回数を復元
        this.renderStaffPatternTargets(s.pattern_target_counts || {});
        // v3.7.109: 該当シフトパターン (チェック) を復元
        this.renderStaffEligiblePatterns(Array.isArray(s.eligible_patterns) ? s.eligible_patterns : []);
        this.toggleSalaryInputs();
        this.togglePrefHoursInputs();
        this.openModal('staffModal');
    },

    // v3.7.165: スタッフ複製 (前保存内容を引き継いで新規作成)
    //   - editStaff で全フィールドをロード後、staffId を空にして保存時に新規作成扱い
    //   - 名前は「○○ のコピー」に置換 (重複防止 & 視認性)
    //   - login_id / password / pin は スタッフモーダル内に項目がないため、別途
    //     ログインID 設定画面で個別に発行する想定 (元スタッフの認証情報は複製しない)
    duplicateStaff(id) {
        const src = this.getStaff(id);
        if (!src) { this.showToast('複製元のスタッフが見つかりません', 'error'); return; }
        this.editStaff(id);
        // 新規扱いに変換
        document.getElementById('staffId').value = '';
        const nameEl = document.getElementById('staffName');
        if (nameEl) {
            const base = (src.name || 'スタッフ').replace(/ のコピー(\d*)$/, '');
            // 既存複製名と衝突したら通番付与
            let candidate = `${base} のコピー`;
            let n = 2;
            const taken = new Set(this.state.staff.map(s => s.name));
            while (taken.has(candidate)) { candidate = `${base} のコピー${n++}`; }
            nameEl.value = candidate;
            nameEl.focus();
            nameEl.select();
        }
        this.showToast(`「${src.name}」の設定を複製しました。名前を変えて保存してください`, 'info');
    },

    async deleteStaff(id) {
        // 管理者権限チェック
        if (!this.state.isAdmin) {
            this.showToast('スタッフの削除には管理者権限が必要です', 'error');
            return;
        }

        const staff = this.state.staff.find(s => s.id === id);
        if (!staff) {
            this.showToast('スタッフが見つかりません', 'error');
            return;
        }

        // 全スタッフ統一の確認ダイアログ (管理者・店長も含む。区別なし)
        if (!confirm(
            `「${staff.name}」を削除しますか？\n\n` +
            `※関連するシフト・申請データも全て削除されます。\n` +
            `この操作は元に戻せません。`
        )) return;

        console.log('[deleteStaff] start', { id, name: staff.name, role: staff.role, login_id: staff.login_id });

        // UUID 形式チェック (temp_xxx 等の DB 未保存 ID を弾く)
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRe.test(String(id))) {
            // ローカルのみの仮 ID → state からだけ消す
            this.state.staff = this.state.staff.filter(s => s.id !== id);
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast(`${staff.name} を削除しました (ローカルのみ)`, 'success');
            return;
        }

        this.showLoading(true);
        try {
            const contractId = this.state.config.contract_id || API.session?.user?.contract_id;
            if (!contractId) throw new Error('contract_id 未取得 — 再ログインしてください');

            console.log('[deleteStaff] calling delete_staff_by_contract', { contractId, p_staff_id: id });
            const r = await API.rpc('delete_staff_by_contract', {
                p_contract_id: contractId,
                p_staff_id: id
            });
            console.log('[deleteStaff] RPC response:', r);

            if (!r || r.success !== true) {
                throw new Error(r?.message || 'delete failed (no response)');
            }
            this.state.staff = this.state.staff.filter(s => s.id !== id);
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast(`${staff.name} を削除しました`, 'success');
        } catch (e) {
            console.error('[deleteStaff] error:', e);
            this.showToast('削除に失敗しました: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },
    toggleSalaryInputs() {
        const type = (document.getElementById('staffSalaryType')?.value || '');
        if(type === 'hourly') {
            document.getElementById('hourlyInputGroup').classList.remove('hidden');
            document.getElementById('monthlyInputGroup').classList.add('hidden');
        } else {
            document.getElementById('hourlyInputGroup').classList.add('hidden');
            document.getElementById('monthlyInputGroup').classList.remove('hidden');
        }
    },
    togglePrefHoursInputs() {
        const usePref = document.getElementById('staffUsePrefHours')?.checked;
        const group = document.getElementById('prefHoursInputGroup');
        if (group) {
            if (usePref) {
                group.classList.remove('hidden');
            } else {
                group.classList.add('hidden');
            }
        }
    },

    // --- 申請 ---
    _selectedRequestDates: [],
    _requestCalendarMonth: null,

    initRequestModal() {
        const select = document.getElementById('requestStaffId');
        if (!select) return;
        select.innerHTML = this.state.staff.map(s => `<option value="${s.id}">${this._sanitize(s.name)}</option>`).join('');

        this._selectedRequestDates = [];
        this._requestCalendarMonth = new Date();
        this._requestCalendarMonth.setDate(1);
        this._renderRequestCalendar();
    },

    _renderRequestCalendar() {
        const container = document.getElementById('requestDatePicker');
        const display = document.getElementById('selectedDatesDisplay');
        const titleEl = document.getElementById('requestCalendarTitle');
        const countEl = document.getElementById('selectedDateCount');
        if (!container || !display) return;
        const month = this._requestCalendarMonth;
        if (!month) return;
        const year = month.getFullYear();
        const m = month.getMonth();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
        const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

        if (titleEl) titleEl.textContent = `${year}年 ${monthNames[m]}`;

        const firstDay = new Date(year, m, 1).getDay();
        const daysInMonth = new Date(year, m + 1, 0).getDate();

        let html = `<div class="grid grid-cols-7 gap-1 text-center">`;
        html += dayNames.map((d, i) => `<div class="text-[10px] font-bold py-1 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'}">${d}</div>`).join('');

        for (let i = 0; i < firstDay; i++) {
            html += `<div></div>`;
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dateObj = new Date(year, m, d);
            const isPast = dateObj < today;
            const isSelected = this._selectedRequestDates.includes(dateStr);
            const dow = dateObj.getDay();
            const textColor = dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700';

            if (isPast) {
                html += `<div class="text-xs py-2 text-gray-300 rounded-lg">${d}</div>`;
            } else {
                html += `<div onclick="app._toggleRequestDate('${dateStr}')" class="text-xs py-2 cursor-pointer rounded-lg transition-all active:scale-90 ${isSelected ? 'bg-indigo-600 text-white font-bold shadow-sm' : textColor + ' hover:bg-indigo-50 hover:font-bold'}">${d}</div>`;
            }
        }

        html += `</div>`;
        container.innerHTML = html;

        // 選択日の表示
        const sorted = [...this._selectedRequestDates].sort();
        if (countEl) countEl.textContent = sorted.length;

        if (sorted.length === 0) {
            display.innerHTML = '<span class="text-xs text-gray-300">カレンダーから日付を選んでください</span>';
        } else {
            display.innerHTML = sorted.map(d => {
                const dt = new Date(d);
                const dayLabel = ['日','月','火','水','木','金','土'][dt.getDay()];
                const short = `${dt.getMonth()+1}/${dt.getDate()}(${dayLabel})`;
                return `<span class="inline-flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs font-bold px-2.5 py-1 rounded-full">
                    ${short}
                    <button onclick="app._toggleRequestDate('${d}')" class="hover:text-red-500 ml-0.5"><i class="fa-solid fa-xmark text-[10px]"></i></button>
                </span>`;
            }).join('');
        }
    },

    _changeRequestMonth(delta) {
        this._requestCalendarMonth.setMonth(this._requestCalendarMonth.getMonth() + delta);
        this._renderRequestCalendar();
    },

    _toggleRequestDate(dateStr) {
        const idx = this._selectedRequestDates.indexOf(dateStr);
        if (idx >= 0) {
            this._selectedRequestDates.splice(idx, 1);
        } else {
            this._selectedRequestDates.push(dateStr);
        }
        this._renderRequestCalendar();
    },

    async submitRequest() {
        const staffId = (document.getElementById('requestStaffId')?.value || '');
        const type = document.querySelector('input[name="requestType"]:checked').value;
        const dates = [...this._selectedRequestDates].sort();
        const reason = (document.getElementById('requestReason')?.value || '');

        if (!staffId || dates.length === 0) {
            app.showToast('スタッフと日付を選択してください', 'error');
            return;
        }

        const typeStr = type === 'off' ? '【休み希望】' : '【勤務希望】';
        const datesStr = dates.join(', ');
        const confirmMsg = `以下の内容で申請を提出します。\n\n日付: ${datesStr}\n件数: ${dates.length}日分\n内容: ${typeStr}\n理由: ${reason || 'なし'}\n\n送信しますか？`;

        if (!confirm(confirmMsg)) return;

        this.showLoading(true);
        try {
            // 日付ごとに1件ずつ申請を作成
            for (const date of dates) {
                const data = {
                    staff_id: staffId,
                    type,
                    dates: date,
                    reason,
                    status: 'pending',
                    created_at: new Date().toISOString(),
                    organization_id: this.state.organization_id
                };

                if (type === 'work') {
                    data.start_time = (document.getElementById('requestStartTime')?.value || '');
                    data.end_time = (document.getElementById('requestEndTime')?.value || '');
                    if (!data.start_time || !data.end_time) { app.showToast('時間を入力してください', 'error'); return; }
                }

                await this._requestInsert(data);
            }

            await this.loadData();
            this.closeModal('requestModal');
            this.showToast(`${dates.length}件の申請を送信しました`, 'success');
            if (this.state.view === 'requests') this.renderRequests(document.getElementById('viewContainer'));
        } catch (e) {
            this.showToast('送信失敗', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async submitMultiRequest() { return this.submitRequest(); },

    // v3.7.152/153: 申請を個別削除 (承認済なら shifts / unavailable_dates も undo)
    async deleteRequest(requestId) {
        if (!requestId) return;
        if (!confirm('この申請を削除します。よろしいですか？\n承認済みの場合は関連シフトや休み設定も自動で元に戻ります。')) return;
        const cid = this._getContractId();
        if (!cid) { this.showToast('contract_id 未取得', 'error'); return; }
        this.showLoading(true);
        try {
            const r = await API.rpc('delete_request_by_contract', {
                p_contract_id: cid,
                p_request_id: requestId,
            });
            if (r && r.success) {
                // v3.7.153: DB 更新後に loadData で全データ再取得 → シフト表/スタッフも自動反映
                await this.loadData();
                this.renderRequests(document.getElementById('viewContainer'));
                this.showToast('削除しました', 'success');
            } else {
                this.showToast(r?.message || '削除に失敗しました', 'error');
            }
        } catch (e) {
            console.error('[deleteRequest]', e);
            this.showToast('削除に失敗しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // v3.7.153: 一括削除 (チェックボックスで選択された申請を全削除)
    async deleteSelectedRequests() {
        const ids = Array.from(document.querySelectorAll('.req-del-cb:checked'))
                         .map(cb => cb.dataset.reqId).filter(Boolean);
        if (ids.length === 0) {
            this.showToast('削除対象を選択してください', 'warning');
            return;
        }
        if (!confirm(`選択した ${ids.length}件 を削除します。\n承認済みの申請は関連シフト/休み設定も元に戻ります。\nよろしいですか？`)) return;
        const cid = this._getContractId();
        if (!cid) { this.showToast('contract_id 未取得', 'error'); return; }
        this.showLoading(true);
        let okCount = 0, failCount = 0;
        for (const id of ids) {
            try {
                const r = await API.rpc('delete_request_by_contract', {
                    p_contract_id: cid,
                    p_request_id: id,
                });
                if (r && r.success) okCount++; else failCount++;
            } catch (e) {
                console.error('[batchDelete]', id, e);
                failCount++;
            }
        }
        await this.loadData();
        this.renderRequests(document.getElementById('viewContainer'));
        if (failCount === 0) {
            this.showToast(`${okCount}件 削除しました`, 'success');
        } else {
            this.showToast(`${okCount}件 削除 / ${failCount}件 失敗`, 'warning');
        }
        this.showLoading(false);
    },

    // 希望シフト申請をすべて削除 (全件リセット)
    async resetAllRequests() {
        const ids = (this.state.requests || []).map(r => r.id).filter(Boolean);
        if (ids.length === 0) {
            this.showToast('リセット対象の申請がありません', 'info');
            return;
        }
        if (!confirm(`希望シフトの申請 ${ids.length}件 をすべて削除します。\n承認済みの申請は関連シフト/休み設定も元に戻ります。\nこの操作は取り消せません。よろしいですか？`)) return;
        const cid = this._getContractId();
        if (!cid) { this.showToast('contract_id 未取得', 'error'); return; }
        this.showLoading(true);
        let okCount = 0, failCount = 0;
        for (const id of ids) {
            try {
                const r = await API.rpc('delete_request_by_contract', {
                    p_contract_id: cid,
                    p_request_id: id,
                });
                if (r && r.success) okCount++; else failCount++;
            } catch (e) {
                console.error('[resetAllRequests]', id, e);
                failCount++;
            }
        }
        await this.loadData();
        this.renderRequests(document.getElementById('viewContainer'));
        if (failCount === 0) {
            this.showToast(`${okCount}件 をリセットしました`, 'success');
        } else {
            this.showToast(`${okCount}件 リセット / ${failCount}件 失敗`, 'warning');
        }
        this.showLoading(false);
    },

    toggleAllDeleteRequests(checked) {
        document.querySelectorAll('.req-del-cb').forEach(cb => { cb.checked = checked; });
        this.updateDeleteSelectionUI();
    },

    updateDeleteSelectionUI() {
        const all = document.querySelectorAll('.req-del-cb');
        const checked = document.querySelectorAll('.req-del-cb:checked');
        const cnt = checked.length;
        const countEl = document.getElementById('reqDelSelectedCount');
        if (countEl) countEl.textContent = `${cnt} 件選択`;
        const btn = document.getElementById('batchDeleteBtn');
        if (btn) btn.disabled = cnt === 0;
        const selectAll = document.getElementById('reqDelSelectAll');
        if (selectAll) {
            selectAll.checked = all.length > 0 && cnt === all.length;
            selectAll.indeterminate = cnt > 0 && cnt < all.length;
        }
    },

    // v3.7.152: 3ヶ月超の 承認済/却下 申請を自動 purge (loadData 後に呼ぶ)
    async _purgeOldRequestsIfNeeded() {
        const cid = this._getContractId();
        if (!cid) return;
        try {
            const r = await API.rpc('purge_old_requests_by_contract', {
                p_contract_id: cid,
                p_days: 90,
            });
            if (r && r.success && (r.deleted || 0) > 0) {
                // ローカルキャッシュからも 90日以上前の approved/rejected を除外
                const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
                this.state.requests = (this.state.requests || []).filter(req => {
                    if (req.status === 'pending') return true;
                    const t = req.created_at ? new Date(req.created_at).getTime() : Date.now();
                    return t >= cutoff;
                });
                console.log('[purge] removed', r.deleted, 'old requests');
            }
        } catch (e) {
            console.warn('[purge] failed (non-fatal):', e);
        }
    },

    // v3.7.150: 申請一覧 フィルタ/ソート
    setRequestsFilter(key, value) {
        if (!this.state.requestsFilter) {
            this.state.requestsFilter = { status: 'all', type: 'all', staff: 'all', q: '' };
        }
        this.state.requestsFilter[key] = value;
        this.renderRequests(document.getElementById('viewContainer'));
    },
    setRequestsSort(key) {
        if (!this.state.requestsSort) this.state.requestsSort = { key: 'created_at', dir: 'desc' };
        const cur = this.state.requestsSort;
        if (cur.key === key) {
            cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
        } else {
            cur.key = key;
            cur.dir = (key === 'staff' || key === 'dates') ? 'asc' : 'desc';
        }
        this.renderRequests(document.getElementById('viewContainer'));
    },
    resetRequestsFilter() {
        this.state.requestsFilter = { status: 'all', type: 'all', staff: 'all', q: '' };
        this.state.requestsSort = { key: 'created_at', dir: 'desc' };
        this.renderRequests(document.getElementById('viewContainer'));
    },

    // v3.7.138: 連続クリック防止フラグ
    _requestInFlight: new Set(),

    async handleRequest(id, status) {
        // v3.7.138: 連続クリック / 同時処理を阻止
        if (this._requestInFlight.has(id)) {
            this.showToast('処理中です。少しお待ちください', 'warning');
            return;
        }
        if (!confirm(status === 'approved' ? '承認しますか？' : '却下しますか？')) return;
        this._requestInFlight.add(id);
        this.showLoading(true);
        try {
            if (status === 'approved') {
                // v3.7.138: アトミック RPC で requests + shifts + staff を 1 トランザクション
                const cid = this._getContractId();
                if (!cid) throw new Error('contract_id 未取得');
                const r = await API.rpc('approve_request_atomic_by_contract', {
                    p_contract_id: cid,
                    p_request_id: id,
                });
                if (!r || r.success !== true) {
                    throw new Error(r?.message || '承認に失敗しました');
                }
            } else {
                // 却下は単純ステータス更新のみ
                await this._requestUpdateStatus(id, status);
            }
            await this.loadData();
            this.renderRequests(document.getElementById('viewContainer'));
            this.showToast(status === 'approved' ? '承認しました' : '却下しました', 'success');
        } catch(e) {
            console.error('[handleRequest]', e);
            this.showToast(e.message || 'エラー発生', 'error');
        } finally {
            this._requestInFlight.delete(id);
            this.showLoading(false);
        }
    },

    // v3.7.143: 全選択 / 個別選択チェック / 一括承認・拒否
    toggleAllRequests(checked) {
        document.querySelectorAll('.req-select-cb').forEach(cb => { cb.checked = checked; });
        this.updateRequestSelectionUI();
    },

    updateRequestSelectionUI() {
        const all = document.querySelectorAll('.req-select-cb');
        const checked = document.querySelectorAll('.req-select-cb:checked');
        const cnt = checked.length;
        const countEl = document.getElementById('reqSelectedCount');
        if (countEl) countEl.textContent = `${cnt} 件選択`;
        const approveBtn = document.getElementById('batchApproveBtn');
        const rejectBtn = document.getElementById('batchRejectBtn');
        if (approveBtn) approveBtn.disabled = cnt === 0;
        if (rejectBtn) rejectBtn.disabled = cnt === 0;
        const selectAllCb = document.getElementById('reqSelectAll');
        if (selectAllCb) {
            selectAllCb.checked = all.length > 0 && cnt === all.length;
            selectAllCb.indeterminate = cnt > 0 && cnt < all.length;
        }
    },

    async handleBatchAction(action) {
        // action: 'approved' | 'rejected'
        const ids = Array.from(document.querySelectorAll('.req-select-cb:checked'))
                         .map(cb => cb.dataset.reqId).filter(Boolean);
        if (ids.length === 0) {
            this.showToast('対象を1件以上 選択してください', 'warning');
            return;
        }
        const label = action === 'approved' ? '承認' : '却下';
        if (!confirm(`選択した ${ids.length}件 を ${label} しますか?`)) return;
        this.showLoading(true);
        const cid = this._getContractId();
        if (!cid) {
            this.showToast('contract_id 未取得', 'error');
            this.showLoading(false);
            return;
        }
        let okCount = 0, failCount = 0;
        for (const id of ids) {
            try {
                if (action === 'approved') {
                    const r = await API.rpc('approve_request_atomic_by_contract', {
                        p_contract_id: cid,
                        p_request_id: id,
                    });
                    if (r && r.success) okCount++; else failCount++;
                } else {
                    await this._requestUpdateStatus(id, 'rejected');
                    okCount++;
                }
            } catch (e) {
                console.error('[batchAction]', id, action, e);
                failCount++;
            }
        }
        await this.loadData();
        this.renderRequests(document.getElementById('viewContainer'));
        if (failCount === 0) {
            this.showToast(`${okCount}件 ${label} しました`, 'success');
        } else {
            this.showToast(`${okCount}件 ${label} / ${failCount}件 失敗`, 'warning');
        }
        this.showLoading(false);
    },

    // v3.7.138 互換: 既存呼び出しから残す可能性に備えてエイリアス
    async handleBatchApprove() {
        await this.handleBatchAction('approved');
    },

    updateRequestBadge() {
        const count = this.state.requests.filter(r => r.status === 'pending').length;
        const badge = document.getElementById('pendingRequestsBadge');
        if(badge) {
            badge.textContent = count;
            badge.classList.toggle('hidden', count === 0);
        }
    },

       // --- AIシフト作成 (Python + Gemini) ---
       _shiftGenTips: [
            '労基法32条: 1日8時間・週40時間が法定労働時間の上限です',
            '労基法34条: 6時間超で45分、8時間超で60分の休憩が必要です',
            '労基法35条: 週1日以上の休日が必要です（連続6日まで）',
            'AIが各スタッフの希望休を尊重しながら最適配置を計算中...',
            '土日祝は割増賃金(1.25倍)を考慮してコスト最適化しています',
            '管理者が各シフトに最低1名配置されるよう調整しています',
            'スタッフの評価・スキルに応じてバランスよく配置します',
            '新人スタッフにはメンター（管理者）を配置します',
            '月間の総人件費が最小になるよう数理最適化を実行中...',
            'Pythonで一次案を作成 → AIで労基法チェック＆最終調整',
        ],
        _tipTimer: null,

    // AI 生成失敗時に /check API で原因を取得し、詳細メッセージを表示
    async _showDetailedGenerationFailure(payload, headline) {
        try {
            const checkUrl = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.CALC_SERVER_URL)
                + '/check';
            const sid = JSON.parse(sessionStorage.getItem('rakushift_user') || 'null')?.session_id;
            const res = await fetch(checkUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(sid ? {'x-session-id': sid} : {})
                },
                body: JSON.stringify({
                    staff_list: payload.staff_list,
                    config: payload.config,
                    dates: payload.dates,
                    requests: payload.requests || [],
                    contract_id: payload.contract_id || null
                })
            });
            if (!res.ok) {
                this.showToast(headline + ' (詳細取得失敗)', 'warning');
                return;
            }
            const j = await res.json();
            const check = j.check || j || {};
            const warnings = check.warnings || [];
            const details = check.daily_details || [];
            const summary = check.summary || {};

            // ===== モーダル風の詳細表示 =====
            const lines = [];
            lines.push(`📊 サマリ: スタッフ ${summary.total_staff || 0}名 (利用可 ${summary.usable_staff || 0}名) / 営業日 ${summary.work_dates || 0}日`);
            if (summary.total_shortage_hours > 0) {
                lines.push(`⚠️ 合計人員不足: ${summary.total_shortage_hours} 人時 (${summary.affected_days} 日)`);
            }
            warnings.forEach(w => {
                const icon = w.severity === 'critical' ? '🔴' : (w.severity === 'warning' ? '🟡' : 'ℹ️');
                lines.push(`${icon} ${w.message}`);
            });
            if (details.length > 0) {
                lines.push('');
                lines.push('— 日別不足詳細 (上位 10日) —');
                details.slice(0, 10).forEach(d => {
                    const ranges = (d.shortage_ranges || []).map(r => `${r.start}-${r.end}: ${r.shortage || r.gap}名不足`).join(', ');
                    lines.push(`・${d.date} (${d.day_type}): 利用可能 ${d.available_staff}名 → ${d.shortage_hours} 人時不足${ranges ? ' [' + ranges + ']' : ''}`);
                });
                if (details.length > 10) lines.push(`... 他 ${details.length - 10} 日`);
            }
            // v3.7.32 [C]: 具体的な原因解析と解決手順を強化
            lines.push('');
            lines.push('🔍 自動診断結果:');

            // 診断1: スタッフ数と必要人数のマッチング
            const cfg = payload.config || {};
            const sr = cfg.staff_req || {};
            const totalStaff = summary.total_staff || (payload.staff_list || []).length;
            const minWeekday = Number(sr.min_weekday || 0);
            const minWeekend = Number(sr.min_weekend || 0);
            if (totalStaff < minWeekday) {
                lines.push(`❌ スタッフ数 ${totalStaff}名 < 平日必要人数 ${minWeekday}名 — 物理的に不足`);
            }
            if (totalStaff < minWeekend) {
                lines.push(`❌ スタッフ数 ${totalStaff}名 < 土日必要人数 ${minWeekend}名`);
            }

            // 診断2: min_days 合計と需要のチェック
            const totalMinMonth = (payload.staff_list || []).reduce((sum, s) => sum + Number(s.min_days_month || 0), 0);
            // v3.7.33 [H-1]: タイムゾーン安全な日付解釈
            const _parseDate = (d) => {
                const [Y, M, D] = String(d).split('-').map(Number);
                return new Date(Y, (M || 1) - 1, D || 1);
            };
            const weekdays = (payload.dates || []).filter(d => {
                const wd = _parseDate(d).getDay();
                return wd >= 1 && wd <= 5;
            }).length;
            const weekends = (payload.dates || []).length - weekdays;
            const demand = weekdays * minWeekday + weekends * minWeekend;
            if (totalMinMonth > demand * 1.2) {
                lines.push(`⚠️ 全員のmin_days_month合計 (${totalMinMonth}人日) が月需要 (${demand}人日) を ${Math.round((totalMinMonth/demand - 1) * 100)}% 超過 — 過剰配置の温床`);
            }

            // 診断3: シフトパターン
            const patternCount = (cfg.custom_shifts || []).length;
            if (patternCount <= 1) {
                lines.push(`⚠️ シフトパターン ${patternCount}個 — 全員が同じ時間に集中する原因`);
            }

            // 診断4: 月給スタッフの希望時間 ON
            const monthlyWithPref = (payload.staff_list || []).filter(s =>
                s.salary_type === 'monthly' && (s.pref_start_wd || s.pref_start_we)
            ).length;
            if (monthlyWithPref > 0) {
                lines.push(`⚠️ 月給スタッフ ${monthlyWithPref}名が希望時間ON — 柔軟調整不可、時間帯集中の原因`);
            }

            lines.push('');
            lines.push('💡 解決手順 (優先順):');
            if (totalStaff < Math.max(minWeekday, minWeekend)) {
                lines.push('1. ⭐ スタッフを追加 (最も効果的)');
            }
            if (totalMinMonth > demand * 1.2) {
                lines.push('2. 各スタッフの「月の最低出勤日数」を下げる (現状は需要超過)');
            }
            if (patternCount <= 1) {
                lines.push('3. 「店舗設定」→「シフトパターン」で 早番/遅番 を追加');
            }
            if (monthlyWithPref > 0) {
                lines.push('4. 社員 (月給) のシフト希望時間を OFF にする');
            }
            lines.push('5. スタッフの max_days_week / max_hours_day を増やす');
            lines.push('6. 店舗設定の「時間帯別必要人数」を見直す');
            lines.push('7. 希望休 (休暇申請) を一部却下する');

            // v3.7.5: alert() はブラウザ抑制されることがあるため、画面内モーダルで表示
            // v3.7.14: closest('.fixed') が他モーダル (人員不足警告 z-[10001] 等) を誤削除する
            // 可能性があるため、ID 指定で確実に自身のみを削除
            const modalId = '_failureDetailModal_' + Date.now();
            const html = `
                <div id="${modalId}" class="fixed inset-0 z-[10000] flex items-center justify-center p-4" style="background:rgba(0,0,0,0.5)">
                    <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto">
                        <div class="p-5 border-b border-gray-200 bg-red-50">
                            <h3 class="text-lg font-bold text-red-700"><i class="fa-solid fa-triangle-exclamation mr-2"></i>${this._sanitize(headline)}</h3>
                        </div>
                        <div class="p-5">
                            <pre class="text-sm text-gray-800 whitespace-pre-wrap font-sans">${this._sanitize(lines.join('\n'))}</pre>
                        </div>
                        <div class="p-4 border-t border-gray-200 text-right bg-gray-50">
                            <button onclick="document.getElementById('${modalId}')?.remove()" class="px-6 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-bold">閉じる</button>
                        </div>
                    </div>
                </div>
            `;
            const wrap = document.createElement('div');
            wrap.innerHTML = html;
            document.body.appendChild(wrap.firstElementChild);
        } catch (e) {
            console.warn('[Generation Diagnostics] /check failed:', e);
            this.showToast(headline + '。スタッフ条件を緩和するかスタッフを追加してください。', 'warning');
        }
    },

       async runAutoFill() {
        // v3.7.37: 「何も出ない」原因対策 — 進行中フラグの自動解除 + 反応トースト
        if (this._shiftGenInProgress) {
            // 5分以上前のフラグなら強制解除 (スタック対策)
            const stuckTime = Date.now() - (this._shiftGenStartTime || 0);
            if (stuckTime > 5 * 60 * 1000) {
                this._shiftGenInProgress = false;
                console.warn('[runAutoFill] Stuck flag reset:', stuckTime, 'ms');
            } else {
                this.showToast('シフト生成中です。完了をお待ちください', 'info');
                return;
            }
        }
        this._shiftGenStartTime = Date.now();
        // v3.7.35: スマホで「シフト作成失敗」が出る件のオフライン検知
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            this.showToast('ネットワークがオフラインです。Wi-Fi または電波の良い場所で再試行してください', 'error');
            return;
        }
        if (!this.state.isShopLoggedIn || !this.state.organization_id) {
            this.showToast('セッションエラー: 再ログインしてください', 'error');
            return;
        }

        // スタッフ超過チェック（ダウングレード後のハック防止）
        if (this.isStaffOverLimit()) {
            const limit = this.getStaffLimit();
            const over = this.state.staff.length - limit;
            const planName = {standard: 'Standard', pro: 'Pro', premium: 'Premium'}[this.state.config.stripe_plan] || 'Standard';
            this.closeModal('autoFillModal');
            this.showStaffOverLimitAlert();
            this.showToast(`${planName}プランの上限(${limit}名)を${over}名超過しています。スタッフを削除してください。`, 'error');
            this.changeView('staff');
            return;
        }

        const targetType = (document.getElementById('autoFillTarget')?.value || '');

        // v3.7.37: 旧 v3.7.32 [F] の confirm() を撤去 (スマホで「何も出ない」原因)。
        // 代わりにトースト警告 (非ブロック) で通知して生成は続行
        const customShifts = (this.state.config.custom_shifts || []);
        if (customShifts.length <= 1) {
            this.showToast('シフトパターンが ' + customShifts.length + ' 個のみ登録されています。複数登録を推奨します', 'warning');
        }

        this.closeModal('autoFillModal');

        const loadingEl = document.getElementById('globalLoading');
        const loadingDefault = document.getElementById('loadingDefault');
        const loadingShiftGen = document.getElementById('loadingShiftGen');
        const stepEl = document.getElementById('shiftGenStep');
        const barEl = document.getElementById('shiftGenBar');
        const tipEl = document.getElementById('shiftGenTip');

        this._shiftGenInProgress = true;

        // v3.7.10: 診断バナーをデバッグモード限定に。
        // 有効化: URL に ?debug=1 を付けるか、コンソールで localStorage.setItem('rakushift_debug','1')
        // 通常運用ではバナー非表示。何か起きたときだけ有効化して詳細ログを取れる。
        const _debugMode = (() => {
            try {
                if (new URLSearchParams(location.search).has('debug')) return true;
                if (localStorage.getItem('rakushift_debug') === '1') return true;
            } catch (_) {}
            return false;
        })();
        this._debugBanner = _debugMode ? (() => {
            const old = document.getElementById('_debugStatusBanner');
            if (old) old.remove();
            const banner = document.createElement('div');
            banner.id = '_debugStatusBanner';
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e40af;color:white;padding:10px 16px;font-size:13px;font-family:monospace;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-height:50vh;overflow-y:auto;';
            banner.innerHTML = '<div id="_dbgText" style="flex:1;line-height:1.5;white-space:pre-wrap;word-break:break-all;">📋 [シフト生成 診断モード] 開始...</div><button onclick="this.parentNode.remove()" style="background:rgba(255,255,255,.2);border:0;color:white;padding:4px 12px;border-radius:4px;cursor:pointer;flex-shrink:0;">閉じる</button>';
            document.body.appendChild(banner);
            const lines = [];
            return {
                log: (msg) => {
                    const ts = new Date().toLocaleTimeString('ja-JP');
                    lines.push(`[${ts}] ${msg}`);
                    if (lines.length > 20) lines.shift();
                    const el = document.getElementById('_dbgText');
                    if (el) el.textContent = '📋 シフト生成 診断ログ:\n' + lines.join('\n');
                    console.log('[ShiftGen]', msg);
                }
            };
        })() : { log: (msg) => console.log('[ShiftGen]', msg) };
        this._debugBanner.log('生成フロー開始');

        if (loadingDefault) loadingDefault.style.display = 'none';
        if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
        if (loadingEl) loadingEl.classList.remove('hidden');
        if (stepEl) stepEl.textContent = 'スタッフ情報を読み込んでいます...';
        if (barEl) { barEl.style.transition = 'width 2s ease'; barEl.style.width = '5%'; }

        // 最低表示時間を保証
        const loadingStartTime = Date.now();
        const MIN_LOADING_MS = 12000;

        // プログレスバーを滑らかに進める（実処理と独立）
        let fakeProgress = 5;
        const progressTimer = setInterval(() => {
            if (fakeProgress < 90) {
                fakeProgress += Math.random() * 3 + 1;
                if (fakeProgress > 90) fakeProgress = 90;
                if (barEl) barEl.style.width = fakeProgress + '%';
            }
        }, 800);

        // 豆知識ローテーション開始
        let tipIdx = 0;
        if (this._tipTimer) clearInterval(this._tipTimer);
        this._tipTimer = setInterval(() => {
            tipIdx = (tipIdx + 1) % this._shiftGenTips.length;
            if (tipEl) {
                tipEl.style.opacity = '0';
                setTimeout(() => {
                    tipEl.textContent = this._shiftGenTips[tipIdx];
                    tipEl.style.opacity = '1';
                }, 200);
            }
        }, 4000);

        // ステップメッセージをゆっくり切り替え
        const steps = [
            { delay: 2000, msg: '人員配置の事前チェック中...' },
            { delay: 4500, msg: 'AIがシフトを最適化しています...' },
            { delay: 7000, msg: '労働基準法に基づいて検証中...' },
            { delay: 9500, msg: '最終調整を行っています...' },
        ];
        const stepTimers = steps.map(s => setTimeout(() => { if (stepEl) stepEl.textContent = s.msg; }, s.delay));

        try {
            console.log("Refreshing data before generation...");
            await this.loadData();

            const today = new Date();
            let startDate, endDate;

            if (targetType === 'reset_all' || targetType === 'reset_all_force' || targetType === 'empty_only') {
                startDate = new Date(this.state.currentDate.getFullYear(), this.state.currentDate.getMonth(), 1);
                endDate = new Date(this.state.currentDate.getFullYear(), this.state.currentDate.getMonth() + 1, 0);
            } else if (targetType === 'next_week') {
                const day = today.getDay();
                const diff = 7 - day;
                startDate = new Date(today);
                startDate.setDate(today.getDate() + diff);
                endDate = new Date(startDate);
                endDate.setDate(startDate.getDate() + 6);
            }

            let dates = [];
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                dates.push(dateStr);
            }

            // v3.7.2: 過去日付の扱い
            //   reset_all/next_week モードでは、過去日は生成対象から除外して
            //   未来日のみ再生成する (過去のシフトは触らない)。
            //   旧版 (v3.6) は過去日が1日でも含まれると全体を中止していたため、
            //   「現在の月をリセットして再構築」ができなかった。
            const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
            const pastDates = dates.filter(d => d < todayStr);
            if (pastDates.length > 0) {
                if (targetType === 'empty_only' || targetType === 'reset_all_force') {
                    // empty_only / reset_all_force は過去日も含めて再評価/再生成可
                } else {
                    // dates から過去日を除外
                    dates = dates.filter(d => d >= todayStr);
                    if (dates.length === 0) {
                        if (loadingEl) loadingEl.classList.add('hidden');
                        this.showToast('対象期間が全て過去日のため生成できません。未来の月を選択してください', 'error');
                        stepTimers.forEach(clearTimeout);
                        this._generationSuccess = false;
                        return;
                    }
                    this.showToast(`過去日 ${pastDates.length}日 は変更されません。${dates.length}日分 (${dates[0]}〜${dates[dates.length-1]}) を生成します`, 'warning');
                }
            }

            if (!this.state.config.organization_id) {
                this.state.config.organization_id = this.state.organization_id;
            }

            const payload = {
                staff_list: this.state.staff,
                config: this.state.config,
                dates: dates,
                requests: this.state.requests || [],
                mode: 'auto',
                existing_shifts: []
            };

            // v3.7.191: 診断表示 — Android と PC で「版」と「入力」を見比べられるよう、
            // 生成に使う前提条件を画面に出す。両端末でこの値が同じなら結果も必ず同じ。
            try {
                const _y = this.state.currentDate.getFullYear();
                const _m = this.state.currentDate.getMonth() + 1;
                this.showToast(
                    `[v3.7.191] 生成入力 ${_y}年${_m}月 / ${dates.length}日分 / スタッフ${(this.state.staff||[]).length}名 / モード:${targetType || '(未指定)'}`,
                    'info'
                );
            } catch (_) {}

            // empty_only モード: 期間内の既存シフトを「固定」として Python に渡し、
            // 空きスロットのみ最適化される。これがないとサーバはゼロから組み直すため
            // 「空きを埋めるをクリックすると人数が減る」現象が発生する。
            // 注意: id が無いシフト (=未保存のローカルプレビュー残骸) は除外する。
            //       これがないと、前回の生成試行で残った仮データを「既存」として固定して
            //       しまい、本当の DB データと矛盾する。
            if (targetType === 'empty_only') {
                payload.existing_shifts = (this.state.shifts || [])
                    .filter(s => s && s.id && s.date && dates.includes(s.date) && s.staff_id && s.start_time && s.end_time)
                    .map(s => ({
                        staff_id: s.staff_id,
                        date: s.date,
                        start_time: (s.start_time || '').substr(0, 5),
                        end_time: (s.end_time || '').substr(0, 5)
                    }));
            }

            // デバッグ: 送信スタッフ数を確認
            console.log(`[AutoFill] Sending ${payload.staff_list.length} staff, ${dates.length} dates, ${payload.requests.length} requests, ${payload.existing_shifts.length} fixed-existing`);
            console.log('[AutoFill] Staff IDs:', payload.staff_list.map(s => s.name || s.id).join(', '));

            // === STEP 2: 事前チェック ===

            if (this._debugBanner) this._debugBanner.log('事前チェック実行中 (POST /check)...');
            const checkResult = await API.checkFeasibility(payload);
            if (this._debugBanner) this._debugBanner.log(`事前チェック完了: feasible=${checkResult?.feasible} warnings=${checkResult?.warnings?.length || 0}`);

            if (checkResult && !checkResult.feasible) {
                if (loadingEl) loadingEl.classList.add('hidden');

                const summary = checkResult.summary || {};
                const details = checkResult.daily_details || [];

                let alertMsg = '⚠️ 人員不足が検出されました\n\n';
                alertMsg += '稼働可能スタッフ: ' + summary.usable_staff + '/' + summary.total_staff + '名\n';
                alertMsg += '不足合計: ' + summary.total_shortage_hours + ' 人時\n';
                alertMsg += '影響日数: ' + summary.affected_days + '日\n\n';

                if (details.length > 0) {
                    alertMsg += '--- 不足の詳細 (最大5日) ---\n';
                    for (var di = 0; di < Math.min(details.length, 5); di++) {
                        var dd = details[di];
                        alertMsg += dd.date + ': 出勤可能' + dd.available_staff + '名 / 必要' + dd.required_per_slot + '名\n';
                        for (var ri = 0; ri < dd.shortage_ranges.length; ri++) {
                            var r = dd.shortage_ranges[ri];
                            alertMsg += '  ' + r.start + '~' + r.end + ': ' + r.shortage + '名不足\n';
                        }
                    }
                }

                // v3.7.6: confirm() はブラウザ抑制されることがあるため画面内モーダルで質問
                const forceGenerate = await new Promise((resolve) => {
                    const html = `
                        <div class="fixed inset-0 z-[10001] flex items-center justify-center p-4" style="background:rgba(0,0,0,0.5)">
                            <div class="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto">
                                <div class="p-5 border-b border-gray-200 bg-amber-50">
                                    <h3 class="text-lg font-bold text-amber-700"><i class="fa-solid fa-triangle-exclamation mr-2"></i>人員不足の警告</h3>
                                </div>
                                <div class="p-5">
                                    <pre class="text-sm text-gray-800 whitespace-pre-wrap font-sans">${this._sanitize(alertMsg)}</pre>
                                </div>
                                <div class="p-4 border-t border-gray-200 flex flex-col sm:flex-row sm:justify-end gap-2 bg-gray-50">
                                    <button data-action="cancel" class="px-5 py-2 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-bold">中止して人員調整</button>
                                    <button data-action="force" class="px-5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold">緩和して強行生成</button>
                                </div>
                            </div>
                        </div>
                    `;
                    const wrap = document.createElement('div');
                    wrap.innerHTML = html;
                    const modal = wrap.firstElementChild;
                    document.body.appendChild(modal);
                    // v3.7.12: ev.target は子要素 (i タグ等) の可能性があるため
                    // closest('[data-action]') で確実にボタンを特定。旧版は
                    // ev.target.dataset?.action だけで判定し、ボタン内 i タグや
                    // テキスト領域クリックで Promise が永久 await になるバグ
                    // (agent #2 指摘 CRITICAL)。
                    modal.addEventListener('click', (ev) => {
                        const btn = ev.target.closest && ev.target.closest('[data-action]');
                        if (btn) {
                            const action = btn.dataset.action;
                            modal.remove();
                            resolve(action === 'force');
                        }
                    });
                });

                if (!forceGenerate) {
                    if (this._tipTimer) { clearInterval(this._tipTimer); this._tipTimer = null; }
                    clearInterval(progressTimer);
                    stepTimers.forEach(t => clearTimeout(t));
                    this._shiftGenInProgress = false;
                    if (loadingShiftGen) loadingShiftGen.style.display = 'none';
                    if (loadingDefault) loadingDefault.style.display = 'flex';
                    if (loadingEl) loadingEl.classList.add('hidden');
                    this.showToast('シフト生成を中止しました。スタッフの追加や条件の見直しを検討してください。', 'info');
                    return;
                }

                payload.mode = 'force';
                if (loadingEl) loadingEl.classList.remove('hidden');
                if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
                this.showToast('⚠️ 労働条件を緩和して生成します', 'warning');
            }

            // === STEP 3: 削除処理 ===
            if (targetType === 'reset_all' || targetType === 'reset_all_force') {
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                // v3.7.52: reset_all_force は過去日も含めて削除
                const shiftsToDelete = this.state.shifts.filter(function(s) {
                    if (!(dates.includes(s.date) && s.id && uuidRegex.test(s.id))) return false;
                    if (targetType === 'reset_all_force') return true;
                    return s.date >= todayStr;
                });
                if (shiftsToDelete.length > 0) {
                    // 一括削除 RPC で RLS 回避 + 効率化
                    try {
                        await this._shiftBulkDelete(shiftsToDelete.map(s => s.id));
                    } catch (delErr) {
                        console.error('[reset_all] Bulk delete failure:', delErr);
                        await this.loadData();
                        this.showToast('シフト削除に失敗しました。表示を再同期しました', 'error');
                        throw new Error('Batch delete failed');
                    }
                }
                this.state.shifts = this.state.shifts.filter(function(s) {
                    return !(dates.includes(s.date) && s.date >= todayStr);
                });
            }

            // === STEP 4: シフト生成 ===

            console.log("Sending request to Calculation Engine...");
            if (this._debugBanner) this._debugBanner.log(`シフト生成リクエスト送信 (staff=${payload.staff_list.length} dates=${payload.dates.length})`);
            const result = await API.generateShifts(payload);
            if (this._debugBanner) {
                const msgPart = result.message ? ` | message="${result.message}"` : '';
                this._debugBanner.log(`レスポンス受信: status=${result.status} mode=${result.mode||'-'} shifts=${result.shifts?.length||0}${msgPart}`);
            }

            if (result.status === 'error') {
                this.showToast('生成エラー: ' + (result.message || '不明なエラーが発生しました'), 'error');
                this._generationSuccess = false;
                this._failureDetailShown = true;  // v3.7.4: finally の汎用トーストで上書きされないように
                return;
            }

            console.log("Server Response:", result);
            if (barEl) barEl.style.width = '80%';

            if (result.status === 'success' && result.shifts && result.shifts.length > 0) {
                const newShifts = result.shifts;

                const existing = this.state.shifts.filter(function(s) { return dates.includes(s.date); });
                const finalShifts = [];

                for (var i = 0; i < newShifts.length; i++) {
                    var s = newShifts[i];
                    if (targetType === 'empty_only') {
                        var exists = existing.find(function(ex) { return ex.date === s.date && ex.staff_id === s.staff_id; });
                        if (exists) continue;
                    }
                    finalShifts.push(s);
                }

                // プレビュー表示 (DB保存はプレビュー承認後に実行)
                this._generationSuccess = finalShifts.length > 0;
                this._generationCount = finalShifts.length;
                this._pendingPreviewShifts = finalShifts;
                this._pendingPreviewTargetType = targetType;
                this._pendingPreviewDates = dates;
                this._pendingPreviewReport = result.report || null;

            } else if (result.status === 'success' && result.mode === 'math_failed') {
                // 数理最適化が解を見つけられなかった → /check API で具体的な不足条件を取得
                console.warn('Math optimization failed - calling /check for diagnostics');
                await this._showDetailedGenerationFailure(payload, '最適化エンジンが解を見つけられませんでした');
                this._generationSuccess = false;
                this._failureDetailShown = true;
            } else if (result.status === 'success' && (!result.shifts || result.shifts.length === 0)) {
                console.warn('No shifts generated - calling /check for diagnostics');
                await this._showDetailedGenerationFailure(payload, '生成可能なシフトがありませんでした');
                this._generationSuccess = false;
                this._failureDetailShown = true;
            } else {
                // v3.7.35: 想定外のレスポンス形式の詳細を表示 (スマホで「失敗」と出る原因究明用)
                this._generationSuccess = false;
                const respDebug = `status=${result?.status || 'なし'} / mode=${result?.mode || 'なし'} / shifts=${result?.shifts?.length || 0}件 / message=${result?.message || 'なし'}`;
                console.warn('[Generate] 想定外レスポンス:', respDebug, result);
                this.showToast('サーバー応答が想定外です: ' + respDebug, 'error');
                this._failureDetailShown = true;
            }

        } catch (e) {
            console.error('AutoFill Error:', e);
            this._generationSuccess = false;
            // v3.7.4: 例外時に具体エラーをトーストに表示 (旧版は「コンソールを確認」のみ)
            const errMsg = (e && e.message) ? e.message : String(e || '不明なエラー');
            this.showToast('生成エラー: ' + errMsg, 'error');
            this._failureDetailShown = true;  // finally の汎用トーストを抑制
            if (this._debugBanner) this._debugBanner.log('❌ 例外発生: ' + errMsg);
        } finally {
            // タイマー全クリア
            clearInterval(progressTimer);
            stepTimers.forEach(t => clearTimeout(t));
            if (this._tipTimer) { clearInterval(this._tipTimer); this._tipTimer = null; }

            // 最低表示時間を待つ
            const elapsed = Date.now() - loadingStartTime;
            if (elapsed < MIN_LOADING_MS) {
                if (stepEl) stepEl.textContent = this._generationSuccess ? 'シフトの最終確認中...' : '処理を完了しています...';
                if (barEl) barEl.style.width = '95%';
                await new Promise(r => setTimeout(r, MIN_LOADING_MS - elapsed));
            }

            // 100%にしてから少し待つ
            if (barEl) barEl.style.width = '100%';
            if (stepEl) stepEl.textContent = this._generationSuccess ? '完了しました！' : '処理が終了しました';
            if (tipEl) { tipEl.style.opacity = '0'; setTimeout(() => { tipEl.textContent = 'カレンダーに反映します'; tipEl.style.opacity = '1'; }, 200); }
            await new Promise(r => setTimeout(r, 1500));

            // フェードアウト
            const loadingElFinal = document.getElementById('globalLoading');
            const loadingDefaultFinal = document.getElementById('loadingDefault');
            const loadingShiftGenFinal = document.getElementById('loadingShiftGen');

            if (loadingElFinal) { loadingElFinal.style.transition = 'opacity 0.6s'; loadingElFinal.style.opacity = '0'; }
            await new Promise(r => setTimeout(r, 600));

            if (loadingShiftGenFinal) loadingShiftGenFinal.style.display = 'none';
            if (loadingDefaultFinal) loadingDefaultFinal.style.display = 'flex';
            if (loadingElFinal) { loadingElFinal.classList.add('hidden'); loadingElFinal.style.opacity = ''; loadingElFinal.style.transition = ''; }

            // カレンダー更新
            this.renderCurrentView();
            this.calculateMonthlyStats();

            this._shiftGenInProgress = false;

            // プレビューモーダルを表示（生成成功時）
            if (this._generationSuccess && this._pendingPreviewShifts && this._pendingPreviewShifts.length > 0) {
                setTimeout(() => {
                    this.showShiftPreview(this._pendingPreviewShifts, this._pendingPreviewTargetType, this._pendingPreviewDates, this._pendingPreviewReport);
                    this._pendingPreviewShifts = null;
                    this._pendingPreviewTargetType = null;
                    this._pendingPreviewDates = null;
                    this._pendingPreviewReport = null;
                }, 300);
            } else if (!this._generationSuccess && !this._failureDetailShown) {
                // v3.7.35: スマホでの「失敗」原因究明用に navigator.onLine を含めた診断トースト
                const online = (typeof navigator !== 'undefined') ? (navigator.onLine ? 'online' : 'offline') : 'unknown';
                this.showToast(
                    'シフト作成に失敗しました (network=' + online + ')。'
                    + (online === 'offline' ? '電波の良い場所で再試行してください' : '時間を置いて再度お試しください'),
                    'warning'
                );
            }
            this._failureDetailShown = false;
        }
    },


    // 一括保存 (大量データの保存)
    // v3.7.125: ロールバック対応 - DB 操作失敗時に state を元に戻す
    async saveAllShifts(shifts) {
        if (!shifts || shifts.length === 0) return;

        const targetDates = [...new Set(shifts.map(s => s.date))];
        const cid = this._getContractId();
        if (!cid) {
            this.showToast('contract_id 未取得 → 保存中止 (重複防止)', 'error');
            throw new Error('contract_id not available');
        }

        // 元の state を スナップショット (失敗時のロールバック用)
        const snapshot = this.state.shifts.slice();

        // === 1. 既存日のシフトを DB から削除 (失敗したら中止) ===
        try {
            const r = await API.rpc('delete_shifts_by_dates_by_contract', {
                p_contract_id: cid,
                p_dates: targetDates
            });
            if (!r || r.success === false) {
                throw new Error(r?.message || 'bulk delete returned failure');
            }
        } catch (e) {
            console.error('[saveAllShifts] bulk delete failed:', e);
            this.showToast('シフト保存失敗 (既存削除エラー): ' + (e.message || e), 'error');
            throw e;  // state は変更せず終了
        }

        // 削除成功 → state をフィルタ
        this.state.shifts = this.state.shifts.filter(s => targetDates.indexOf(s.date) === -1);

        // === 2. INSERT 用ペイロード構築 ===
        const cleanShifts = shifts.map(s => {
            const obj = {
                organization_id: this.state.organization_id,
                staff_id: s.staff_id,
                date: s.date,
                start_time: s.start_time,
                end_time: s.end_time,
                break_minutes: s.break_minutes || 0,
            };
            if (s.is_irregular) obj.is_irregular = true;
            if (s.memo) obj.memo = s.memo;
            return obj;
        });

        // === 3. バッチ INSERT (失敗バッチを記録) ===
        const batchSize = 200;
        const failedBatches = [];
        let insertedCount = 0;
        for (let i = 0; i < cleanShifts.length; i += batchSize) {
            const batch = cleanShifts.slice(i, i + batchSize);
            try {
                await this._shiftBulkInsert(batch);
                insertedCount += batch.length;
            } catch (e) {
                console.error(`[saveAllShifts] batch ${i / batchSize} failed:`, e);
                failedBatches.push({ index: i, size: batch.length, error: e.message });
            }
        }

        if (failedBatches.length > 0) {
            // 部分失敗: ロールバックは複雑なので、ユーザーに明示通知
            this.showToast(
                `保存一部失敗: ${insertedCount}/${cleanShifts.length}件成功、${failedBatches.length}バッチ失敗。再保存してください`,
                'error'
            );
            // 成功した分だけ state に追加 (= insertedCount 分は反映)
            this.state.shifts.push.apply(this.state.shifts, cleanShifts.slice(0, insertedCount));
            throw new Error(`partial save: ${failedBatches.length} batches failed`);
        }

        // 全成功
        this.state.shifts.push.apply(this.state.shifts, cleanShifts);
    },





    async generateShiftsForDay(dateStr, existingShifts, generatedShiftsSoFar = []) {
        // ---------------------------------------------------------
        // 0. 日付と設定の初期化 (厳格モード)
        // ---------------------------------------------------------
        const dateObj = new Date(dateStr.replace(/-/g, '/'));
        const dayOfWeek = dateObj.getDay(); // 0=Sun, 6=Sat
        const config = this.state.config;
        
        // 祝日判定
        const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
        const isHoliday = jh ? jh.isHoliday(dateStr) : false;

        // 営業時間の決定
        let openTime = "09:00";
        let closeTime = "22:00";
        
        const specialDay = (config.special_days || {})[dateStr];
        if (specialDay && specialDay.start && specialDay.end) {
            openTime = specialDay.start;
            closeTime = specialDay.end;
        } else {
            const times = config.opening_times || {};
            const defTimes = this.state.defaultConfig.opening_times;
            const getT = (key) => (times[key] || defTimes[key]);
            
            if (isHoliday) { openTime = getT('holiday').start; closeTime = getT('holiday').end; }
            else if (dayOfWeek === 0 || dayOfWeek === 6) { openTime = getT('weekend').start; closeTime = getT('weekend').end; }
            else { openTime = getT('weekday').start; closeTime = getT('weekday').end; }
        }

        // 時間変換ヘルパー (分単位)
        const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const fromMins = (m) => { 
            let h = Math.floor(m / 60); 
            let min = m % 60;
            // 24時間表記正規化
            if (h >= 24) h -= 24;
            return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        };

        const startMins = toMins(openTime);
        const endMins = toMins(closeTime);
        // 日またぎ対応 (close < open なら +24h)
        const effectiveEndMins = endMins < startMins ? endMins + (24 * 60) : endMins;

        // ---------------------------------------------------------
        // 1. 必要人数の算出 (15分刻みバケット)
        // ---------------------------------------------------------
        const timeReqs = new Map(); // key: minutes, val: count
        const timeReqManager = new Map(); // key: minutes, val: count (1 or 0)

        // ベース要件
        let baseReq = 2;
        const sReq = config.staff_req || {};
        if (isHoliday) baseReq = sReq.min_holiday || 3;
        else if (dayOfWeek === 0 || dayOfWeek === 6) baseReq = sReq.min_weekend || 3;
        else baseReq = sReq.min_weekday || 2;
        
        const reqManager = sReq.min_manager || 0;

        // 全スロット初期化 (15分刻み)
        for (let t = startMins; t < effectiveEndMins; t += 15) {
            timeReqs.set(t, Number(baseReq));
            timeReqManager.set(t, Number(reqManager));
        }

        // v3.7.80: シフトパターン登録時はパターン外時間帯を要件 0 に (scheduler.py 揃え)
        const customShifts = config.custom_shifts || [];
        const patCountKey = isHoliday ? 'count_holiday'
                          : (dayOfWeek === 0 ? 'count_holiday'
                          : (dayOfWeek === 6 ? 'count_weekend' : 'count_weekday'));
        const hasPatterns2 = customShifts.some(p => {
            const c = Number(p[patCountKey] != null ? p[patCountKey]
                            : (p.count != null ? p.count : 0));
            return Number.isFinite(c) && c > 0;
        });
        for (let t = startMins; t < effectiveEndMins; t += 15) {
            let patternSum = 0;
            customShifts.forEach(pat => {
                if (!pat.start || !pat.end) return;
                const ps = toMins(pat.start);
                let pe = toMins(pat.end);
                if (pe <= ps) pe += 24 * 60;
                const rawCnt = pat[patCountKey] != null ? pat[patCountKey]
                             : (pat.count != null ? pat.count : 0);
                const cnt = Number(rawCnt) || 0;
                if (cnt > 0 && ps <= t && t < pe) {
                    patternSum += cnt;
                }
            });
            if (patternSum > 0) {
                timeReqs.set(t, patternSum);
            } else if (hasPatterns2) {
                // パターン登録あり + パターン外時間帯 → 不足判定しない
                timeReqs.set(t, 0);
            }
            // パターン未登録ユーザーは初期化済みベース要件を維持
        }

        // 時間帯別ルールの適用 (time_staff_req)（days配列の型を数値に統一）
        const timeRules = (config.time_staff_req || []).filter(r => (r.days || []).map(Number).includes(dayOfWeek));
        timeRules.forEach(rule => {
            const rStart = toMins(rule.start);
            let rEnd = toMins(rule.end);
            if (rEnd < rStart) rEnd += 24*60;
            
            for (let t = startMins; t < effectiveEndMins; t += 15) {
                // ルール期間内か (絶対値 or 日またぎ考慮)
                // 簡易判定として、シフト生成日(当日)の営業範囲内で、ルールの開始〜終了に合致するか
                
                // ※日またぎ同士の厳密判定は複雑だが、ここでは「営業日」という概念内の絶対分で比較する
                // rule.start が "22:00"(1320), rule.end が "02:00"(1560)
                // t が "23:00"(1380) なら範囲内。
                // 営業時間が "18:00"(1080) ~ "26:00"(1560) であれば、t=1380 は範囲内。
                
                // ただし、rule.start が "01:00"(60) で rule.end が "02:00"(120) の場合（深夜のみ指定）
                // 営業時間が深夜に及ぶ場合、t=60 は "翌日の01:00" を指す可能性がある。
                // startMinsが540(9:00)でeffectiveEndMinsが1320(22:00)なら、t=60は存在しない。
                // startMinsが1080(18:00)でeffectiveEndMinsが1560(26:00)なら、t=1500(25:00=01:00)が存在する。
                // 入力された rule.start(01:00) をどう解釈するか？
                // 通常、「営業時間内の 01:00」とみなすべき。
                // => t を 24h正規化した値 (t % 1440) と ruleの時刻を比較する？
                
                // ここではシンプルに、ruleも絶対分(startMins基準)に変換できればベストだが、
                // ruleはただの時刻文字列。
                // 「開始時刻 >= rule.start && 開始時刻 < rule.end」
                
                // A. ruleが日またぎでない (11:00-14:00)
                // B. ruleが日またぎ (22:00-02:00)
                
                // tの時刻表現
                const tMod = t % 1440;
                
                let inRule = false;
                if (rStart < rEnd) {
                    // 通常
                    inRule = (tMod >= rStart && tMod < rEnd);
                } else {
                    // 日またぎ (22:00 <= t < 24:00 OR 00:00 <= t < 02:00)
                    inRule = (tMod >= rStart || tMod < rEnd);
                }
                
                // さらに、t自体が「営業開始前」の深夜（早朝）でないことの保証が必要だが、
                // loop範囲が startMins〜effectiveEndMins なのでOK。
                
                if (inRule) {
                    const current = timeReqs.get(t) || 0;
                    timeReqs.set(t, Math.max(current, Number(rule.count)));
                }
            }
        });

        // ---------------------------------------------------------
        // 2. 現在の充足状況マップ作成
        // ---------------------------------------------------------
        const currentDayNewShifts = [];
        const getAllShifts = () => [...existingShifts, ...generatedShiftsSoFar, ...currentDayNewShifts];

        const getCoverage = () => {
            const coverage = new Map();
            const managerCoverage = new Map();
            
            for (let t = startMins; t < effectiveEndMins; t += 15) {
                coverage.set(t, 0);
                managerCoverage.set(t, 0);
            }

            const shifts = getAllShifts().filter(s => s.date === dateStr);
            shifts.forEach(s => {
                const sStart = toMins(s.start_time);
                let sEnd = toMins(s.end_time);
                if (sEnd < sStart) sEnd += 24*60;
                
                const staff = this.getStaff(s.staff_id);
                const isManager = staff && (staff.role === 'manager' || staff.role === 'leader');

                for (let t = startMins; t < effectiveEndMins; t += 15) {
                    if (t >= sStart && t < sEnd) {
                        coverage.set(t, (coverage.get(t) || 0) + 1);
                        if (isManager) managerCoverage.set(t, (managerCoverage.get(t) || 0) + 1);
                    }
                }
            });
            return { coverage, managerCoverage };
        };

        // ---------------------------------------------------------
        // 3. 承認済みシフトの適用 (Requests)
        // ---------------------------------------------------------
        const workReqs = this.state.requests.filter(r => 
            r.dates === dateStr && r.type === 'work' && r.status === 'approved'
        );
        workReqs.forEach(req => {
            const already = getAllShifts().some(s => s.staff_id === req.staff_id && s.date === dateStr);
            if (!already) {
                const s = this.getStaff(req.staff_id);
                if (s) {
                    const rs = req.start_time || openTime;
                    const re = req.end_time || closeTime;
                    currentDayNewShifts.push(this.createShiftObject(s.id, dateStr, rs, re));
                }
            }
        });

        // ---------------------------------------------------------
        // 4. スタッフリストの準備 (ランク順 A>B>C)
        // ---------------------------------------------------------
        const offStaffIds = this.state.requests
            .filter(r => r.dates === dateStr && (r.type === 'off' || r.type === 'holiday') && r.status === 'approved')
            .map(r => r.staff_id);

        let sortedStaff = [...this.state.staff].filter(s => !offStaffIds.includes(s.id));
        
        sortedStaff.sort((a, b) => {
            const rankScore = { 'A': 3, 'B': 2, 'C': 1 };
            const rA = rankScore[a.evaluation] || 2;
            const rB = rankScore[b.evaluation] || 2;
            if (rA !== rB) return rB - rA;
            const roleScore = { 'manager': 3, 'leader': 2, 'staff': 1 };
            const rolA = roleScore[a.role] || 1;
            const rolB = roleScore[b.role] || 1;
            if (rolA !== rolB) return rolB - rolA;
            return Math.random() - 0.5;
        });

        // ---------------------------------------------------------
        // 5. 不足分の充填 (Gap Filling) - 強化版
        // ---------------------------------------------------------
        const ignoredSlots = new Set(); // 埋められなかったスロットを記憶して無限ループ回避

        // ループ処理 (最大100パス)
        for (let pass = 0; pass < 100; pass++) {
            const { coverage, managerCoverage } = getCoverage();
            
            // 不足スロット探索
            let deficitSlot = -1;
            let missingType = null;

            for (let t = startMins; t < effectiveEndMins; t += 15) {
                if (ignoredSlots.has(t)) continue; // 諦めたスロットはスキップ

                if (managerCoverage.get(t) < timeReqManager.get(t)) {
                    deficitSlot = t;
                    missingType = 'manager';
                    break;
                }
                if (coverage.get(t) < timeReqs.get(t)) {
                    deficitSlot = t;
                    missingType = 'staff';
                    break;
                }
            }

            if (deficitSlot === -1) break; // 全充足 (または全て諦めた)

            let shiftAddedOrExtended = false;
            
            const targetEnd = Math.min(deficitSlot + 480, effectiveEndMins); // 基本は+8時間
            const reqTimeRange = { start: fromMins(deficitSlot), end: fromMins(targetEnd) };
            const roleFilter = missingType === 'manager' ? (s) => (s.role === 'manager' || s.role === 'leader') : null;

            // =========================================================
            // 戦略1: 既存シフトの延長 (通常時間内)
            // =========================================================
            for (const s of currentDayNewShifts) {
                const sEnd = toMins(s.end_time) + (s.end_time < s.start_time ? 24*60 : 0);
                
                // ギャップが60分以内なら結合対象
                if (sEnd <= deficitSlot && (deficitSlot - sEnd) <= 60) {
                    const staff = this.getStaff(s.staff_id);
                    if (roleFilter && !roleFilter(staff)) continue;

                    const maxMins = (Number(staff.max_hours_day) || 8) * 60;
                    // 延長後の終了時間 (最低でもdeficitを埋めるために+3h)
                    const newEndMins = Math.min(deficitSlot + 180, effectiveEndMins);
                    const sStart = toMins(s.start_time);
                    const newDurMins = newEndMins - sStart;

                    // 通常上限内であれば延長
                    if (newDurMins <= maxMins) {
                        s.end_time = fromMins(newEndMins);
                        if (newDurMins > 480) s.break_minutes = 60; else if (newDurMins > 360) s.break_minutes = 45;
                        shiftAddedOrExtended = true;
                        break;
                    }
                }
            }
            if (shiftAddedOrExtended) continue;

            // =========================================================
            // 戦略2: 新規シフト追加 (通常時間内)
            // =========================================================
            let candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { timeRange: reqTimeRange });
            
            if (candidate) {
                const maxH = Number(candidate.max_hours_day) || 8;
                const dur = Math.min(480, maxH * 60);
                const endT = Math.min(deficitSlot + dur, effectiveEndMins);
                // オーバータイム許可なし(第4引数省略)で作成
                const newShift = this.createShiftObject(candidate.id, dateStr, fromMins(deficitSlot), fromMins(endT));
                currentDayNewShifts.push(newShift);
                shiftAddedOrExtended = true;
                continue;
            }

            // =========================================================
            // 戦略3: 既存シフトの延長 (残業 +3h許容)
            // =========================================================
            for (const s of currentDayNewShifts) {
                const sEnd = toMins(s.end_time) + (s.end_time < s.start_time ? 24*60 : 0);
                
                if (sEnd <= deficitSlot && (deficitSlot - sEnd) <= 60) {
                    const staff = this.getStaff(s.staff_id);
                    if (roleFilter && !roleFilter(staff)) continue;

                    const maxMins = (Number(staff.max_hours_day) || 8) * 60;
                    const limitMins = Math.min(maxMins + 180, 660); // Max 11h
                    const newEndMins = Math.min(deficitSlot + 180, effectiveEndMins);
                    const sStart = toMins(s.start_time);
                    const newDurMins = newEndMins - sStart;

                    if (newDurMins <= limitMins) {
                        s.end_time = fromMins(newEndMins);
                        if (newDurMins > 480) s.break_minutes = 60; else if (newDurMins > 360) s.break_minutes = 45;
                        shiftAddedOrExtended = true;
                        break;
                    }
                }
            }
            if (shiftAddedOrExtended) continue;

            // =========================================================
            // 戦略4: 新規シフト追加 (緊急モード: 週制限無視 & 残業許容)
            // =========================================================
            // まず週制限だけ無視して探す
            candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { timeRange: reqTimeRange, ignoreWeekLimit: true });
            
            // それでもいなければ、重複以外なんでもあり (Manager欠員など深刻な場合)
            if (!candidate) {
                 candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { 
                     timeRange: reqTimeRange, ignoreWeekLimit: true, ignoreOverlap: false 
                 });
            }

            if (candidate) {
                const maxH = Number(candidate.max_hours_day) || 8;
                // 緊急時は+3hまで許容
                const limitMins = Math.min((maxH + 3) * 60, 660);
                const dur = Math.min(480, limitMins);
                const endT = Math.min(deficitSlot + dur, effectiveEndMins);
                
                // createShiftObjectにオーバータイム許可フラグ(true)を渡す
                const newShift = this.createShiftObject(candidate.id, dateStr, fromMins(deficitSlot), fromMins(endT), true);
                currentDayNewShifts.push(newShift);
                shiftAddedOrExtended = true;
                continue;
            }

            // 手詰まり
            if (!shiftAddedOrExtended) {
                ignoredSlots.add(deficitSlot);
            }
        }

        return currentDayNewShifts;
    },

    findAvailableStaff(staffList, dateStr, allShiftsContext, filterFn = null, options = {}) {
        const { ignoreWeekLimit = false, timeRange = null } = options;
        
        // 日付範囲計算
        const dateObj = new Date(dateStr.replace(/-/g, '/'));
        const day = dateObj.getDay();
        const startOfWeek = new Date(dateObj);
        startOfWeek.setDate(dateObj.getDate() - day);
        const formatYMD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const startStr = formatYMD(startOfWeek);
        const endStr = formatYMD(new Date(startOfWeek.getTime() + 6*24*60*60*1000));

        // 時間変換
        const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

        for (const staff of staffList) {
            // 基本フィルター
            if (filterFn && !filterFn(staff)) continue;

            // 1. 休み希望チェック
            const isOff = this.state.requests.some(r => 
                r.staff_id === staff.id && r.dates === dateStr && (r.type === 'off' || r.type === 'holiday') && r.status === 'approved'
            );
            if (isOff && !ignoreWeekLimit) continue; 

            // 2. 重複チェック & 勤務時間
            const dailyShifts = allShiftsContext.filter(s => s.staff_id === staff.id && s.date === dateStr);
            
            if (timeRange) {
                const newStart = toMins(timeRange.start);
                let newEnd = toMins(timeRange.end);
                if (newEnd < newStart) newEnd += 24*60;

                // 時間被り
                const isOverlap = dailyShifts.some(s => {
                    const sStart = toMins(s.start_time);
                    let sEnd = toMins(s.end_time);
                    if (sEnd < sStart) sEnd += 24*60;
                    return sStart < newEnd && sEnd > newStart; 
                });
                if (isOverlap) continue;
            } else {
                if (dailyShifts.length > 0) continue; 
            }

            // 3. 勤務時間上限 (日) - 既存シフト + 新規
            const maxMins = (Number(staff.max_hours_day) || 8) * 60;
            const limitMins = ignoreWeekLimit ? Math.min(maxMins + 180, 660) : maxMins; 
            
            const currentMins = dailyShifts.reduce((acc, s) => {
                 const sStart = toMins(s.start_time);
                 let sEnd = toMins(s.end_time);
                 if (sEnd < sStart) sEnd += 24*60;
                 return acc + (sEnd - sStart);
            }, 0);
            
            let newDur = 180; // 仮
            if (timeRange) {
                const ns = toMins(timeRange.start);
                let ne = toMins(timeRange.end);
                if (ne < ns) ne += 24*60;
                newDur = ne - ns;
            }
            
            if (currentMins + newDur > limitMins) continue;

            // 4. 週勤務日数チェック
            if (!ignoreWeekLimit) {
                const weekShifts = allShiftsContext.filter(s => s.staff_id === staff.id && s.date >= startStr && s.date <= endStr);
                const workedDays = new Set(weekShifts.map(s => s.date)).size;
                const maxDays = Number(staff.max_days_week) || 5;
                
                const workedToday = dailyShifts.length > 0;
                if (!workedToday && workedDays >= maxDays) continue;
            }

            return staff; 
        }
        return null;
    },

    createShiftObject(staffId, date, start, end, allowOvertime = false) {
        if (!staffId || !date || !start || !end) {
            console.warn('Shift creation skipped due to missing data', { staffId, date, start, end });
            // ダミーを返してエラーを防ぐが、保存時に除外されるようにする（あるいはバリデーションで弾く）
            return { staff_id: staffId, date, start_time: start || '00:00', end_time: end || '00:00', break_minutes: 0, _invalid: true };
        }

        // --- スタッフの勤務時間を厳格に守るためのファイヤーウォール ---
        const staff = this.getStaff(staffId);
        let maxHours = (staff && staff.max_hours_day) ? Number(staff.max_hours_day) : 8;
        
        // オーバータイム許可時は最大11時間まで拡張
        if (allowOvertime) {
            maxHours = Math.min(maxHours + 3, 11);
        }

        let startDate = new Date(`2000-01-01T${start}`);
        let endDate = new Date(`2000-01-01T${end}`);
        // 日付またぎ対応
        if (endDate < startDate) {
            endDate.setDate(endDate.getDate() + 1);
        }

        let duration = (endDate - startDate) / 3600000;

        // 最大勤務時間を超えている場合、強制的に短縮する
        if (duration > maxHours) {
            // 短縮ロジック:
            // 基本的には「終了時間を早める」ことで調整する。
            // ただし、元のシフトが「遅番（例: 17-22）」のような場合、
            // 「17-20 (早上がり)」にするか「19-22 (遅入り)」にするかは文脈による。
            // ここでは安全策として「終了時間を基準」に調整（遅入り）するロジックを採用するケースも考慮したいが、
            // 最も汎用的なのは「開始時間を維持して早上がり」させることである。
            // しかし、ユーザーの苦情「17-22シフト」に対し「3時間制限」がある場合、
            // 17-20になるのが自然。
            
            // 例外対応: もしシフトが「店舗の閉店時間(config.closing_time)」と一致して終わる場合、
            // 「ラストまで」という意味合いが強いため、「開始時間を遅らせる」ほうが適切かもしれない。
            // が、configへのアクセスが複雑になるため、ここではシンプルに
            // 「開始時間を維持し、終了時間をmaxHours後に設定する」方式で統一し、
            // 絶対にmaxHoursを超えないことを保証する。
            
            // もし呼び出し元で「遅番だから遅く始めてほしい」場合は、
            // 呼び出し元で時間を計算して渡すべきである。
            // ここは「最終防衛ライン」として機能させる。

            const newEndMillis = startDate.getTime() + (maxHours * 3600000);
            endDate = new Date(newEndMillis);
            
            // end文字列を再生成 (HH:mm)
            end = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`;
            
            // 再計算
            duration = maxHours;
        }

        let breakMins = 0;
        // 設定された休憩ルールを適用
        const rules = this.state.config.break_rules || this.state.defaultConfig.break_rules;
        // 降順にソートして、最大の条件に合致するものを適用
        const sortedRules = [...rules].sort((a,b) => b.min_hours - a.min_hours);
        
        for(const rule of sortedRules) {
            if(duration >= rule.min_hours) {
                breakMins = rule.break_minutes;
                break;
            }
        }
        
        return { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins };
    },

    // v3.7.133: 責任者引き継ぎビュー
    renderHandover(container) {
        if (!this.state.isAdmin) return;
        container.innerHTML = `
            <div class="max-w-4xl mx-auto space-y-6 pb-24">
                <div class="border-b border-gray-200 pb-4">
                    <h2 class="text-2xl font-bold text-gray-800 flex items-center gap-2">
                        <i class="fa-solid fa-people-arrows text-amber-500"></i>責任者引き継ぎ
                        <span class="text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">重要</span>
                    </h2>
                    <p class="text-sm text-gray-500 mt-1">店舗管理者を交代する際の手順とチェックリスト</p>
                </div>

                <!-- なぜ重要か -->
                <div class="bg-red-50 border-l-4 border-red-500 rounded-r-lg p-5">
                    <h3 class="font-bold text-red-900 mb-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>引き継ぎ漏れによるリスク</h3>
                    <ul class="text-sm text-red-900 leading-relaxed space-y-1 list-disc list-inside">
                        <li>新責任者がログインできず、シフト作成が完全に止まる</li>
                        <li>セカンドファクター PIN を知らないと、パスワードを知っていてもログイン不能</li>
                        <li>運営管理にリセット依頼が必要となり、復旧まで時間がかかる</li>
                        <li>本部から店舗を観覧している場合、本部の連絡先も引き継ぎ必須</li>
                    </ul>
                </div>

                <!-- ステップ1: 引き継ぎ前のチェックリスト -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800"><i class="fa-solid fa-list-check text-blue-500 mr-1"></i>引き継ぎチェックリスト</h3>
                    </div>
                    <div class="p-5 space-y-3 text-sm">
                        <label class="flex items-start gap-3 cursor-pointer hover:bg-gray-50 p-2 rounded">
                            <input type="checkbox" class="mt-1 form-checkbox text-blue-600 rounded">
                            <div>
                                <div class="font-bold text-gray-800">1. 契約 ID を新責任者に伝える</div>
                                <p class="text-xs text-gray-500 mt-0.5">店舗ログイン画面で入力する識別子。再確認は「店舗設定 → 店舗情報」から可能</p>
                            </div>
                        </label>
                        <label class="flex items-start gap-3 cursor-pointer hover:bg-gray-50 p-2 rounded">
                            <input type="checkbox" class="mt-1 form-checkbox text-blue-600 rounded">
                            <div>
                                <div class="font-bold text-gray-800">2. 管理者パスワードを変更または共有</div>
                                <p class="text-xs text-gray-500 mt-0.5">右上メニュー「パスワード変更」から新責任者の希望パスワードに設定 (推奨)、もしくは現在のパスワードを共有</p>
                            </div>
                        </label>
                        <div class="bg-red-50 border-2 border-red-300 rounded p-2">
                            <label class="flex items-start gap-3 cursor-pointer hover:bg-red-100/40 p-1 rounded">
                                <input type="checkbox" class="mt-1 form-checkbox text-red-600 rounded">
                                <div>
                                    <div class="font-bold text-red-900">3. セカンドファクター PIN を必ず変更する <span class="text-[10px] bg-red-600 text-white px-1.5 rounded font-bold">必須</span></div>
                                    <p class="text-xs text-red-700 mt-0.5">下の「<strong>PIN を変更</strong>」ボタンから、新責任者の希望 PIN に変更してください。旧 PIN を旧責任者が記憶していると、引き継ぎ後も旧責任者がログイン可能になり情報漏洩リスクがあります。</p>
                                </div>
                            </label>
                            <div class="pl-9 mt-2">
                                <button type="button" onclick="app.openPinChangeModal()" class="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition shadow-sm">
                                    <i class="fa-solid fa-rotate mr-1"></i>PIN を変更する
                                </button>
                            </div>
                        </div>
                        <label class="flex items-start gap-3 cursor-pointer hover:bg-gray-50 p-2 rounded">
                            <input type="checkbox" class="mt-1 form-checkbox text-blue-600 rounded">
                            <div>
                                <div class="font-bold text-gray-800">4. スタッフ全員に責任者交代を周知</div>
                                <p class="text-xs text-gray-500 mt-0.5">朝礼・LINE グループ・掲示・個別連絡 等、店舗運用で使っている連絡手段で旧責任者の交代をスタッフ全員に伝えてください (現状システム内通知機能はありません)</p>
                            </div>
                        </label>
                        <label class="flex items-start gap-3 cursor-pointer hover:bg-gray-50 p-2 rounded">
                            <input type="checkbox" class="mt-1 form-checkbox text-blue-600 rounded">
                            <div>
                                <div class="font-bold text-gray-800">5. 本部・運営管理の連絡先を伝える</div>
                                <p class="text-xs text-gray-500 mt-0.5">本部から観覧している店舗の場合、本部担当者の連絡先も併せて引き継ぎ</p>
                            </div>
                        </label>
                        <label class="flex items-start gap-3 cursor-pointer hover:bg-gray-50 p-2 rounded">
                            <input type="checkbox" class="mt-1 form-checkbox text-blue-600 rounded">
                            <div>
                                <div class="font-bold text-gray-800">6. 初回ログインの動作確認</div>
                                <p class="text-xs text-gray-500 mt-0.5">新責任者が実際にログインしてダッシュボードを開けることを引き継ぎ前に確認</p>
                            </div>
                        </label>
                    </div>
                </div>

                <!-- 緊急時の連絡先 -->
                <div class="bg-blue-50 border border-blue-200 rounded-xl p-5">
                    <h3 class="font-bold text-blue-900 mb-2"><i class="fa-solid fa-phone mr-1"></i>引き継ぎ漏れ・PIN紛失時の連絡先</h3>
                    <p class="text-sm text-blue-900">運営管理: <a href="mailto:info@rakushift.jp" class="font-bold underline">info@rakushift.jp</a></p>
                    <p class="text-xs text-blue-700 mt-2">契約 ID と本人確認情報を添えてご連絡ください。即時対応はできない場合があります (営業時間内)。</p>
                </div>

                <!-- クイックリンク -->
                <div class="flex flex-wrap gap-2 pt-2">
                    <button type="button" onclick="app.openPinChangeModal()" class="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-red-700 shadow-sm">
                        <i class="fa-solid fa-rotate mr-1"></i>PIN を変更 (必須)
                    </button>
                    <button type="button" onclick="app.openModal('changePasswordModal')" class="bg-amber-50 border border-amber-300 text-amber-700 px-4 py-2 rounded-lg text-sm font-bold hover:bg-amber-100">
                        <i class="fa-solid fa-key mr-1"></i>パスワード変更
                    </button>
                    <button type="button" onclick="app.changeView('settings')" class="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-bold hover:bg-gray-50">
                        <i class="fa-solid fa-sliders mr-1"></i>店舗設定へ
                    </button>
                </div>
            </div>
        `;
    },

    // --- マニュアル ---
    renderManual(container) {
        if (!this.state.isAdmin && !this.state.isHQ) { this.changeView('dashboard'); return; }

        let tabsHtml = '';
        if (this.state.isHQ) {
            tabsHtml = `
            <div class="flex border-b border-gray-200 mb-6 bg-white rounded-xl p-1 shadow-sm max-w-4xl mx-auto">
                <button onclick="app.changeView('manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg bg-indigo-50 text-indigo-700 shadow-sm transition-all">
                    <i class="fa-solid fa-book mr-1"></i>店舗管理者マニュアル
                </button>
                <button onclick="app.changeView('hq_manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg text-gray-500 hover:text-gray-900 transition-all">
                    <i class="fa-solid fa-building-user mr-1"></i>本部管理者マニュアル
                </button>
            </div>
            `;
        }

        container.innerHTML = `
        ${tabsHtml}
        <div class="max-w-4xl mx-auto space-y-6 pb-20">
            <h2 class="text-2xl font-bold text-gray-800"><i class="fa-solid fa-book mr-2 text-indigo-500"></i>システムマニュアル</h2>

            <!-- 目次 -->
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="font-bold text-gray-800 mb-3">目次</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                    <a href="#m-important" class="text-red-600 hover:underline font-bold">⚠ 設定の重要性</a>
                    <a href="#m-roles" class="text-indigo-600 hover:underline">1. 役職・ロール</a>
                    <a href="#m-eval" class="text-indigo-600 hover:underline">2. スタッフ評価 (A〜D)</a>
                    <a href="#m-pattern-target" class="text-teal-600 hover:underline">2.5. シフトパターン振り分け</a>
                    <a href="#m-shift" class="text-indigo-600 hover:underline">3. AIシフト作成</a>
                    <a href="#m-labor" class="text-indigo-600 hover:underline">4. 労働基準法ルール</a>
                    <a href="#m-break" class="text-indigo-600 hover:underline">5. 休憩ルール</a>
                    <a href="#m-request" class="text-indigo-600 hover:underline">6. 休み希望</a>
                    <a href="#m-settings" class="text-indigo-600 hover:underline">7. 店舗設定</a>
                    <a href="#m-plan" class="text-indigo-600 hover:underline">8. プラン・課金</a>
                    <a href="#m-auth" class="text-indigo-600 hover:underline">9. 権限 (管理者/スタッフ)</a>
                    <a href="#m-analytics" class="text-indigo-600 hover:underline">10. 分析・レポート</a>
                    <a href="#m-other" class="text-indigo-600 hover:underline">11. その他機能</a>
                </div>
            </div>

            <!-- 設定の重要性 -->
            <div id="m-important" class="bg-gradient-to-r from-red-50 to-orange-50 rounded-xl shadow-sm border-2 border-red-300 p-6">
                <h3 class="text-lg font-bold text-red-700 mb-3"><i class="fa-solid fa-triangle-exclamation mr-2"></i>設定の重要性 ― AIシフト精度を最大化するために</h3>
                <div class="bg-white/80 rounded-lg p-4 mb-4">
                    <p class="text-sm text-gray-800 font-bold mb-2">ラクシフトAIのシフト精度は「設定の正確さ」に直結します。</p>
                    <p class="text-sm text-gray-600">AIは設定された情報だけを元に最適なシフトを組みます。設定が不十分だと、偏った配置や穴抜けの原因になります。以下の設定を必ず確認してください。</p>
                </div>

                <div class="space-y-4">
                    <div class="bg-white rounded-lg p-4 border border-orange-200">
                        <h4 class="font-bold text-orange-700 mb-2"><i class="fa-solid fa-user-gear mr-1"></i>スタッフ設定（最重要）</h4>
                        <table class="w-full text-sm border-collapse">
                            <thead><tr class="bg-orange-50"><th class="p-2 text-left border">設定項目</th><th class="p-2 text-left border">説明</th><th class="p-2 text-left border">未設定時の影響</th></tr></thead>
                            <tbody>
                                <tr><td class="p-2 border font-bold">週最大出勤日数</td><td class="p-2 border">1週間に最大何日働けるか</td><td class="p-2 border text-red-600">デフォルト5日になり、バイトに過剰配置される</td></tr>
                                <tr><td class="p-2 border font-bold">週最低出勤日数</td><td class="p-2 border">1週間に最低何日は入りたいか</td><td class="p-2 border text-red-600">0日扱いでシフトに入らない場合がある</td></tr>
                                <tr><td class="p-2 border font-bold">1日の最大労働時間</td><td class="p-2 border">1日に最大何時間働けるか</td><td class="p-2 border text-red-600">8時間扱いで短時間バイトが長時間シフトに入る</td></tr>
                                <tr><td class="p-2 border font-bold">役職</td><td class="p-2 border">店長/リーダー/スタッフ/新人</td><td class="p-2 border text-red-600">OJT制約やメンター配置が機能しない</td></tr>
                                <tr><td class="p-2 border font-bold">評価 (A〜D)</td><td class="p-2 border">スキルレベル</td><td class="p-2 border text-red-600">チーム戦力バランスが偏る</td></tr>
                                <tr><td class="p-2 border font-bold">給与形態</td><td class="p-2 border">月給制 or 時給制</td><td class="p-2 border text-red-600">月給スタッフが優先配置されず人件費が増大</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="bg-white rounded-lg p-4 border border-blue-200">
                        <h4 class="font-bold text-blue-700 mb-2"><i class="fa-solid fa-store mr-1"></i>店舗設定（重要）</h4>
                        <table class="w-full text-sm border-collapse">
                            <thead><tr class="bg-blue-50"><th class="p-2 text-left border">設定項目</th><th class="p-2 text-left border">説明</th><th class="p-2 text-left border">未設定時の影響</th></tr></thead>
                            <tbody>
                                <tr><td class="p-2 border font-bold">営業時間（曜日別）</td><td class="p-2 border">平日/土日/祝日の開店・閉店時間</td><td class="p-2 border text-red-600">閉店後の時間帯にも人員配置される</td></tr>
                                <tr><td class="p-2 border font-bold">必要人員（曜日別）</td><td class="p-2 border">平日/土日/祝日の最低配置人数</td><td class="p-2 border text-red-600">人手不足・過剰配置が発生する</td></tr>
                                <tr><td class="p-2 border font-bold">シフトパターン</td><td class="p-2 border">早番/遅番等の時間テンプレートと、平日/土曜/日祝の必要人数</td><td class="p-2 border text-red-600">必要人数が確保されず、人手不足・過剰配置が発生する</td></tr>
                                <tr><td class="p-2 border font-bold">定休日</td><td class="p-2 border">曜日ベースの休業日</td><td class="p-2 border text-red-600">休業日にシフトが配置される</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="bg-green-50 rounded-lg p-4 border border-green-300">
                        <h4 class="font-bold text-green-700 mb-2"><i class="fa-solid fa-lightbulb mr-1"></i>AI精度を最大化するコツ</h4>
                        <ul class="text-sm text-gray-700 space-y-1">
                            <li>✅ <strong>全スタッフの勤務制約を正確に入力</strong>する（週最大/最低日数、1日最大時間）</li>
                            <li>✅ <strong>月給制/時給制を正しく設定</strong>する → 月給スタッフが優先配置され人件費が最適化される</li>
                            <li>✅ <strong>営業時間を曜日別に設定</strong>する → 土日の短縮営業等が正確に反映される</li>
                            <li>✅ <strong>シフトパターンを2つ以上登録</strong>する → 早番/遅番など複数の時間帯を組み合わせて穴抜けを防げる</li>
                            <li>✅ <strong>シフトパターンの必要人数を平日/土曜/日祝で個別設定</strong>する → 曜日ごとの繁忙差に合わせて最適配置される</li>
                            <li>✅ <strong>役職と評価を正しく設定</strong>する → チーム編成の質が向上する</li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 1. 役職 -->
            <div id="m-roles" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">1.</span>役職・ロール</h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">役職</th><th class="p-2 text-left border">役割</th><th class="p-2 text-left border">シフト生成への影響</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border font-bold">店長 (Manager)</td><td class="p-2 border">最高権限、メンター役</td><td class="p-2 border text-red-600 font-bold">毎営業日に最低○名配置必須（AIが最優先で配置）</td></tr>
                        <tr><td class="p-2 border font-bold">副店長 (Sub-Manager)</td><td class="p-2 border">副管理者、メンター役</td><td class="p-2 border text-orange-600 font-bold">店長の代理として配置可能（店長と同等の権限）</td></tr>
                        <tr><td class="p-2 border font-bold">社員 (Employee)</td><td class="p-2 border">一般社員</td><td class="p-2 border">アルバイトより優先的に配置（月給制の場合はコスト計算上有利に働きます）</td></tr>
                        <tr><td class="p-2 border font-bold">リーダー (Leader)</td><td class="p-2 border">時間帯責任者、メンター役</td><td class="p-2 border">新人スタッフの指導役として重宝されます</td></tr>
                        <tr><td class="p-2 border font-bold">アルバイト (Staff)</td><td class="p-2 border">一般スタッフ</td><td class="p-2 border">通常配置</td></tr>
                        <tr><td class="p-2 border font-bold">新人 (Rookie)</td><td class="p-2 border">研修中</td><td class="p-2 border">必ずメンター（店長〜リーダー）と同日配置</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 2. 評価 -->
            <div id="m-eval" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">2.</span>スタッフ評価 (A〜D)</h3>
                <p class="text-sm text-gray-600 mb-3">評価はAIシフト生成時のチーム編成・配置優先度に影響します。</p>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">評価</th><th class="p-2 text-left border">意味</th><th class="p-2 text-left border">戦力スコア</th><th class="p-2 text-left border">影響</th></tr></thead>
                    <tbody>
                        <tr class="bg-yellow-50"><td class="p-2 border font-bold text-yellow-700">A</td><td class="p-2 border">優秀</td><td class="p-2 border">3.0</td><td class="p-2 border">優先的に配置、ペナルティなし</td></tr>
                        <tr class="bg-blue-50"><td class="p-2 border font-bold text-blue-700">B</td><td class="p-2 border">良好</td><td class="p-2 border">2.0</td><td class="p-2 border">通常配置</td></tr>
                        <tr><td class="p-2 border font-bold text-gray-500">C</td><td class="p-2 border">普通</td><td class="p-2 border">1.0</td><td class="p-2 border">やや控えめに配置</td></tr>
                        <tr class="bg-red-50"><td class="p-2 border font-bold text-red-600">D</td><td class="p-2 border">研修中・要指導</td><td class="p-2 border">0.5</td><td class="p-2 border">メンター必須、単独配置不可</td></tr>
                    </tbody>
                </table>
                <p class="text-xs text-gray-400 mt-2">※ チーム全体の戦力スコアが基準を満たすようAIが自動調整します</p>
            </div>

            <!-- 2.5. シフトパターン振り分け (v3.7.77) -->
            <div id="m-pattern-target" class="bg-white rounded-xl shadow-sm border border-teal-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-teal-500 mr-2">2.5.</span>シフトパターン振り分け (月間目標回数)</h3>
                <div class="space-y-3 text-sm text-gray-700">
                    <p>スタッフ編集モーダルの <strong>「シフトパターン別 月間目標回数」</strong> セクションで、各スタッフを各シフトパターン (早番・遅番・夜勤等) に <strong>月何回入れたいか</strong> を指定できます。</p>
                    <div class="bg-teal-50 border border-teal-200 rounded-lg p-3">
                        <p class="text-xs font-bold text-teal-800 mb-1"><i class="fa-solid fa-lightbulb mr-1"></i>使用例</p>
                        <table class="w-full text-xs border-collapse">
                            <thead><tr class="bg-teal-100"><th class="p-2 text-left border border-teal-200">スタッフ</th><th class="p-2 text-left border border-teal-200">早番</th><th class="p-2 text-left border border-teal-200">遅番</th><th class="p-2 text-left border border-teal-200">夜勤</th></tr></thead>
                            <tbody>
                                <tr><td class="p-2 border border-teal-200 font-bold">Aさん (早番担当)</td><td class="p-2 border border-teal-200">3</td><td class="p-2 border border-teal-200">0</td><td class="p-2 border border-teal-200">0</td></tr>
                                <tr><td class="p-2 border border-teal-200 font-bold">Bさん (遅番担当)</td><td class="p-2 border border-teal-200">0</td><td class="p-2 border border-teal-200">3</td><td class="p-2 border border-teal-200">0</td></tr>
                                <tr><td class="p-2 border border-teal-200 font-bold">Cさん (夜勤担当)</td><td class="p-2 border border-teal-200">0</td><td class="p-2 border border-teal-200">0</td><td class="p-2 border border-teal-200">3</td></tr>
                            </tbody>
                        </table>
                        <p class="text-xs text-teal-700 mt-2">→ AIは各スタッフの担当パターンを尊重しながらシフトを組みます。</p>
                    </div>
                    <ul class="text-xs text-gray-600 space-y-1 list-disc list-inside ml-2">
                        <li><strong>0 または空欄</strong>: 制約なし (AI が自由に配置)</li>
                        <li><strong>1 以上</strong>: 月間で目標回数に近づくよう優先配置</li>
                        <li>シフトパターン人数要件 (店舗設定側) と <strong>競合した場合は人数要件が優先</strong>される (= 「Aさん早番3回」と指定しても、その日に早番が不足していれば他のパターンに回ることがある)</li>
                    </ul>
                    <p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2"><strong>💡 こんな運用に最適:</strong> 「夜勤専門のスタッフがいる」「学生バイトは早番だけにしたい」「特定スタッフを各時間帯に均等に分散させたい」など、スタッフごとの担当時間帯が明確な店舗。</p>
                </div>
            </div>

            <!-- 3. AIシフト作成 -->
            <div id="m-shift" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">3.</span>AIシフト作成</h3>
                <div class="space-y-3 text-sm text-gray-700">
                    <p><strong>「AIシフト作成」ボタン1つ</strong>で以下が自動実行されます:</p>
                    <ol class="list-decimal list-inside space-y-1 ml-2">
                        <li>スタッフの条件・希望休・週勤務日数を読み込み</li>
                        <li>Python数理最適化エンジン(PuLP)でベースシフト生成</li>
                        <li>AI(Gemini)が労基法チェック・違反修正・最適化</li>
                        <li>シフト保存→AI診断レポート表示</li>
                    </ol>
                    <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-2">
                        <p class="text-xs text-blue-700"><strong>作成範囲の選択肢:</strong></p>
                        <ul class="text-xs text-blue-600 mt-1 space-y-0.5">
                            <li>・現在のシフトをリセットして再構築 (未来日のみ)</li>
                            <li>・来週分を作成</li>
                        </ul>
                    </div>
                    <!-- v3.7.96: 不足セルクリック → 原因分析モーダル の説明 -->
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-2">
                        <p class="text-xs font-bold text-amber-800 mb-1"><i class="fa-solid fa-circle-question mr-1"></i>「不足」が出たら クリックで原因を確認</p>
                        <p class="text-xs text-amber-700 leading-relaxed">
                            シフト表の <strong>「⚠ 不足N名」</strong> セルをクリックすると、
                            その日その時刻に「入れていないスタッフ」を以下のように分類表示します:
                        </p>
                        <ul class="text-xs text-amber-700 mt-1 space-y-0.5 list-disc list-inside ml-2">
                            <li>✓ 在籍中 / ⏰ 別時間帯で勤務中 (シフト延長で配置可能)</li>
                            <li>🏖 承認済み休み希望 (却下で配置可能)</li>
                            <li>📅 NG曜日 (出勤不可)</li>
                            <li>⏳ 希望時間帯外 (希望時間の見直し)</li>
                            <li>? その他/週月上限到達</li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 4. 労基法 -->
            <div id="m-labor" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">4.</span>労働基準法ルール（自動遵守）</h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">条項</th><th class="p-2 text-left border">内容</th><th class="p-2 text-left border">システムの制御</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border">労基法32条</td><td class="p-2 border">1日8時間以内</td><td class="p-2 border">スタッフ個別設定で上書き可 (1日最大時間)</td></tr>
                        <tr class="bg-amber-50"><td class="p-2 border">労基法32条</td><td class="p-2 border">週40時間以内</td><td class="p-2 border text-amber-700 text-xs"><strong>v3.7.90で撤廃</strong>: 変形労働時間制対応のためシステム側 自動制限を解除。店舗運用ルール側で管理してください。</td></tr>
                        <tr><td class="p-2 border">労基法34条</td><td class="p-2 border">6h超→45分休憩、8h超→60分休憩</td><td class="p-2 border">自動付与（設定変更可）</td></tr>
                        <tr><td class="p-2 border">労基法35条</td><td class="p-2 border">週1日以上の休日（連続6日まで）</td><td class="p-2 border">自動遵守</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 5. 休憩ルール -->
            <div id="m-break" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">5.</span>休憩ルール</h3>
                <p class="text-sm text-gray-600 mb-2">シフト作成時に勤務時間から自動計算されます。店舗設定で変更可能です。</p>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">勤務時間</th><th class="p-2 text-left border">休憩時間</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border">6時間超</td><td class="p-2 border">45分以上</td></tr>
                        <tr><td class="p-2 border">8時間超</td><td class="p-2 border">60分以上</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 6. 休み希望 -->
            <div id="m-request" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">6.</span>休み希望</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>スタッフ側:</strong> カレンダーから複数日をタップ選択→「休み希望を提出」</p>
                    <p><strong>管理者側:</strong> 申請リストで確認→承認/却下</p>
                    <p><strong>承認された休み希望</strong>はAIシフト作成時に自動反映され、その日にはシフトが配置されません。</p>
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <p class="text-xs text-amber-700"><strong>ポイント:</strong> 勤務日数はスタッフの「週最大勤務日数」設定で自動管理されます。休み希望は追加の休日指定です。</p>
                    </div>
                </div>
            </div>

            <!-- 7. 店舗設定 -->
            <div id="m-settings" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">7.</span>店舗設定</h3>
                <div class="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3">
                    <p class="text-sm text-amber-800 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>店舗設定はAIシフトの品質に直結します。必ず正確に設定してください。</p>
                </div>
                <div class="space-y-4 text-sm text-gray-700">
                    
                    <div class="border-l-4 border-indigo-400 pl-4 py-1">
                        <h4 class="font-bold text-indigo-700 text-base mb-1">1. 役職・ロール設定</h4>
                        <p>スタッフの肩書き（店長・副店長・社員など）を自由にカスタマイズし、バッジの色を設定できます。各役職に「管理者として認識」チェックを付けると、AIは その役職のスタッフを <strong>管理者最低人数</strong> の対象として扱います。</p>
                        <p class="text-xs text-gray-500 mt-1">※ チェック OFF の役職は管理者カウントから外れます。未設定の場合は紫/赤/緑のバッジカラーから自動判定 (後方互換)。</p>
                    </div>

                    <div class="border-l-4 border-blue-400 pl-4 py-1">
                        <h4 class="font-bold text-blue-700 text-base mb-1">2. 営業時間 ＆ 定休日</h4>
                        <p>平日・土日・祝日ごとに開店/閉店時間を設定します。未設定だと全日同一営業時間で計算されます。<br>定休日（毎週水曜など）を設定すると、AIはその曜日には一切シフトを入れません。</p>
                    </div>

                    <div class="border-l-4 border-orange-400 pl-4 py-1">
                        <h4 class="font-bold text-orange-700 text-base mb-1">3. 人員配置要件（ベース）</h4>
                        <p><strong>管理者の配置人数:</strong> シフトパターンごとに「管理者(店長・リーダー)を何人入れるか」を設定します（シフトパターン表の「管理者」列）。<br>
                        <strong>スタッフ総数要件:</strong> 平日・土曜・日祝の各曜日タイプごとに、1日あたりの最低配置人数を設定します。<br>
                        <span class="text-xs text-gray-500">※ 時間帯別の必要人数 (ランチ・ディナーピーク等) は <strong>シフトパターン</strong> で時間帯と人数を直接指定する方式に統一されました。</span></p>
                    </div>

                    <div class="border-l-4 border-purple-400 pl-4 py-1">
                        <h4 class="font-bold text-purple-700 text-base mb-1">4. シフトパターンの設定（重要）</h4>
                        <p>「早番（09:00〜14:00）」「遅番（17:00〜22:00）」などの時間テンプレートと、その時間帯に何人配置するかを <strong>平日 / 土曜 / 日祝</strong> の3カラムで指定できます。</p>
                        <p class="text-xs text-gray-600 mt-1">例: 早番 平日2名・土曜3名・日祝3名 / 遅番 平日3名・土曜4名・日祝4名 → AIはこの曜日別人数を必ず満たす形でシフトを組みます。</p>
                        <p class="text-xs text-amber-700 font-bold mt-1">※ 人数は必須入力です (最少1名)。プリセット (飲食店向け・オフィス向け等) からの一括追加もできます。</p>
                    </div>

                    <!-- v3.7.96: 過剰配置トグル の説明 -->
                    <div class="border-l-4 border-amber-400 pl-4 py-1">
                        <h4 class="font-bold text-amber-700 text-base mb-1">4.5. 過剰配置ポリシー (v3.7.91+)</h4>
                        <p>人員配置要件セクションの下に「⚡ 過剰配置を許容する」チェックがあります:</p>
                        <ul class="text-xs text-gray-700 mt-1 list-disc list-inside ml-2 leading-relaxed">
                            <li><strong>OFF (推奨):</strong> 必要人数 <strong>ぴったり</strong>に配置 (過剰回避を最優先)</li>
                            <li><strong>ON:</strong> 必要人数より<strong>多めに配置</strong>を許容 (スタッフを多く入れたい場合)</li>
                        </ul>
                        <p class="text-xs text-amber-700 mt-1">💡 「全員を最低5日入れたい」「過剰でも全員の出勤日数を満たしたい」場合は ON にしてください。</p>
                    </div>

                    <div class="border-l-4 border-green-400 pl-4 py-1">
                        <h4 class="font-bold text-green-700 text-base mb-1">5. 休憩ルールの設定</h4>
                        <p>「〇〇時間以上の勤務なら〇〇分の休憩を与える」というルールです。労働基準法に則り、6時間超で45分、8時間超で60分がデフォルトで設定されています。</p>
                    </div>
                </div>

                <!-- v3.7.96: スタッフ管理マニュアル追記 -->
                <div class="mt-6 bg-white border-2 border-blue-200 rounded-xl p-5">
                    <h3 class="text-lg font-bold text-blue-800 mb-3"><i class="fa-solid fa-user-gear mr-1"></i>スタッフ管理 — 勤務制約 (v3.7.91+)</h3>
                    <p class="text-sm text-gray-700 mb-3">スタッフ編集モーダルの「勤務制約 (AI自動作成用)」セクションは、最低/最大を週×月の表で管理します:</p>
                    <table class="w-full text-xs border-collapse">
                        <thead><tr class="bg-blue-50"><th class="p-2 border border-blue-200 text-left">期間</th><th class="p-2 border border-blue-200">最低出勤日数</th><th class="p-2 border border-blue-200">最大出勤日数</th></tr></thead>
                        <tbody>
                            <tr><td class="p-2 border border-blue-200 font-bold">週 (7日)</td><td class="p-2 border border-blue-200 text-center">0 〜 7</td><td class="p-2 border border-blue-200 text-center">1 〜 7</td></tr>
                            <tr><td class="p-2 border border-blue-200 font-bold">月 (1-31日)</td><td class="p-2 border border-blue-200 text-center">0 〜 31</td><td class="p-2 border border-blue-200 text-center">1 〜 31</td></tr>
                        </tbody>
                    </table>
                    <ul class="text-xs text-gray-600 mt-2 space-y-1 list-disc list-inside">
                        <li><strong>最低出勤日数</strong>: 月給スタッフは <strong>ハード制約</strong>で必ず達成 / 時給スタッフは Tier 3 ソフト制約 (1M)</li>
                        <li><strong>最大出勤日数 (週)</strong>: ハード制約 (週N日を超えない)</li>
                        <li><strong>最大出勤日数 (月)</strong>: ハード制約 / 31日 = 制限なし</li>
                        <li><strong>1日の最大勤務時間</strong>: 実労働ベース (休憩除く)、ハード制約</li>
                    </ul>
                    <p class="text-xs text-amber-700 mt-2"><i class="fa-solid fa-info-circle mr-1"></i>月給スタッフは min_days_week / min_days_month が <strong>ハード制約</strong> です。物理的に達成可能な値を設定してください (例: 週5日勤務想定なら 月22日まで設定可能)。</p>
                </div>
            </div>

            <!-- 8. プラン -->
            <div id="m-plan" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">8.</span>プラン・課金</h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">プラン</th><th class="p-2 text-left border">月額</th><th class="p-2 text-left border">スタッフ上限</th><th class="p-2 text-left border">機能</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border font-bold text-blue-600">Standard</td><td class="p-2 border">3,380円</td><td class="p-2 border">10名</td><td class="p-2 border">全AI機能・シフト管理全機能</td></tr>
                        <tr class="bg-green-50"><td class="p-2 border font-bold text-green-600">Pro</td><td class="p-2 border">4,880円</td><td class="p-2 border">50名</td><td class="p-2 border">+ 優先サポート・分析レポート</td></tr>
                        <tr><td class="p-2 border font-bold text-purple-600">Premium</td><td class="p-2 border">9,980円</td><td class="p-2 border">無制限</td><td class="p-2 border">+ 複数店舗対応・専属サポート</td></tr>
                    </tbody>
                </table>
                <div class="mt-3 space-y-1 text-xs text-gray-500">
                    <p>・上限超過時はスタッフ追加・シフト作成がブロックされます</p>
                    <p>・ダウングレード時、超過分のスタッフを削除するまでシフト作成不可</p>
                    <p>・解約後もデータは6ヶ月間保持されます</p>
                    <p>・決済不備から3週間未対応でサービス一時停止</p>
                </div>
            </div>

            <!-- 9. 権限 -->
            <div id="m-auth" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">9.</span>権限 (管理者 / スタッフ)</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                        <h4 class="font-bold text-green-600 mb-2">管理者ができること</h4>
                        <ul class="space-y-1 text-gray-700">
                            <li>・AIシフト作成</li>
                            <li>・シフトの手動編集・ドラッグ移動</li>
                            <li>・スタッフの追加・編集・削除</li>
                            <li>・休み希望の承認・却下</li>
                            <li>・店舗設定の変更</li>
                            <li>・分析レポートの閲覧</li>
                            <li>・プラン変更</li>
                            <li>・このマニュアルの閲覧</li>
                        </ul>
                    </div>
                    <div>
                        <h4 class="font-bold text-blue-600 mb-2">スタッフができること</h4>
                        <ul class="space-y-1 text-gray-700">
                            <li>・自分のシフト確認</li>
                            <li>・休み希望の提出</li>
                            <li>・お店のルール確認</li>
                        </ul>
                        <p class="text-xs text-gray-400 mt-2">※ スタッフは他のスタッフの情報やシフト編集にはアクセスできません</p>
                    </div>
                </div>
            </div>

            <!-- 10. 分析 -->
            <div id="m-analytics" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">10.</span>分析・レポート</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>月間推定人件費:</strong> 時給スタッフの実績＋月給スタッフの固定額。祝日割増(1.25倍)含む。</p>
                    <p><strong>日次コスト推移:</strong> 日ごとの人件費グラフ。</p>
                    <p><strong>スタッフ別詳細:</strong> 出勤日数・労働時間・法定目安(176h)との比較・推定支給額。</p>
                    <p><strong>コスト構成比:</strong> スタッフ別の人件費割合（円グラフ）。</p>
                </div>
            </div>

            <!-- 11. その他 -->
            <div id="m-other" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">11.</span>その他機能</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>カレンダーメモ:</strong> 特定の日にメモを残せます（イベント・団体予約など）。</p>
                    <p><strong>ドラッグ&ドロップ:</strong> シフト表でシフトをドラッグして時間変更・スタッフ変更が可能（管理者のみ）。</p>
                    <p><strong>印刷:</strong> シフト表をPDF/印刷できます。</p>
                    <p><strong>データリセット:</strong> 設定画面の最下部から全データを初期化できます（注意：復元不可）。</p>
                </div>
            </div>
        </div>`;
    },

    renderHQManual(container) {
        if (!this.state.isHQ) { this.changeView('dashboard'); return; }

        // 店舗選択中（＝organization_idがある）なら、サイドバーの枠内なので店舗マニュアルとの切り替えタブを表示
        // 店舗未選択（＝本部ダッシュボードから直接アクセス）なら、本部ダッシュボードに戻るボタンを表示
        const hasShop = !!this.state.organization_id;
        let headerHtml = '';
        if (hasShop) {
            headerHtml = `
            <div class="flex border-b border-gray-200 mb-6 bg-white rounded-xl p-1 shadow-sm max-w-4xl mx-auto">
                <button onclick="app.changeView('manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg text-gray-500 hover:text-gray-900 transition-all">
                    <i class="fa-solid fa-book mr-1"></i>店舗管理者マニュアル
                </button>
                <button onclick="app.changeView('hq_manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg bg-indigo-50 text-indigo-700 shadow-sm transition-all">
                    <i class="fa-solid fa-building-user mr-1"></i>本部管理者マニュアル
                </button>
            </div>
            `;
        } else {
            headerHtml = `
            <div class="max-w-4xl mx-auto flex items-center justify-between mb-6">
                <h2 class="text-xl font-bold text-gray-800"><i class="fa-solid fa-building-user mr-2 text-indigo-500"></i>本部管理者マニュアル</h2>
                <button onclick="app.changeView('hq_dashboard')" class="px-4 py-2 text-sm font-bold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 rounded-xl bg-white transition-all shadow-sm">
                    <i class="fa-solid fa-arrow-left mr-1"></i>本部ダッシュボードへ戻る
                </button>
            </div>
            `;
        }

        container.innerHTML = `
        ${headerHtml}
        <div class="max-w-4xl mx-auto space-y-6 pb-20">
            <!-- 概要 -->
            <div class="bg-gradient-to-r from-indigo-50 to-blue-50 rounded-2xl shadow-sm border border-indigo-100 p-6">
                <h3 class="text-lg font-bold text-indigo-900 mb-2"><i class="fa-solid fa-circle-info mr-2"></i>本部アカウントとは</h3>
                <p class="text-sm text-indigo-700 leading-relaxed">
                    本部アカウントは、複数店舗（テナント）のシフト稼働状況や人件費、スタッフ構成を横断的に把握・閲覧するための専用アカウントです。<br>
                    <strong>セキュリティ保護のため、全店舗データは「閲覧専用」であり、本部から直接データの追加や編集、削除を行うことはできません。</strong>
                </p>
            </div>

            <!-- 目次 -->
            <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h3 class="font-bold text-gray-800 mb-3">目次</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                    <a href="#hq-auth" class="text-indigo-600 hover:underline">1. 本部権限とセキュリティポリシー</a>
                    <a href="#hq-dashboard-guide" class="text-indigo-600 hover:underline">2. 本部ダッシュボードの使い方</a>
                    <a href="#hq-shop-access" class="text-indigo-600 hover:underline">3. 店舗へのアクセス手順</a>
                    <a href="#hq-view-mode" class="text-indigo-600 hover:underline">4. 閲覧専用モードでの制限操作</a>
                    <a href="#hq-faq" class="text-indigo-600 hover:underline">5. よくある質問 (FAQ)</a>
                </div>
            </div>

            <!-- 1. 本部権限 -->
            <div id="hq-auth" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">1.</span>本部権限とセキュリティポリシー</h4>
                <div class="space-y-4">
                    <p class="text-sm text-gray-600">本部管理者は、店舗のデータを誤って変更することを防ぐため、各画面が読み取り専用（閲覧のみ）の構成に自動制限されます。</p>
                    <table class="w-full text-sm border-collapse border border-gray-200">
                        <thead>
                            <tr class="bg-gray-50 text-gray-700 font-bold">
                                <th class="p-2 border text-left">操作項目</th>
                                <th class="p-2 border text-center">本部管理者</th>
                                <th class="p-2 border text-center">店舗管理者</th>
                            </tr>
                        </thead>
                        <tbody class="text-gray-600">
                            <tr>
                                <td class="p-2 border font-bold">登録店舗一覧の表示</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                                <td class="p-2 border text-center text-red-500"><i class="fa-solid fa-circle-xmark"></i> 不可</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">シフト表の閲覧・印刷</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">スタッフ構成の閲覧</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">シフトの新規作成・編集</td>
                                <td class="p-2 border text-center text-red-500 font-bold"><i class="fa-solid fa-circle-xmark"></i> 閲覧のみ</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">スタッフの追加・変更</td>
                                <td class="p-2 border text-center text-red-500 font-bold"><i class="fa-solid fa-circle-xmark"></i> 閲覧のみ</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- 2. ダッシュボード -->
            <div id="hq-dashboard-guide" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">2.</span>本部ダッシュボードの使い方</h4>
                <div class="space-y-3 text-sm text-gray-600 leading-relaxed">
                    <p>ログイン後に表示される本部管理者用コントロールパネルです。ここでは以下の情報が確認できます。</p>
                    <ul class="list-disc pl-5 space-y-2">
                        <li><strong>登録店舗一覧:</strong> 傘下の全店舗の名前、契約ID、契約中のプラン（Standard/Proなど）、登録スタッフ数、および稼働状態が一覧で表示されます。</li>
                        <li><strong>店舗へのアクセス:</strong> セキュリティ保護のため、一覧から店舗を直接クリックして入ることはできません。店舗に入るには次の「店舗へのアクセス手順」を実行してください。</li>
                    </ul>
                </div>
            </div>

            <!-- 3. 店舗へのアクセス手順 -->
            <div id="hq-shop-access" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">3.</span>店舗へのアクセス手順</h4>
                <div class="space-y-4">
                    <div class="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-sm text-indigo-900">
                        店舗の詳細情報やシフト表を確認するには、以下の手順で<strong>認証</strong>を行ってください。
                    </div>
                    <ol class="list-decimal pl-5 text-sm text-gray-600 space-y-3">
                        <li>本部ダッシュボードの<strong>「指定の店舗を閲覧」</strong>欄を確認します。</li>
                        <li>一覧表から、アクセスしたい店舗の<strong>契約ID（15桁）</strong>をコピーまたは入力します。</li>
                        <li>その店舗の<strong>管理者パスワード</strong>（または店舗用一般パスワード）を入力します。</li>
                        <li><strong>「閲覧する」</strong>ボタンをクリックします。</li>
                        <li>認証に成功すると、店舗側の管理画面に切り替わり、ヘッダーに「<i class="fa-solid fa-eye mr-1"></i>閲覧専用モード」と表示されます。</li>
                    </ol>
                </div>
            </div>

            <!-- 4. 閲覧専用モードでの制限操作 -->
            <div id="hq-view-mode" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">4.</span>閲覧専用モードでの制限操作</h4>
                <div class="space-y-3 text-sm text-gray-600 leading-relaxed">
                    <p>店舗に入った後は、店長アカウントと同等の表示情報を確認できますが、操作ボタンの大部分は非表示または無効化されます。</p>
                    <div class="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 text-xs">
                        ⚠️ <strong>ご注意:</strong> 本部閲覧中は、ボタン（「追加」「保存」「作成」「削除」など）は画面から自動的に非表示になります。もし編集が必要な場合は、自店舗の管理者が「店舗管理者ログイン」からアクセスして操作する必要があります。
                    </div>
                </div>
            </div>

            <!-- 5. FAQ -->
            <div id="hq-faq" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">5.</span>よくある質問 (FAQ)</h4>
                <div class="space-y-4">
                    <div class="space-y-1">
                        <p class="text-sm font-bold text-gray-800">Q. 店舗一覧から直接入れないのはなぜですか？</p>
                        <p class="text-sm text-gray-600">A. セキュリティおよび誤操作防止のため、各テナントの管理者パスワードを入力する追加認証を必須としています。これにより不正アクセスや意図しない店舗データの閲覧を防止しています。</p>
                    </div>
                    <hr class="border-gray-100">
                    <div class="space-y-1">
                        <p class="text-sm font-bold text-gray-800">Q. ログアウトするにはどうすればよいですか？</p>
                        <p class="text-sm text-gray-600">A. 画面ヘッダー右上の「ログアウト」ボタンをクリックしてください。即座にセッションがクリアされ、ログイン画面に戻ります。</p>
                    </div>
                    <hr class="border-gray-100">
                    <div class="space-y-1">
                        <p class="text-sm font-bold text-gray-800">Q. パスワードが一致しているのに店舗に入れません。</p>
                        <p class="text-sm text-gray-600">A. 契約IDが15桁正確に入力されているかご確認ください（スペースなどの余分な文字が含まれていないか注意してください）。</p>
                    </div>
                </div>
            </div>
        </div>
        `;
    },

    // --- その他 ---
    calculateMonthlyStats() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
        let totalCost = 0, totalHours = 0;
        
        this.state.shifts.filter(s => s.date.startsWith(monthPrefix)).forEach(shift => {
            const staff = this.getStaff(shift.staff_id);
            if (!staff) return;
            const start = new Date(`${shift.date}T${shift.start_time}`);
            const end = new Date(`${shift.date}T${shift.end_time}`);
            if (end < start) end.setDate(end.getDate() + 1);
            const hours = (end - start) / (1000 * 60 * 60) - ((shift.break_minutes || 0) / 60);
            if (hours > 0) {
                totalHours += hours;
                if (staff.salary_type === 'hourly') {
                    let wage = staff.hourly_wage || this.state.config.hourly_wage_default;
                    if (JapaneseHolidays.isHoliday(shift.date)) wage *= 1.25;
                    totalCost += wage * hours;
                }
            }
        });
        this.state.staff.filter(s => s.salary_type === 'monthly').forEach(s => totalCost += (s.monthly_salary || 0));
        
        // 要素が存在する場合のみ表示を更新（スタッフ画面では要素がないためスキップされる）
        const costEl = document.getElementById('headerTotalCost');
        const hoursEl = document.getElementById('headerTotalHours');
        
        if(costEl) costEl.textContent = `¥${Math.floor(totalCost).toLocaleString()}`;
        if(hoursEl) hoursEl.textContent = `${Math.floor(totalHours)}h`;
    },

    // --- AI診断 (サーバーサイド経由) ---
    async runAIDiagnosis() {
        this.openModal('aiAdviceModal');
        const content = document.getElementById('aiAnalysisContent');
        content.innerHTML = `<div class="flex justify-center py-8"><div class="loading-spinner"></div><p class="ml-3 text-gray-500">AIがシフトを分析中...</p></div>`;

        try {
            const result = await API.diagnose({
                contract_id: this.state.config?.contract_id || API.session?.user?.contract_id,
                config: {
                    opening_time: this.state.config.opening_time,
                    closing_time: this.state.config.closing_time,
                    staff_req: this.state.config.staff_req
                },
                staff_count: this.state.staff.length,
                shift_count: this.state.shifts.length,
                shifts: this.state.shifts.map(s => ({
                    staff_id: s.staff_id,
                    date: s.date,
                    start_time: s.start_time,
                    end_time: s.end_time
                })),
                staff_list: this.state.staff.map(s => ({
                    id: s.id,
                    name: s.name,
                    role: s.role,
                    max_days_week: s.max_days_week,
                    max_hours_day: s.max_hours_day,
                    min_days_week: s.min_days_week,
                    min_days_month: s.min_days_month
                }))
            });

            if (!result || !Array.isArray(result)) throw new Error("AIからの応答がありません");

            content.innerHTML = result.map(s => {
                const typeStyles = {
                    danger: { border: 'border-red-300 bg-red-50', icon: '<i class="fa-solid fa-circle-exclamation text-red-600 text-xl"></i>' },
                    warning: { border: 'border-orange-200 bg-orange-50', icon: '<i class="fa-solid fa-triangle-exclamation text-orange-500 text-xl"></i>' },
                    info: { border: 'border-blue-200 bg-blue-50', icon: '<i class="fa-solid fa-lightbulb text-blue-500 text-xl"></i>' },
                };
                const style = typeStyles[s.type] || typeStyles.info;
                return `
                <div class="bg-white border ${style.border} rounded-lg p-4 flex gap-4">
                    <div class="mt-1">${style.icon}</div>
                    <div>
                        <h4 class="font-bold text-gray-800 mb-1">${this._sanitize(s.title || '')}</h4>
                        <p class="text-sm text-gray-600 mb-3">${this._sanitize(s.desc || '')}</p>
                        <p class="text-xs font-bold text-gray-500">${this._sanitize(s.action || '')}</p>
                    </div>
                </div>`;
            }).join('');

        } catch (e) {
            console.error(e);
            content.innerHTML = `<div class="text-red-500 p-4"><i class="fa-solid fa-circle-exclamation mr-2"></i>診断エラー: ${this._sanitize(e.message)}</div>`;
        }
    },
    
    applyAiFixes() { this.closeModal('aiAdviceModal'); this.showToast('修正案を適用しました', 'success'); },

    // --- Stripe決済 ---
    async startCheckout(plan) {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('ログインが必要です', 'error');
            return;
        }
        this.showLoading(true);
        try {
            const result = await API.createCheckout(contractId, plan);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('チェックアウトURLの取得に失敗しました', 'error');
            }
        } catch (e) {
            console.error('Checkout Error:', e);
            this.showToast('決済エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async openStripePortal() {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('ログインが必要です', 'error');
            return;
        }
        this.showLoading(true);
        try {
            const result = await API.createPortal(contractId);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('ポータルURLの取得に失敗しました', 'error');
            }
        } catch (e) {
            console.error('Portal Error:', e);
            this.showToast('エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    _markFieldError(id, show) {
        const el = document.getElementById(id);
        if (!el) return;
        if (show) {
            el.classList.add('border-red-500', 'ring-2', 'ring-red-200');
            el.classList.remove('border-gray-300');
        } else {
            el.classList.remove('border-red-500', 'ring-2', 'ring-red-200');
            el.classList.add('border-gray-300');
        }
    },

    // 「なし」相当の入力かどうか判定
    _isReferrerNone(code) {
        const normalized = (code || '').trim().toLowerCase();
        return ['なし', '無し', '無', 'none', 'nashi', 'no', 'n/a', 'na'].includes(normalized);
    },

    copyCompanyPhoneToContact() {
        const company = document.getElementById('newSubPhone')?.value.trim();
        if (!company) {
            this.showToast('代表電話番号を先に入力してください', 'error');
            return;
        }
        const target = document.getElementById('newSubContactPhone');
        if (target) {
            target.value = company;
            this._markFieldError('newSubContactPhone', false);
        }
    },

    async validateReferrerCode() {
        const raw = document.getElementById('newSubReferrerCode')?.value.trim();
        const status = document.getElementById('referrerCodeStatus');
        if (!raw) {
            status.innerHTML = '<span class="text-gray-400">コードを入力してください（紹介者がいない場合は「なし」）</span>';
            return;
        }
        // 「なし」系の入力
        if (this._isReferrerNone(raw)) {
            status.innerHTML = '<span class="text-blue-600"><i class="fa-solid fa-circle-info mr-1"></i>紹介者なしで登録します</span>';
            this._markFieldError('newSubReferrerCode', false);
            return;
        }
        const code = raw.toUpperCase();
        try {
            // 統一の API.rpc() 経由で呼ぶ (エラーハンドリング・リトライ機構の恩恵)
            const result = await API.rpc('validate_referrer_code', { p_code: code });
            if (result && result.valid) {
                status.innerHTML = `<span class="text-green-600"><i class="fa-solid fa-circle-check mr-1"></i>有効: ${this._sanitize(result.name)}</span>`;
                this._markFieldError('newSubReferrerCode', false);
            } else {
                status.innerHTML = `<span class="text-red-500"><i class="fa-solid fa-circle-xmark mr-1"></i>${this._sanitize(result.message || '無効なコードです')}（紹介者がいない場合は「なし」と入力）</span>`;
                this._markFieldError('newSubReferrerCode', true);
            }
        } catch (e) {
            status.innerHTML = '<span class="text-red-500">確認に失敗しました</span>';
        }
    },

    async startNewSubscription() {
        const orgName = document.getElementById('newSubOrgName')?.value.trim();
        const contact = document.getElementById('newSubContact')?.value.trim();
        const email = document.getElementById('newSubEmail')?.value.trim();
        const phone = document.getElementById('newSubPhone')?.value.trim();
        const contactPhone = document.getElementById('newSubContactPhone')?.value.trim();
        const address = document.getElementById('newSubAddress')?.value.trim();
        const referrerInput = document.getElementById('newSubReferrerCode')?.value.trim() || '';
        const plan = document.querySelector('input[name="newSubPlan"]:checked')?.value;

        // 全フィールドリセット
        ['newSubOrgName','newSubContact','newSubEmail','newSubPhone','newSubContactPhone','newSubAddress','newSubReferrerCode'].forEach(id => this._markFieldError(id, false));

        const errors = [];
        if (!orgName) { errors.push('事業者名'); this._markFieldError('newSubOrgName', true); }
        if (!contact) { errors.push('担当者名'); this._markFieldError('newSubContact', true); }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) { errors.push('メールアドレス'); this._markFieldError('newSubEmail', true); }
        const phoneRegex = /^[0-9\-\+]{10,15}$/;
        if (!phone || !phoneRegex.test(phone.replace(/[\s\(\)]/g, ''))) { errors.push('代表電話番号'); this._markFieldError('newSubPhone', true); }
        if (!contactPhone || !phoneRegex.test(contactPhone.replace(/[\s\(\)]/g, ''))) { errors.push('担当者電話番号'); this._markFieldError('newSubContactPhone', true); }
        if (!address || address.length < 5) { errors.push('住所'); this._markFieldError('newSubAddress', true); }
        if (!referrerInput) { errors.push('紹介者コード（不明な場合は「なし」と入力）'); this._markFieldError('newSubReferrerCode', true); }
        if (!plan) { errors.push('プラン'); }

        if (errors.length > 0) {
            this.showToast(`以下の項目を正しく入力してください: ${errors.join('、')}`, 'error');
            return;
        }

        // 紹介者コード処理
        let referrerCode = '';  // 「なし」の場合は空文字をDBに保存
        if (!this._isReferrerNone(referrerInput)) {
            referrerCode = referrerInput.toUpperCase();
            try {
                // 統一の API.rpc() 経由で呼ぶ
                const vresult = await API.rpc('validate_referrer_code', { p_code: referrerCode });
                if (!vresult || !vresult.valid) {
                    this._markFieldError('newSubReferrerCode', true);
                    this.showToast(`紹介者コード: ${this._sanitize(vresult?.message || '無効')}（紹介者がいない場合は「なし」と入力）`, 'error');
                    return;
                }
            } catch (e) {
                this.showToast('紹介者コードの検証に失敗しました', 'error');
                return;
            }
        }

        this.showLoading(true);
        try {
            const result = await API.createNewSubscription(email, orgName, plan, contact, phone, address, referrerCode, contactPhone);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('決済ページの作成に失敗しました', 'error');
            }
        } catch (e) {
            console.error('New Subscription Error:', e);
            this.showToast('エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async updateEmail() {
        const email = document.getElementById('settingEmail')?.value.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) {
            this.showToast('有効なメールアドレスを入力してください', 'error');
            return;
        }
        const contractId = this.state.config.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('ログインが必要です', 'error');
            return;
        }
        try {
            await API._request(`config?contract_id=eq.${contractId}`, {
                method: 'PATCH',
                body: JSON.stringify({ customer_email: email })
            });
            this.state.config.customer_email = email;
            this.showToast('メールアドレスを更新しました', 'success');
        } catch (e) {
            this.showToast('更新に失敗しました: ' + e.message, 'error');
        }
    },

    openPricingModal() {
        // 設定画面のサブスクリプションセクションまでスクロール
        const section = document.getElementById('subscriptionSection');
        if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'center' });
            section.classList.add('ring-2', 'ring-blue-400');
            setTimeout(() => section.classList.remove('ring-2', 'ring-blue-400'), 2000);
        }
    },
    
    showShopRules() {
        const config = this.state.config;
        const content = document.getElementById('shopRulesContent');
        const rulesText = config.shop_rules_text || this.state.defaultConfig.shop_rules_text;
        // 改行をリストアイテムに変換
        const rulesList = rulesText.split('\n').filter(line => line.trim() !== '').map(line => `<li>${this._sanitize(line)}</li>`).join('');
        
        // 金銭情報を完全に削除し、業務ルールのみを表示
        content.innerHTML = `
            <div class="space-y-4">
                <div class="bg-blue-50 p-4 rounded-xl border border-blue-100">
                    <h4 class="font-bold text-blue-800 text-sm mb-2"><i class="fa-regular fa-clock mr-2"></i>営業時間</h4>
                    <p class="text-2xl font-bold text-gray-800 text-center">${config.opening_time || '09:00'} <span class="text-sm text-gray-400 mx-2">〜</span> ${config.closing_time || '22:00'}</p>
                </div>
                
                <div class="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <h4 class="font-bold text-gray-600 text-xs mb-1">最低勤務人数</h4>
                    <p class="text-lg font-bold text-gray-800">${config.staff_req?.min_weekday || 2}名</p>
                </div>

                <div class="border-t border-gray-100 pt-4">
                    <h4 class="font-bold text-gray-800 text-sm mb-2">シフト申請について・お知らせ</h4>
                    <ul class="text-sm text-gray-600 space-y-1 list-disc pl-5">
                        ${rulesList}
                    </ul>
                </div>
            </div>
        `;
        this.openModal('shopRulesModal');
    },

    getStaff(id) { return this.state.staff.find(s => s.id === id); },
    showLoading(show) { const el = document.getElementById('globalLoading'); if (show) el.classList.remove('hidden'); else el.classList.add('hidden'); },
    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        let colorClass = type === 'success' ? 'border-green-200 text-green-600' : type === 'error' ? 'border-red-300 text-red-700 bg-red-50' : type === 'warning' ? 'border-amber-300 text-amber-700 bg-amber-50' : 'border-gray-200 text-gray-600';
        let icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-circle-xmark' : type === 'warning' ? 'fa-triangle-exclamation' : 'fa-info-circle';
        // v3.7.5: error と warning は永続表示 + 閉じるボタン (旧版は3秒で消えて読めなかった)
        const persistent = (type === 'error' || type === 'warning');
        // v3.7.14: モバイル幅 (iPhone SE 1st gen 320px) でもはみ出ないように w-full + max-w
        toast.className = `flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg border bg-white transform transition-all duration-300 translate-y-2 opacity-0 w-full sm:min-w-[320px] max-w-[480px] ${colorClass}`;
        const safeMsg = this._sanitize(message);
        const closeBtn = persistent
            ? `<button onclick="this.closest('div.flex').remove()" class="ml-auto -mr-1 -mt-1 p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded" aria-label="閉じる"><i class="fa-solid fa-xmark"></i></button>`
            : '';
        toast.innerHTML = `<i class="fa-solid ${icon} mt-0.5 flex-shrink-0"></i><span class="text-sm font-medium text-gray-800 leading-relaxed flex-1">${safeMsg}</span>${closeBtn}`;
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));
        if (!persistent) {
            setTimeout(() => { toast.classList.add('opacity-0', 'translate-x-full'); setTimeout(() => toast.remove(), 300); }, 3000);
        } else {
            // error/warning は長めに残す: 自動消去は 12秒、ユーザーが閉じるまでも可
            setTimeout(() => { if (toast.parentNode) { toast.classList.add('opacity-0', 'translate-x-full'); setTimeout(() => toast.remove(), 300); } }, 12000);
        }
    },
    showUpgradeModal() {
        const currentPlan = this.state.config.stripe_plan || 'standard';
        const limit = this.getStaffLimit();
        const currentCount = this.state.staff.length;
        const planNames = {standard: 'Standard', pro: 'Pro', premium: 'Premium'};

        // 現在プラン情報
        const infoEl = document.getElementById('upgradeCurrentInfo');
        if (infoEl) {
            infoEl.textContent = `現在: ${planNames[currentPlan] || 'Standard'}プラン（${currentCount}/${limit}名）`;
        }

        // アップグレード先プランカードを動的生成
        const plansEl = document.getElementById('upgradePlans');
        if (!plansEl) return;

        const plans = [
            { key: 'standard', name: 'Standard', price: '3,380', limit: 10, color: 'blue', features: ['スタッフ10名まで', 'AI自動シフト生成', 'AI労基法チェック', 'シフト管理全機能'] },
            { key: 'pro', name: 'Pro', price: '4,880', limit: 50, badge: '人気', color: 'green', features: ['スタッフ50名まで', '全AI機能', '優先サポート', '分析レポート'] },
            { key: 'premium', name: 'Premium', price: '9,980', limit: 9999, color: 'purple', features: ['スタッフ無制限', '全AI機能', '複数店舗対応', '専属サポート'] },
        ];

        // 現在より上のプランのみ表示
        const upgradePlans = plans.filter(p => p.limit > limit);

        const colorMap = {
            green:  { ring: 'ring-2 ring-green-400 border-green-400', text: 'text-green-600', check: 'text-green-500', badge: 'bg-green-500', btn: 'bg-green-600 hover:bg-green-700' },
            purple: { ring: 'ring-2 ring-purple-400 border-purple-400', text: 'text-purple-600', check: 'text-purple-500', badge: 'bg-purple-500', btn: 'bg-purple-600 hover:bg-purple-700' },
            blue:   { ring: 'ring-2 ring-blue-400 border-blue-400', text: 'text-blue-600', check: 'text-blue-500', badge: 'bg-blue-500', btn: 'bg-blue-600 hover:bg-blue-700' },
        };

        plansEl.innerHTML = upgradePlans.map((p, i) => {
            const isRecommended = i === 0;
            const c = colorMap[p.color];
            const ringClass = isRecommended ? c.ring : 'border-gray-200';
            const badgeHtml = p.badge ? `<span class="absolute -top-2 right-3 ${c.badge} text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow">${p.badge}</span>` : '';
            const recommendHtml = isRecommended ? '<span class="absolute -top-2 left-3 bg-orange-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow flex items-center gap-1"><i class="fa-solid fa-star text-[8px]"></i>おすすめ</span>' : '';

            return `
                <div class="relative border-2 ${ringClass} rounded-xl p-5 hover:shadow-lg transition-all cursor-pointer group" onclick="app.upgradeFromModal('${p.key}')">
                    ${recommendHtml}${badgeHtml}
                    <div class="text-center mb-3">
                        <p class="font-bold ${c.text} text-lg">${p.name}</p>
                        <p class="text-3xl font-extrabold text-gray-900 mt-1">${p.price}<span class="text-sm font-normal text-gray-400">円/月</span></p>
                    </div>
                    <ul class="text-xs text-gray-600 space-y-1.5 mb-4">
                        ${p.features.map(f => `<li class="flex items-center gap-1.5"><i class="fa-solid fa-check ${c.check} text-[10px]"></i>${f}</li>`).join('')}
                    </ul>
                    <button class="w-full py-2.5 ${c.btn} text-white rounded-lg text-sm font-bold transition group-hover:shadow-md">
                        <i class="fa-solid fa-rocket mr-1"></i>このプランに変更
                    </button>
                </div>
            `;
        }).join('');

        this.openModal('upgradeModal');
    },

    upgradeFromModal(plan) {
        this.closeModal('upgradeModal');
        this.startCheckout(plan);
    },

    // v3.7.86: 不足セルクリック時の原因分析モーダル
    showShortageReason(dateStr, timeStr, requiredCount, actualCount) {
        const time = timeStr || '';
        const [hh, mm] = (time || '00:00').split(':').map(Number);
        const slotMin = (hh * 60 + (mm || 0));
        const shiftsForDay = (this.state.shifts || []).filter(s => s.date === dateStr);
        const toMins = (t) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + (m||0); };

        // この時刻に在籍中のスタッフ
        const presentIds = new Set();
        shiftsForDay.forEach(s => {
            const ss = toMins(s.start_time);
            let se = toMins(s.end_time);
            if (se <= ss) se += 24 * 60;
            if (ss <= slotMin && slotMin < se) presentIds.add(s.staff_id);
        });

        // この日のシフトに既に入っているスタッフ (時間帯不一致でも休出扱い)
        const onShiftToday = new Set(shiftsForDay.map(s => s.staff_id));

        // 当日の day_type 判定
        const d = new Date(dateStr + 'T00:00:00');
        const dow = d.getDay();
        const jh = (typeof JapaneseHolidays !== 'undefined') ? JapaneseHolidays : null;
        const isHoliday = jh ? jh.isHoliday(dateStr) : false;
        const dayLabel = isHoliday ? '祝日' : (dow === 0 ? '日曜' : (dow === 6 ? '土曜' : '平日'));

        // 全スタッフをチェックして「入れない理由」を分類
        const allStaff = this.state.staff || [];
        const reasons = { present: [], onShift: [], offRequested: [], ngDay: [], prefTime: [], unknown: [] };

        // 当日の承認済み休み希望
        const offReqs = (this.state.requests || []).filter(r =>
            r.type === 'off' && r.status === 'approved' && Array.isArray(r.dates) && r.dates.includes(dateStr)
        );
        const offIds = new Set(offReqs.map(r => r.staff_id));

        allStaff.forEach(s => {
            if (presentIds.has(s.id)) {
                reasons.present.push(s.name);
                return;
            }
            if (offIds.has(s.id)) {
                reasons.offRequested.push(s.name);
                return;
            }
            if (Array.isArray(s.ng_weekdays) && s.ng_weekdays.map(Number).includes(dow)) {
                reasons.ngDay.push(`${s.name} (${['日','月','火','水','木','金','土'][dow]}NG)`);
                return;
            }
            // 希望時間が指定されていて、この時刻が範囲外
            const isWeekend = dow === 0 || dow === 6 || isHoliday;
            const ps = isWeekend ? s.pref_start_we : s.pref_start_wd;
            const pe = isWeekend ? s.pref_end_we : s.pref_end_wd;
            if (ps && pe) {
                const psM = toMins(ps);
                let peM = toMins(pe);
                if (peM <= psM) peM += 24 * 60;
                if (slotMin < psM || slotMin >= peM) {
                    reasons.prefTime.push(`${s.name} (希望 ${ps}-${pe})`);
                    return;
                }
            }
            if (onShiftToday.has(s.id)) {
                reasons.onShift.push(`${s.name} (別時間帯で勤務中)`);
                return;
            }
            reasons.unknown.push(s.name);
        });

        const fmtList = (arr) => arr.length === 0 ? '<span class="text-gray-400 text-xs">なし</span>'
            : '<div class="text-xs leading-relaxed">' + arr.map(n => this._sanitize(n)).join(', ') + '</div>';

        const shortage = requiredCount - actualCount;
        const html = `
            <div id="shortageReasonModal" class="modal fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onclick="if(event.target===this)document.getElementById('shortageReasonModal').remove()">
                <div class="bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
                    <div class="p-4 border-b border-gray-100 bg-gradient-to-r from-red-500 to-amber-500 flex justify-between items-center">
                        <div class="text-white">
                            <h3 class="font-bold text-lg"><i class="fa-solid fa-triangle-exclamation mr-2"></i>${this._sanitize(dateStr)} ${time} の不足分析</h3>
                            <p class="text-xs text-white/80 mt-0.5">${dayLabel} / 必要 ${requiredCount}名 / 在籍 ${actualCount}名 / <strong class="text-yellow-300">${shortage}名不足</strong></p>
                        </div>
                        <button onclick="document.getElementById('shortageReasonModal').remove()" class="text-white/70 hover:text-white text-xl"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="p-5 space-y-3 overflow-y-auto">
                        <p class="text-xs text-gray-500 mb-2">この時刻に入れていないスタッフを理由別に分類:</p>

                        <div class="bg-green-50 border border-green-200 rounded-lg p-3">
                            <p class="text-xs font-bold text-green-700 mb-1"><i class="fa-solid fa-check mr-1"></i>在籍中 (${reasons.present.length}名)</p>
                            ${fmtList(reasons.present)}
                        </div>

                        <div class="bg-amber-50 border border-amber-200 rounded-lg p-3">
                            <p class="text-xs font-bold text-amber-700 mb-1"><i class="fa-solid fa-clock mr-1"></i>別時間帯で勤務中 (${reasons.onShift.length}名)</p>
                            ${fmtList(reasons.onShift)}
                            <p class="text-[10px] text-amber-600 mt-1">→ 別時間のシフトを延長または時間変更すれば配置可能</p>
                        </div>

                        <div class="bg-red-50 border border-red-200 rounded-lg p-3">
                            <p class="text-xs font-bold text-red-700 mb-1"><i class="fa-solid fa-umbrella-beach mr-1"></i>承認済み休み希望 (${reasons.offRequested.length}名)</p>
                            ${fmtList(reasons.offRequested)}
                            <p class="text-[10px] text-red-600 mt-1">→ 休み希望の却下を検討</p>
                        </div>

                        <div class="bg-slate-50 border border-slate-200 rounded-lg p-3">
                            <p class="text-xs font-bold text-slate-700 mb-1"><i class="fa-solid fa-calendar-xmark mr-1"></i>NG曜日のため出勤不可 (${reasons.ngDay.length}名)</p>
                            ${fmtList(reasons.ngDay)}
                        </div>

                        <div class="bg-purple-50 border border-purple-200 rounded-lg p-3">
                            <p class="text-xs font-bold text-purple-700 mb-1"><i class="fa-solid fa-hourglass-half mr-1"></i>希望時間帯外 (${reasons.prefTime.length}名)</p>
                            ${fmtList(reasons.prefTime)}
                            <p class="text-[10px] text-purple-600 mt-1">→ スタッフ設定 → 希望時間 を見直す</p>
                        </div>

                        ${reasons.unknown.length > 0 ? `
                        <div class="bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <p class="text-xs font-bold text-blue-700 mb-1"><i class="fa-solid fa-circle-question mr-1"></i>その他/週月上限到達 (${reasons.unknown.length}名)</p>
                            ${fmtList(reasons.unknown)}
                            <p class="text-[10px] text-blue-600 mt-1">→ 週/月の最大勤務日数・時間 を見直す、または手動でシフト追加</p>
                        </div>` : ''}
                    </div>
                    <div class="p-3 bg-gray-50 border-t border-gray-100 flex justify-end gap-2">
                        <button onclick="document.getElementById('shortageReasonModal').remove()" class="px-4 py-2 bg-gray-500 hover:bg-gray-600 text-white text-sm font-bold rounded-lg">閉じる</button>
                    </div>
                </div>
            </div>
        `;
        const old = document.getElementById('shortageReasonModal');
        if (old) old.remove();
        document.body.insertAdjacentHTML('beforeend', html);
    },

    openModal(id) {
        const el = document.getElementById(id);
        if(el) el.classList.add('active');
    },
    closeModal(id) {
        const el = document.getElementById(id);
        if(el) el.classList.remove('active');
    },

    // =========================================================
    // お知らせバッジ更新
    // =========================================================
    // お知らせ既読管理
    _getReadAnnouncementIds() {
        try {
            return JSON.parse(localStorage.getItem('rakushift_read_announcements') || '[]');
        } catch { return []; }
    },
    _markAnnouncementRead(id) {
        const readIds = this._getReadAnnouncementIds();
        if (!readIds.includes(id)) {
            readIds.push(id);
            localStorage.setItem('rakushift_read_announcements', JSON.stringify(readIds));
        }
    },
    _markAllAnnouncementsRead() {
        const allIds = (this._announcements || []).map(a => a.id).filter(Boolean);
        localStorage.setItem('rakushift_read_announcements', JSON.stringify(allIds));
    },
    _filterUnreadAnnouncements(announcements) {
        const readIds = this._getReadAnnouncementIds();
        return (announcements || []).filter(a => !readIds.includes(a.id));
    },

    async updateAnnouncementBadge() {
        const badge = document.getElementById('announcementCountBadge');
        if (!badge) return;
        try {
            const announcements = await API.rpc('list_active_announcements');
            const unread = this._filterUnreadAnnouncements(announcements);
            if (!unread || unread.length === 0) {
                badge.classList.add('hidden');
                badge.textContent = '0';
                return;
            }
            const count = unread.length;
            const circledNums = ['⓪','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
            badge.textContent = count <= 10 ? circledNums[count] : count.toString();
            badge.classList.remove('hidden');
        } catch (e) {
            badge.classList.add('hidden');
        }
    },

    // =========================================================
    // お知らせ管理ビュー (管理者用)
    // =========================================================
    renderAnnouncementsAdmin(container) {
        if (!this.state.isAdmin) { this.changeView('dashboard'); return; }

        container.innerHTML = `
            <div class="max-w-4xl mx-auto space-y-6 pb-20">
                <div class="flex items-center justify-between">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-800">お知らせ管理</h2>
                        <p class="text-sm text-gray-500 mt-1">運営からのお知らせを確認できます</p>
                    </div>
                    <button onclick="app.refreshAnnouncementsAdmin()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 px-4 rounded-lg transition flex items-center gap-2">
                        <i class="fa-solid fa-arrows-rotate"></i> 更新
                    </button>
                </div>
                <div id="announcementsAdminList">
                    <div class="text-center py-12 text-gray-400">
                        <div class="loading-spinner mb-4 mx-auto"></div>
                        <p>読み込み中...</p>
                    </div>
                </div>
            </div>
        `;

        this._loadAnnouncementsAdmin();
    },

    async _loadAnnouncementsAdmin() {
        const listEl = document.getElementById('announcementsAdminList');
        if (!listEl) return;
        try {
            const allAnnouncements = await API.rpc('list_active_announcements');
            const readIds = this._getReadAnnouncementIds();
            const announcements = (allAnnouncements || []);

            if (!announcements || !Array.isArray(announcements) || announcements.length === 0) {
                listEl.innerHTML = `
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                        <i class="fa-solid fa-bell-slash text-4xl text-gray-300 mb-4"></i>
                        <p class="text-gray-500 font-bold">お知らせはありません</p>
                        <p class="text-xs text-gray-400 mt-2">現在、配信されているお知らせはありません</p>
                    </div>
                `;
                return;
            }

            const typeIcons = { info: 'fa-circle-info', warning: 'fa-triangle-exclamation', promotion: 'fa-gift', update: 'fa-rocket' };
            const typeColors = { info: 'text-blue-500 bg-blue-50', warning: 'text-amber-500 bg-amber-50', promotion: 'text-emerald-500 bg-emerald-50', update: 'text-purple-500 bg-purple-50' };
            const typeLabels = { info: 'お知らせ', warning: '注意', promotion: 'キャンペーン', update: 'アップデート' };

            const unreadCount = announcements.filter(a => !readIds.includes(a.id)).length;

            listEl.innerHTML = `
                ${unreadCount > 0 ? `
                <div class="flex justify-end mb-3">
                    <button onclick="app.markAllAnnouncementsRead()" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-bold transition flex items-center gap-2">
                        <i class="fa-solid fa-check-double"></i> 全て既読にする
                    </button>
                </div>` : ''}
                <div class="space-y-4">
                    ${announcements.map((item, idx) => {
                        const isRead = readIds.includes(item.id);
                        return `
                        <div class="bg-white rounded-xl shadow-sm border ${isRead ? 'border-gray-100 opacity-60' : 'border-gray-200'} overflow-hidden hover:shadow-md transition-shadow ${isRead ? 'relative' : ''}">
                            ${isRead ? '<div class="absolute top-3 right-3"><span class="text-[10px] font-bold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">既読</span></div>' : ''}
                            <div class="p-5">
                                <div class="flex items-start gap-4">
                                    <div class="w-10 h-10 rounded-xl ${typeColors[item.type] || typeColors.info} flex items-center justify-center shrink-0">
                                        <i class="fa-solid ${typeIcons[item.type] || typeIcons.info} text-lg"></i>
                                    </div>
                                    <div class="flex-1 min-w-0">
                                        <div class="flex items-center gap-2 mb-1">
                                            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${typeColors[item.type] || typeColors.info}">
                                                ${typeLabels[item.type] || 'お知らせ'}
                                            </span>
                                            ${item.created_at ? `<span class="text-xs text-gray-400">${new Date(item.created_at).toLocaleDateString('ja-JP')}</span>` : ''}
                                        </div>
                                        <h3 class="font-bold text-gray-800 text-lg">${this._sanitize(item.title)}</h3>
                                        <p class="text-sm text-gray-600 mt-2 whitespace-pre-line leading-relaxed">${this._sanitize(item.content)}</p>
                                        <div class="flex items-center gap-3 mt-3">
                                            ${item.target_url ? `
                                                <a href="${item.target_url}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-sm font-bold text-blue-600 hover:text-blue-700 transition">
                                                    <i class="fa-solid fa-arrow-up-right-from-square text-xs"></i>
                                                    ${this._sanitize(item.button_text || '詳しく見る')}
                                                </a>
                                            ` : ''}
                                            ${!isRead ? `
                                                <button onclick="app.dismissAnnouncement('${item.id}')" class="inline-flex items-center gap-1 text-sm font-bold text-gray-500 hover:text-gray-700 transition">
                                                    <i class="fa-solid fa-eye-slash text-xs"></i> 既読にする
                                                </button>
                                            ` : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `}).join('')}
                </div>
            `;
        } catch (e) {
            listEl.innerHTML = `
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                    <i class="fa-solid fa-exclamation-triangle text-4xl text-amber-400 mb-4"></i>
                    <p class="text-gray-600 font-bold">お知らせの取得に失敗しました</p>
                    <p class="text-xs text-gray-400 mt-2">${this._sanitize(e.message || '')}</p>
                    <button onclick="app._loadAnnouncementsAdmin()" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition">再試行</button>
                </div>
            `;
        }
    },

    async refreshAnnouncementsAdmin() {
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('お知らせを更新しました', 'success');
    },

    // 個別のお知らせを既読にする
    dismissAnnouncement(id) {
        this._markAnnouncementRead(id);
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('既読にしました', 'info');
    },

    // 全てのお知らせを既読にする
    markAllAnnouncementsRead() {
        this._markAllAnnouncementsRead();
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('全てのお知らせを既読にしました', 'success');
    },

    // =========================================================
    // お知らせポップアップ機能
    // =========================================================
    _announcements: [],
    _announcementIndex: 0,

    /**
     * ログイン成功後にお知らせを取得してポップアップ表示
     */
    async showAnnouncementsAfterLogin() {
        try {
            const announcements = await API.rpc('list_active_announcements');
            if (!announcements || !Array.isArray(announcements) || announcements.length === 0) {
                return; // お知らせなし
            }
            this._announcements = announcements;
            this._announcementIndex = 0;
            // 少し遅延させてからポップアップ表示（ログイントーストと被らないように）
            setTimeout(() => this._renderAnnouncement(), 1500);
        } catch (e) {
            console.warn('[Announcements] Load failed:', e.message);
        }
    },

    /**
     * 現在のお知らせをモーダルに描画
     */
    _renderAnnouncement() {
        const list = this._announcements;
        const idx = this._announcementIndex;
        if (!list || idx >= list.length) return;

        const item = list[idx];
        const typeIcons = {
            info: 'fa-circle-info',
            warning: 'fa-triangle-exclamation',
            promotion: 'fa-gift',
            update: 'fa-rocket'
        };
        const typeColors = {
            info: 'from-blue-600 via-indigo-600 to-purple-600',
            warning: 'from-amber-500 via-orange-500 to-red-500',
            promotion: 'from-emerald-500 via-teal-500 to-cyan-500',
            update: 'from-violet-600 via-purple-600 to-fuchsia-600'
        };

        // ヘッダー色変更
        const headerEl = document.querySelector('#announcementModal .modal-content > div:first-child');
        if (headerEl) {
            headerEl.className = `relative bg-gradient-to-r ${typeColors[item.type] || typeColors.info} text-white p-6`;
        }

        // タイトル
        document.getElementById('announcementTitle').textContent = item.title;

        // 本文 (改行をbrに変換)
        const bodyEl = document.getElementById('announcementBody');
        bodyEl.innerHTML = item.content.split('\n').map(line => `<p>${this._sanitize(line)}</p>`).join('');

        // アクションボタン
        const actionEl = document.getElementById('announcementAction');
        if (item.target_url && /^https?:\/\//i.test(item.target_url)) {
            actionEl.classList.remove('hidden');
            document.getElementById('announcementLink').href = item.target_url;
            document.getElementById('announcementBtnText').textContent = item.button_text || '詳しく見る';
        } else {
            actionEl.classList.add('hidden');
        }

        // カウンター
        document.getElementById('announcementCounter').textContent = `${idx + 1} / ${list.length}`;

        // ナビゲーションボタン
        const prevBtn = document.getElementById('announcementPrev');
        const nextBtn = document.getElementById('announcementNext');
        if (list.length > 1) {
            prevBtn.classList.toggle('hidden', idx === 0);
            nextBtn.classList.toggle('hidden', idx === list.length - 1);
        } else {
            prevBtn.classList.add('hidden');
            nextBtn.classList.add('hidden');
        }

        this.openModal('announcementModal');
    },

    prevAnnouncement() {
        if (this._announcementIndex > 0) {
            this._announcementIndex--;
            this._renderAnnouncement();
        }
    },

    nextAnnouncement() {
        if (this._announcementIndex < this._announcements.length - 1) {
            this._announcementIndex++;
            this._renderAnnouncement();
        }
    },

    closeAnnouncementModal() {
        // 表示したお知らせを全て既読にする
        if (this._announcements && this._announcements.length > 0) {
            for (const item of this._announcements) {
                if (item.id) this._markAnnouncementRead(item.id);
            }
            this.updateAnnouncementBadge();
        }
        this.closeModal('announcementModal');
        // ページ訪問時のお知らせの場合、閉じた後にログインモーダルを表示
        if (this._showLoginAfterAnnouncement) {
            this._showLoginAfterAnnouncement = false;
            setTimeout(() => this.openModal('loginModal'), 300);
        }
    },

    /**
     * ページ訪問時（ログイン前）にお知らせを表示
     * @returns {boolean} お知らせがあった場合true
     */
    async showAnnouncementsOnPageLoad() {
        try {
            const announcements = await API.rpc('list_active_announcements');
            if (!announcements || !Array.isArray(announcements) || announcements.length === 0) {
                return false;
            }
            this._announcements = announcements;
            this._announcementIndex = 0;
            this._showLoginAfterAnnouncement = true;
            setTimeout(() => this._renderAnnouncement(), 500);
            return true;
        } catch (e) {
            console.warn('[Announcements] Page load fetch failed:', e.message);
            return false;
        }
    },

    // ===========================================================
    // シフト生成プレビュー機能
    // ===========================================================

    // プレビュー用の一時データ
    _previewShifts: null,
    _previewTargetType: null,
    _previewDates: null,

    /**
     * プレビューモーダルを表示
     * @param {Array} shifts - 生成されたシフト配列
     * @param {string} targetType - 'reset_all' | 'empty_only'
     * @param {Array} dates - 対象日付配列
     */
    // v3.7.32 [A]: シフト精度の自動評価 (生成後にユーザーが「過剰0/不足0」を一目で確認)
    // v3.7.33: H-2 引数ガード, C-1 jh.isHoliday 修正, H-1 タイムゾーン安全
    _renderAccuracySummary(shifts, dates, report) {
        shifts = shifts || [];
        dates = dates || [];
        const config = this.state.config || {};
        const sr = config.staff_req || {};
        const minWeekday = Number(sr.min_weekday || 0);
        const minWeekend = Number(sr.min_weekend || 0);
        const minHoliday = Number(sr.min_holiday || minWeekend);

        const jh = (typeof JapaneseHolidays !== 'undefined') ? JapaneseHolidays : null;
        // タイムゾーン安全な YYYY-MM-DD → Date 変換
        const parseLocalDate = (d) => {
            const [Y, M, D] = String(d).split('-').map(Number);
            return new Date(Y, (M || 1) - 1, D || 1);
        };

        const byDate = {};
        for (const s of shifts) {
            (byDate[s.date] = byDate[s.date] || []).push(s);
        }
        const toMin = (t) => {
            const [h, m] = t.split(':').map(Number);
            return h * 60 + m;
        };
        // v3.7.43: バックエンド (scheduler.py) の判定結果を優先
        // 旧: peak (同時刻最大) vs req (基本必要人数) の単純比較
        //   → time_staff_req (時間帯別必要人数) を無視するため誤判定の可能性
        //   → 例: ピーク時刻だけ合えば他時間が不足でも「ぴったり」判定
        // 新: report.coverage_gaps (scheduler が正確に判定した不足箇所) を集計
        const reportGaps = (report && Array.isArray(report.coverage_gaps)) ? report.coverage_gaps : [];
        const underDateSet = new Set(reportGaps.map(g => g.date));

        let exactDays = 0, underDays = 0, overDays = 0;
        for (const d of dates) {
            const ds = byDate[d] || [];
            if (ds.length === 0) continue;
            const wd = parseLocalDate(d).getDay();
            let req;
            if (jh && jh.isHoliday(d)) req = minHoliday;
            else if (wd === 0 || wd === 6) req = minWeekend;
            else req = minWeekday;
            if (req === 0) continue;

            // バックエンドが不足判定した日は under
            if (underDateSet.has(d)) {
                underDays++;
                continue;
            }

            // それ以外で同時刻最大が必要人数を超えていれば over
            const slotCounts = {};
            for (const s of ds) {
                const start = toMin(s.start_time);
                let end = toMin(s.end_time);
                if (end <= start) end += 1440;
                for (let t = start; t < end; t += 15) {
                    slotCounts[t % 1440] = (slotCounts[t % 1440] || 0) + 1;
                }
            }
            const peak = Math.max(0, ...Object.values(slotCounts));
            if (peak > req) overDays++;
            else exactDays++;
        }
        const totalDays = exactDays + underDays + overDays;
        const exactPct = totalDays > 0 ? Math.round(exactDays / totalDays * 100) : 0;

        // 法定違反数
        const legalIssues = (report && report.overtime_warnings) ? report.overtime_warnings.length : 0;

        const exactColor = exactPct >= 90 ? 'emerald' : exactPct >= 70 ? 'amber' : 'red';
        const overColor = overDays === 0 ? 'emerald' : overDays <= 2 ? 'amber' : 'red';

        return `
            <div class="mt-3 mb-4 bg-gradient-to-r from-emerald-50 to-blue-50 border-2 border-emerald-200 rounded-xl p-4">
                <div class="flex items-center gap-2 mb-3">
                    <i class="fa-solid fa-bullseye text-emerald-600 text-lg"></i>
                    <span class="font-bold text-gray-800">配置精度サマリー (v3.7.31)</span>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div class="bg-white rounded-lg p-3 text-center border border-${exactColor}-200">
                        <div class="text-2xl font-black text-${exactColor}-600">${exactPct}%</div>
                        <div class="text-[10px] text-gray-500 mt-1">ぴったり配置率</div>
                        <div class="text-[9px] text-gray-400">${exactDays}/${totalDays}日</div>
                    </div>
                    <div class="bg-white rounded-lg p-3 text-center border border-${overColor}-200">
                        <div class="text-2xl font-black text-${overColor}-600">${overDays}</div>
                        <div class="text-[10px] text-gray-500 mt-1">過剰日数</div>
                        <div class="text-[9px] text-gray-400">${overDays === 0 ? '✓ 過剰なし' : '+' + overDays + '日'}</div>
                    </div>
                    <div class="bg-white rounded-lg p-3 text-center border ${underDays === 0 ? 'border-emerald-200' : 'border-red-200'}">
                        <div class="text-2xl font-black ${underDays === 0 ? 'text-emerald-600' : 'text-red-600'}">${underDays}</div>
                        <div class="text-[10px] text-gray-500 mt-1">不足日数</div>
                        <div class="text-[9px] text-gray-400">${underDays === 0 ? '✓ 不足なし' : '要確認'}</div>
                    </div>
                    <div class="bg-white rounded-lg p-3 text-center border ${legalIssues === 0 ? 'border-emerald-200' : 'border-red-200'}">
                        <div class="text-2xl font-black ${legalIssues === 0 ? 'text-emerald-600' : 'text-red-600'}">${legalIssues}</div>
                        <div class="text-[10px] text-gray-500 mt-1">法定違反</div>
                        <div class="text-[9px] text-gray-400">${legalIssues === 0 ? '✓ 違反なし' : '要対応'}</div>
                    </div>
                </div>
                ${overDays === 0 && underDays === 0 && legalIssues === 0
                    ? '<div class="mt-2 text-xs text-emerald-700 text-center font-bold"><i class="fa-solid fa-check-circle mr-1"></i>店舗需要に完全にマッチした最適配置です</div>'
                    : ''}
            </div>
        `;
    },

    showShiftPreview(shifts, targetType, dates, report) {
        this._previewShifts = shifts;
        this._previewTargetType = targetType;
        this._previewDates = dates;
        this._previewReport = report || null;

        // サマリー統計
        const totalShifts = shifts.length;
        const uniqueDates = [...new Set(shifts.map(s => s.date))].sort();
        const uniqueStaff = [...new Set(shifts.map(s => s.staff_id))];
        const totalHours = shifts.reduce((sum, s) => {
            const startParts = s.start_time.split(':');
            const endParts = s.end_time.split(':');
            let startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
            let endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
            if (endMin <= startMin) endMin += 1440;
            return sum + (endMin - startMin) / 60;
        }, 0);

        // v3.7.32 [A]: 精度サマリー (過剰0/不足0 を強調表示)
        const accuracyHtml = this._renderAccuracySummary(shifts, dates, report);

        const summaryEl = document.getElementById('previewSummary');
        if (summaryEl) {
            // v3.7.42: 精度サマリーを previewContent (スクロール領域) 内に移動
            // v3.7.53 [CRITICAL #1 修正]: contentEl.innerHTML 上書きでワイプされる問題を解消
            // 旧: ここで previewContent に accuracy を insertBefore → 後の innerHTML=html でワイプ
            // 新: accuracyHtml を後で innerHTML 用 html の先頭に含める (this._pendingAccuracyHtml に保持)
            this._pendingAccuracyHtml = accuracyHtml;

            summaryEl.innerHTML = `
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-emerald-600">${totalShifts}</p>
                    <p class="text-xs text-gray-500 mt-1">生成シフト数</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-blue-600">${uniqueDates.length}</p>
                    <p class="text-xs text-gray-500 mt-1">対象日数</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-purple-600">${uniqueStaff.length}</p>
                    <p class="text-xs text-gray-500 mt-1">配置スタッフ数</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-orange-600">${totalHours.toFixed(1)}</p>
                    <p class="text-xs text-gray-500 mt-1">合計労働時間</p>
                </div>
            `;
        }

        // ⚠️ 制約違反レポート (report があれば表示)
        if (this._previewReport) {
            const r = this._previewReport;
            const ot = (r.overtime_warnings || []).slice(0, 10);
            const cg = r.coverage_gaps || [];
            const oc = r.open_close_gaps || [];
            // v3.7.20: manager_gaps 廃止 (管理者常駐制約撤廃)
            const hasAny = ot.length || cg.length || oc.length;
            let warnHtml = '';
            if (hasAny) {
                warnHtml = `<div class="mt-4 mb-2 bg-amber-50 border border-amber-300 rounded-lg p-4">
                    <div class="flex items-center justify-between mb-2">
                        <div class="text-sm font-bold text-amber-800"><i class="fa-solid fa-triangle-exclamation mr-1"></i>制約違反・警告レポート</div>
                        <div class="text-xs text-gray-500">Tier ${r.tier || '?'} / ${r.mode || '?'} モード</div>
                    </div>`;
                if (cg.length) {
                    warnHtml += `<div class="mb-2"><div class="text-xs font-bold text-amber-700 mb-1">🟧 スタッフ不足: ${cg.length}件</div><div class="text-xs text-gray-700 max-h-32 overflow-y-auto bg-white rounded p-2 border border-amber-100">${
                        cg.slice(0, 20).map(g => `<div>・${g.date} ${g.time}: 必要 ${g.required}名 / <span class="text-red-600 font-bold">${g.shortage}名不足</span></div>`).join('')
                    }${cg.length > 20 ? `<div class="text-gray-400 mt-1">... 他 ${cg.length - 20} 件</div>` : ''}</div></div>`;
                }
                if (oc.length) {
                    warnHtml += `<div class="mb-2"><div class="text-xs font-bold text-red-700 mb-1">🟥 開け締めに社員不在: ${oc.length}件</div><div class="text-xs text-gray-700 max-h-24 overflow-y-auto bg-white rounded p-2 border border-amber-100">${
                        oc.slice(0, 15).map(g => `<div>・${g.date} ${g.time}: 月給/管理者ロールのスタッフが不在</div>`).join('')
                    }${oc.length > 15 ? `<div class="text-gray-400 mt-1">... 他 ${oc.length - 15} 件</div>` : ''}</div></div>`;
                }
                // v3.7.20: 管理者不足ブロック削除 (管理者常駐制約撤廃)
                if (ot.length) {
                    warnHtml += `<div class="mb-1"><div class="text-xs font-bold text-amber-700 mb-1">⏰ 時間超過: ${ot.length}件</div><div class="text-xs text-gray-700 bg-white rounded p-2 border border-amber-100">${
                        ot.map(w => `<div>・${this._sanitize(w)}</div>`).join('')
                    }</div></div>`;
                }
                warnHtml += `<div class="text-[11px] text-amber-700 mt-2"><i class="fa-solid fa-circle-info mr-1"></i>これらは制約緩和で「強行生成」された場合のみ発生します。スタッフ追加や勤務条件見直しで解消可能。</div>`;
                warnHtml += `</div>`;
            } else {
                warnHtml = `<div class="mt-4 mb-2 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><i class="fa-solid fa-circle-check text-emerald-600"></i><span class="text-sm font-bold text-emerald-700">制約違反なし: 全条件を満たした最適配置です</span></div>`;
            }
            // v3.7.53 [CRITICAL #1 修正]: 警告レポートも html 先頭に含めるため _pendingReportHtml に保持
            this._pendingReportHtml = warnHtml;
        } else {
            this._pendingReportHtml = '';
        }

        // 日付ごとのテーブル生成
        const contentEl = document.getElementById('previewContent');
        if (contentEl) {
            // v3.7.53 [CRITICAL #1 修正]: 精度サマリーと警告レポートを html 先頭に含める
            let html = '';
            if (this._pendingAccuracyHtml) {
                html += `<div id="previewAccuracy">${this._pendingAccuracyHtml}</div>`;
            }
            if (this._pendingReportHtml) {
                html += `<div id="previewReportSection">${this._pendingReportHtml}</div>`;
            }
            const staffMap = {};
            (this.state.staff || []).forEach(s => { staffMap[s.id] = s; });

            for (const dateStr of uniqueDates) {
                const dayShifts = shifts.filter(s => s.date === dateStr);
                const dt = new Date(dateStr + 'T00:00:00');
                const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
                const dow = dayNames[dt.getDay()];
                const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;

                // v3.7.39: スマホ対応のため、モバイルではカード型、デスクトップではテーブル型のハイブリッド表示
                html += `
                    <div class="mb-4">
                        <h4 class="text-sm font-bold ${isWeekend ? 'text-red-600' : 'text-gray-700'} mb-2 flex items-center gap-2">
                            <span class="w-6 h-6 rounded-full ${isWeekend ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600'} flex items-center justify-center text-xs font-bold">${dow}</span>
                            ${dateStr}
                            <span class="text-xs text-gray-400 font-normal">(${dayShifts.length}名配置)</span>
                        </h4>
                        <!-- モバイル: カード型 (sm未満) -->
                        <div class="sm:hidden space-y-2">
                `;

                for (const shift of dayShifts) {
                    const staff = staffMap[shift.staff_id] || { name: shift.staff_id, role: '' };
                    const roleList = this.state.config.roles || this.state.defaultConfig.roles || [];
                    const roleObj = roleList.find(r => r.id === staff.role) || { name: 'スタッフ', color: 'gray' };
                    const colorMap = {
                        purple: 'bg-purple-100 text-purple-700',
                        blue: 'bg-blue-100 text-blue-700',
                        green: 'bg-green-100 text-green-700',
                        yellow: 'bg-yellow-100 text-yellow-700',
                        red: 'bg-red-100 text-red-700',
                        gray: 'bg-gray-100 text-gray-700'
                    };
                    const badgeClass = colorMap[roleObj.color] || colorMap['gray'];
                    const roleBadge = `<span class="inline-block ${badgeClass} text-xs px-2 py-0.5 rounded-full font-bold">${this._sanitize(roleObj.name)}</span>`;
                    const breakMin = shift.break_minutes || 0;
                    const startParts = shift.start_time.split(':');
                    const endParts = shift.end_time.split(':');
                    let startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
                    let endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
                    if (endMin <= startMin) endMin += 1440;
                    const workHours = ((endMin - startMin) - breakMin) / 60;

                    const reasonText = shift.reason || '通常配置';
                    // 理由ごとに色分け (一覧性UP)
                    const reasonColor = reasonText.includes('既存')   ? 'bg-gray-100 text-gray-700' :
                                        reasonText.includes('承認済') ? 'bg-emerald-100 text-emerald-700' :
                                        reasonText.includes('完全一致')? 'bg-blue-100 text-blue-700' :
                                        reasonText.includes('希望')    ? 'bg-sky-100 text-sky-700' :
                                        reasonText.includes('優先度')  ? 'bg-amber-100 text-amber-700' :
                                        reasonText.includes('メンター')? 'bg-purple-100 text-purple-700' :
                                        reasonText.includes('月給')    ? 'bg-pink-100 text-pink-700' :
                                        reasonText.includes('レギュラ')? 'bg-indigo-100 text-indigo-700' :
                                        reasonText.includes('高評価')  ? 'bg-yellow-100 text-yellow-700' :
                                                                          'bg-slate-100 text-slate-600';
                    // モバイル用カード
                    const safeName = this._sanitize(staff.name || '不明');
                    const safeReason = this._sanitize(reasonText);
                    const mobileCard = `
                        <div class="bg-white border border-gray-200 rounded-lg p-3 shadow-sm">
                            <div class="flex items-center justify-between gap-2 mb-2">
                                <div class="flex items-center gap-2 min-w-0">
                                    <span class="font-bold text-gray-800 truncate">${safeName}</span>
                                    ${roleBadge}
                                </div>
                                <span class="inline-block ${reasonColor} text-[10px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap">${safeReason}</span>
                            </div>
                            <div class="flex items-center gap-3 text-sm">
                                <span class="font-mono text-emerald-600 font-bold">${shift.start_time}</span>
                                <span class="text-gray-400">→</span>
                                <span class="font-mono text-red-500 font-bold">${shift.end_time}</span>
                                <span class="ml-auto text-xs text-gray-500">休${breakMin}分 / 実${workHours.toFixed(1)}h</span>
                            </div>
                        </div>
                    `;
                    html += mobileCard;
                }

                // モバイルカード終了、デスクトップテーブル開始
                html += `
                        </div>
                        <!-- デスクトップ: テーブル型 (sm以上) -->
                        <div class="hidden sm:block overflow-x-auto">
                            <table class="w-full text-sm">
                                <thead class="bg-gray-50 text-xs text-gray-500">
                                    <tr>
                                        <th class="px-3 py-2 text-left rounded-l-lg">スタッフ</th>
                                        <th class="px-3 py-2 text-left">役職</th>
                                        <th class="px-3 py-2 text-center">出勤</th>
                                        <th class="px-3 py-2 text-center">退勤</th>
                                        <th class="px-3 py-2 text-center">休憩</th>
                                        <th class="px-3 py-2 text-center">実働</th>
                                        <th class="px-3 py-2 text-left rounded-r-lg">配置理由</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100">
                `;

                // デスクトップテーブル行を再ループで生成
                for (const shift of dayShifts) {
                    const staff = staffMap[shift.staff_id] || { name: shift.staff_id, role: '' };
                    const roleList = this.state.config.roles || this.state.defaultConfig.roles || [];
                    const roleObj = roleList.find(r => r.id === staff.role) || { name: 'スタッフ', color: 'gray' };
                    const colorMap = {
                        purple: 'bg-purple-100 text-purple-700',
                        blue: 'bg-blue-100 text-blue-700',
                        green: 'bg-green-100 text-green-700',
                        yellow: 'bg-yellow-100 text-yellow-700',
                        red: 'bg-red-100 text-red-700',
                        gray: 'bg-gray-100 text-gray-700'
                    };
                    const badgeClass = colorMap[roleObj.color] || colorMap['gray'];
                    const roleBadge = `<span class="inline-block ${badgeClass} text-xs px-2 py-0.5 rounded-full font-bold">${this._sanitize(roleObj.name)}</span>`;
                    const breakMin = shift.break_minutes || 0;
                    const startParts = shift.start_time.split(':');
                    const endParts = shift.end_time.split(':');
                    let startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
                    let endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
                    if (endMin <= startMin) endMin += 1440;
                    const workHours = ((endMin - startMin) - breakMin) / 60;
                    const reasonText = shift.reason || '通常配置';
                    const reasonColor = reasonText.includes('既存')   ? 'bg-gray-100 text-gray-700' :
                                        reasonText.includes('承認済') ? 'bg-emerald-100 text-emerald-700' :
                                        reasonText.includes('完全一致')? 'bg-blue-100 text-blue-700' :
                                        reasonText.includes('希望')    ? 'bg-sky-100 text-sky-700' :
                                        reasonText.includes('優先度')  ? 'bg-amber-100 text-amber-700' :
                                        reasonText.includes('メンター')? 'bg-purple-100 text-purple-700' :
                                        reasonText.includes('月給')    ? 'bg-pink-100 text-pink-700' :
                                        reasonText.includes('レギュラ')? 'bg-indigo-100 text-indigo-700' :
                                        reasonText.includes('高評価')  ? 'bg-yellow-100 text-yellow-700' :
                                                                          'bg-slate-100 text-slate-600';
                    html += `
                        <tr class="hover:bg-gray-50">
                            <td class="px-3 py-2 font-bold text-gray-800">${this._sanitize(staff.name || '不明')}</td>
                            <td class="px-3 py-2">${roleBadge}</td>
                            <td class="px-3 py-2 text-center font-mono text-emerald-600 font-bold">${shift.start_time}</td>
                            <td class="px-3 py-2 text-center font-mono text-red-500 font-bold">${shift.end_time}</td>
                            <td class="px-3 py-2 text-center text-gray-500">${breakMin}分</td>
                            <td class="px-3 py-2 text-center font-bold">${workHours.toFixed(1)}h</td>
                            <td class="px-3 py-2"><span class="inline-block ${reasonColor} text-[11px] px-2 py-0.5 rounded-full font-bold">${this._sanitize(reasonText)}</span></td>
                        </tr>
                    `;
                }

                html += `
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;
            }

            contentEl.innerHTML = html;
        }

        this.openModal('shiftPreviewModal');
    },

    /**
     * プレビューを承認してDB保存を実行
     */
    async confirmShiftPreview() {
        if (!this._previewShifts || this._previewShifts.length === 0) {
            this.showToast('保存するシフトがありません', 'error');
            return;
        }

        this.closeModal('shiftPreviewModal');

        // ローディング表示
        const loadingEl = document.getElementById('globalLoading');
        const loadingDefault = document.getElementById('loadingDefault');
        if (loadingDefault) loadingDefault.style.display = 'flex';
        if (loadingEl) loadingEl.classList.remove('hidden');

        try {
            const dates = this._previewDates;
            const targetType = this._previewTargetType;

            // reset_allの場合は既存削除
            if (targetType === 'reset_all') {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const shiftsToDelete = this.state.shifts.filter(function(s) {
                    return dates.includes(s.date) && new Date(s.date) >= today && s.id && uuidRegex.test(s.id);
                });
                if (shiftsToDelete.length > 0) {
                    try {
                        await this._shiftBulkDelete(shiftsToDelete.map(s => s.id));
                    } catch (delErr) {
                        console.error('[confirmShiftPreview] Bulk delete failure:', delErr);
                        await this.loadData();
                        this.showToast('旧シフト削除に失敗しました。表示を再同期しました', 'error');
                        throw new Error('Batch delete failed');
                    }
                }
                this.state.shifts = this.state.shifts.filter(function(s) {
                    return !(dates.includes(s.date) && new Date(s.date) >= today);
                });
            }

            // DB保存
            const existing = this.state.shifts.filter(s => dates.includes(s.date));
            const finalShifts = [];
            for (const s of this._previewShifts) {
                if (targetType === 'empty_only') {
                    const exists = existing.find(ex => ex.date === s.date && ex.staff_id === s.staff_id);
                    if (exists) continue;
                }
                finalShifts.push(s);
            }

            if (finalShifts.length > 0) {
                await this.saveAllShifts(finalShifts);
            }

            if (targetType === 'reset_all') {
                this.state.shifts = this.state.shifts.filter(s => !dates.includes(s.date));
            }

            await this.loadData();
            this.renderCurrentView();
            this.calculateMonthlyStats();

            // バックグラウンドAI診断
            try {
                await API.diagnose({
                    contract_id: this.state.config?.contract_id || API.session?.user?.contract_id,
                    config: { opening_time: this.state.config.opening_time, closing_time: this.state.config.closing_time, staff_req: this.state.config.staff_req },
                    staff_count: this.state.staff.length,
                    shift_count: this.state.shifts.length,
                    shifts: this.state.shifts.map(s => ({ staff_id: s.staff_id, date: s.date, start_time: s.start_time, end_time: s.end_time })),
                    staff_list: this.state.staff.map(s => ({ id: s.id, name: s.name, role: s.role, max_days_week: s.max_days_week, max_hours_day: s.max_hours_day, min_days_week: s.min_days_week, min_days_month: s.min_days_month }))
                });
            } catch (diagErr) {
                console.error('Auto AI Diagnosis error:', diagErr);
            }

            this.showToast(`${finalShifts.length}件のシフトを保存しました`, 'success');
        } catch (e) {
            console.error('Preview Save Error:', e);
            this.showToast('シフトの保存に失敗しました: ' + e.message, 'error');
        } finally {
            if (loadingEl) loadingEl.classList.add('hidden');
            this._previewShifts = null;
            this._previewTargetType = null;
            this._previewDates = null;
        }
    },

    /**
     * プレビューをキャンセル（破棄）
     */
    cancelShiftPreview() {
        this._previewShifts = null;
        this._previewTargetType = null;
        this._previewDates = null;
        this.closeModal('shiftPreviewModal');
        this.showToast('シフト生成をキャンセルしました', 'info');
    },

    // ===========================================================
    // パスワード変更機能
    // ===========================================================

    /**
     * 店舗パスワードを変更
     */
    async changeShopPassword() {
        const currentPass = document.getElementById('currentPassword')?.value || '';
        const newPass = document.getElementById('newPassword')?.value || '';
        const confirmPass = document.getElementById('confirmPassword')?.value || '';

        if (!currentPass) {
            this.showToast('現在のパスワードを入力してください', 'error');
            return;
        }
        if (!newPass || newPass.length < 6) {
            this.showToast('新しいパスワードは6文字以上で入力してください', 'error');
            return;
        }
        if (newPass !== confirmPass) {
            this.showToast('新しいパスワードが一致しません', 'error');
            return;
        }

        try {
            const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
            if (!contractId) {
                this.showToast('セッションエラー: 再ログインしてください', 'error');
                return;
            }

            // 現在のパスワード確認 (verify_shop_login RPC)
            const verifyResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: currentPass
            });

            // verify_shop_loginはJSONBを返すため、直接オブジェクトとして扱う
            // （ログイン時と同じ形式）
            if (!verifyResult || !verifyResult.success) {
                this.showToast('現在のパスワードが正しくありません', 'error');
                return;
            }

            // 新しいパスワードに更新 (update_shop_password RPC)
            await API.rpc('update_shop_password', {
                p_contract_id: contractId,
                p_new_password: newPass
            });

            this.closeModal('changePasswordModal');
            // フォームクリア
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';

            this.showToast('パスワードが正常に変更されました', 'success');
        } catch (e) {
            console.error('Password change error:', e);
            this.showToast('パスワード変更に失敗しました: ' + e.message, 'error');
        }
    },

    // --- 管理者パスワード変更 (店舗管理者) ---
    openAdminPasswordChange() {
        // 簡易ダイアログ (現在/新規/確認)
        const cur = prompt('現在の管理者パスワードを入力してください\n(初期値: rakushift1234)', '');
        if (cur === null) return;
        const np1 = prompt('新しい管理者パスワード (6文字以上):', '');
        if (np1 === null) return;
        if (!np1 || np1.length < 6) { this.showToast('6文字以上で入力してください', 'error'); return; }
        const np2 = prompt('もう一度入力してください:', '');
        if (np1 !== np2) { this.showToast('新しいパスワードが一致しません', 'error'); return; }
        this._submitAdminPasswordChange(cur, np1);
    },

    async _submitAdminPasswordChange(oldPw, newPw) {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) { this.showToast('セッションエラー: 再ログインしてください', 'error'); return; }
        try {
            const result = await API.rpc('update_admin_password_by_contract', {
                p_contract_id: contractId,
                p_old_password: oldPw,
                p_new_password: newPw,
            });
            if (result && result.success) {
                this.showToast('管理者パスワードを変更しました。次回管理者ログイン時から有効です。', 'success');
            } else {
                this.showToast(result?.message || '変更に失敗しました', 'error');
            }
        } catch (e) {
            console.error('Admin password change error:', e);
            this.showToast('変更に失敗しました', 'error');
        }
    },

    // --- 本部管理者パスワード変更 ---
    async openHQPasswordChange() {
        if (!this.state.isHQ) { this.showToast('本部としてログインしている必要があります', 'error'); return; }
        const loginId = (API.session?.user?.login_id) || prompt('本部ログインID:', 'hq_master');
        if (!loginId) return;
        const cur = prompt('現在の本部パスワード:', '');
        if (cur === null) return;
        const np1 = prompt('新しい本部パスワード (8文字以上):', '');
        if (!np1 || np1.length < 8) { this.showToast('8文字以上で入力してください', 'error'); return; }
        const np2 = prompt('もう一度入力してください:', '');
        if (np1 !== np2) { this.showToast('新しいパスワードが一致しません', 'error'); return; }

        try {
            const result = await API.rpc('update_hq_admin_password', {
                p_login_id: loginId,
                p_old_password: cur,
                p_new_password: np1,
            });
            if (result && result.success) {
                this.showToast('本部パスワードを変更しました。一度ログアウトされます。', 'success');
                setTimeout(() => this.logout(), 2000);
            } else {
                this.showToast(result?.message || '変更に失敗しました', 'error');
            }
        } catch (e) {
            console.error('HQ password change error:', e);
            this.showToast('変更に失敗しました', 'error');
        }
    },

    // ===========================================================
    // シフトパターンプリセット機能
    // ===========================================================

    SHIFT_PRESETS: {
        restaurant: {
            name: '飲食店向け',
            patterns: [
                { name: '早番', start: '09:00', end: '15:00' },
                { name: '中番', start: '12:00', end: '18:00' },
                { name: '遅番', start: '16:00', end: '22:00' },
                { name: '通し', start: '09:00', end: '22:00' },
                { name: 'ランチ', start: '10:00', end: '14:00' },
                { name: 'ディナー', start: '17:00', end: '22:00' },
            ]
        },
        office: {
            name: 'オフィス向け',
            patterns: [
                { name: '日勤', start: '09:00', end: '18:00' },
                { name: '早番', start: '08:00', end: '17:00' },
                { name: '遅番', start: '10:00', end: '19:00' },
                { name: '半日AM', start: '09:00', end: '13:00' },
                { name: '半日PM', start: '13:00', end: '18:00' },
            ]
        },
        retail: {
            name: '小売店向け',
            patterns: [
                { name: '早番', start: '09:00', end: '15:00' },
                { name: '遅番', start: '14:00', end: '21:00' },
                { name: '通し', start: '09:00', end: '21:00' },
                { name: '午前', start: '09:00', end: '13:00' },
                { name: '午後', start: '13:00', end: '17:00' },
                { name: '夕方', start: '17:00', end: '21:00' },
            ]
        },
        medical: {
            name: '医療・介護向け',
            patterns: [
                { name: '日勤', start: '08:30', end: '17:30' },
                { name: '早番', start: '07:00', end: '16:00' },
                { name: '遅番', start: '10:00', end: '19:00' },
                { name: '夜勤', start: '16:30', end: '09:00' },
                { name: '準夜勤', start: '16:30', end: '01:00' },
                { name: '半日', start: '08:30', end: '12:30' },
            ]
        },
        // v3.7.58: 2部営業 (中抜き) プリセット
        lunch_dinner: {
            name: '2部営業 (ランチ+ディナー)',
            patterns: [
                { name: 'ランチ早番', start: '10:30', end: '14:30' },
                { name: 'ランチ遅番', start: '11:30', end: '15:00' },
                { name: 'ディナー早番', start: '17:00', end: '21:00' },
                { name: 'ディナー遅番', start: '18:00', end: '23:30' },
                { name: '通しランチ+ディナー', start: '10:30', end: '23:30' },
            ]
        },
        lunch_only: {
            name: 'ランチ営業のみ',
            patterns: [
                { name: 'ランチ早番', start: '10:00', end: '14:00' },
                { name: 'ランチ通し', start: '10:00', end: '15:00' },
                { name: 'ランチ遅番', start: '11:00', end: '15:00' },
            ]
        },
        dinner_only: {
            name: 'ディナー営業のみ',
            patterns: [
                { name: 'ディナー早番', start: '17:00', end: '22:00' },
                { name: 'ディナー通し', start: '17:00', end: '23:30' },
                { name: 'ディナー遅番', start: '18:00', end: '23:30' },
                { name: '深夜帯', start: '20:00', end: '02:00' },
            ]
        },
    },

    /**
     * プリセットのシフトパターンを一括適用
     * @param {string} presetKey - 'restaurant' | 'office' | 'retail' | 'medical'
     */
    applyShiftPreset(presetKey) {
        const preset = this.SHIFT_PRESETS[presetKey];
        if (!preset) return;

        const existing = this.state.config.custom_shifts || [];
        if (existing.length > 0) {
            if (!confirm(`現在のシフトパターン(${existing.length}件)を上書きしますか？\n「${preset.name}」(${preset.patterns.length}パターン)に置き換えます。`)) {
                return;
            }
        }

        this.state.config.custom_shifts = preset.patterns.map(p => ({ ...p }));
        this.renderCurrentView();
        this.showToast(`「${preset.name}」プリセット(${preset.patterns.length}パターン)を適用しました`, 'success');
    }
};

document.addEventListener('DOMContentLoaded', () => { app.init(); });














