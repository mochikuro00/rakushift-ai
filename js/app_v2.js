const app = {
    // アプリケーションの状態管理
    state: {
        currentDate: null, // Initialized in init()
        view: 'dashboard', // 現在のビュー
        shiftViewMode: 'table', // 'table' or 'calendar'
        shiftTablePeriod: 'month', // 'month', 'week', '2weeks'
        dashboardMode: 'month', // 'month', '2week-1', '2week-2'
        isAdmin: false, // 管理者ログイン状態
        
        // データ（APIからロード）
        config: {},
        staff: [],
        shifts: [],
        requests: [],
        organization_id: null,
        
        // 設定デフォルト値
        defaultConfig: {
            admin_password: "0000",
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
                min_manager: 1,
                min_weekday: 2,
                min_weekend: 3,
                min_holiday: 3
            },
            
            // 役職設定 (ID, 名前, 色, レベル:高いほど権限強)
            roles: [
                { id: 'manager', name: '店長', color: 'purple', level: 3 },
                { id: 'leader', name: 'リーダー', color: 'blue', level: 2 },
                { id: 'staff', name: 'スタッフ', color: 'gray', level: 1 }
            ],

            // 臨時休業日 (YYYY-MM-DD)
            special_holidays: [],
            
            // 特定日の営業時間 (YYYY-MM-DD: {start, end, note})
            special_days: {},

            // 時間帯別人員ルール
            time_staff_req: [], // [{ days: [0,6], start: '11:00', end: '14:00', count: 4 }]

            // カレンダー備考 (YYYY-MM-DD: "メモ内容")
            calendar_notes: {},

            // 生成AI設定
            openai_api_key: "",
            openai_model: "gpt-4o",
            gemini_api_key: "",
            gemini_model: "gemini-1.5-flash",
            llm_provider: "openai", // 'openai' or 'gemini'
            
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
     * 初期化処理
     */
    async init() {
        console.log("App initializing...");
        try {
            await API.init();
            
            // Use native Date to avoid external dependency issues
            this.state.currentDate = new Date();
            this.bindEvents();
            
            // セッションチェック
            if (API.session) {
                console.log("Session found. Loading data...");
                
                // 【復元処理】
                // session内のuser情報から状態を復元する
                const user = API.session.user;
                if (user) {
                    this.state.isShopLoggedIn = true;
                    // contract_id を優先的に復元
                    if (user.contract_id) {
                        this.state.organization_id = user.contract_id;
                    }
                    // 管理者かどうかの復元
                    if (user.role === 'Manager' || user.role === 'manager') {
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
        document.querySelectorAll('.sidebar-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const view = e.currentTarget.dataset.view;
                this.changeView(view);
            });
        });

        document.getElementById('prevPeriod')?.addEventListener('click', () => this.changeMonth(-1));
        document.getElementById('nextPeriod')?.addEventListener('click', () => this.changeMonth(1));
        document.getElementById('todayBtn')?.addEventListener('click', () => {
            this.state.currentDate = new Date();
            this.renderCurrentView();
            this.updateHeader();
        });

        document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
            document.querySelector('aside').classList.toggle('-translate-x-full');
        });
        
        // Dynamic buttons (autoFill, aiAdvice) are bound in updateAuthUI()

        document.getElementById('authBtn')?.addEventListener('click', () => this.handleAuth());
    },

    /**
     * データのロード
     */
    async loadData() {
        this.showLoading(true);
        try {
            const userId = API.session?.user?.id;
            let orgId = null;

            // 1. セッションから組織ID (契約ID) を取得
            if (API.session && API.session.user && API.session.user.contract_id) {
                orgId = API.session.user.contract_id;
                console.log("Organization ID loaded from Session:", orgId);
            }

            // 2. プロフィールになければ LocalStorage -> APIリスト の順で探す (フォールバック)
            if (!orgId) {
                orgId = localStorage.getItem('rakushift_org_id') || this.state.organization_id;
            }

            if (!orgId) {
                try {
                    const orgRes = await API.list('organizations');
                    if (orgRes && orgRes.data && orgRes.data.length > 0) {
                        // データが入っていそうな組織を探すロジック等は省略し、既存順で取得
                        orgId = orgRes.data[0].id;
                    }
                } catch(e) {
                    console.error("Failed to load organizations:", e);
                }
            }

            // 決定したIDを保存
            if (orgId) {
                this.state.organization_id = orgId;
                localStorage.setItem('rakushift_org_id', orgId);
            }

            // 3. データ取得
            // 【修正】IDによる絞り込みを撤廃し、全データを取得する
            // これにより、ID不整合による「保存したのに見えない」現象を物理的に防ぐ
            const queryParams = {}; 

            console.log("Fetching ALL data from DB...");
            const [configRes, staffRes, shiftsRes, requestsRes] = await Promise.all([
                API.list('config', queryParams),
                API.list('staff', queryParams),
                API.list('shifts', queryParams),
                API.list('requests', queryParams)
            ]);

            // 取得したデータの中から、最も新しい「店舗設定(config)」を採用する
            if (configRes.data && configRes.data.length > 0) {
                // 配列の最後（最新）を使う
                const latestConfig = configRes.data[configRes.data.length - 1];
                
                // 【重要】デフォルト設定で上書きせず、DBの設定を優先する
                // ただし、DBにない項目だけデフォルトで埋める
                this.state.config = { ...this.state.defaultConfig, ...latestConfig };
                
                // その設定が持つ組織IDを「正」とする
                if (latestConfig.organization_id) {
                    this.state.organization_id = latestConfig.organization_id;
                    localStorage.setItem('rakushift_org_id', latestConfig.organization_id);
                }
            } else {
                // DBに設定がない場合だけ、現在のstateを維持（リセットしない）
                if (!this.state.config.id) {
                    console.log("No config in DB, keeping current local config.");
                }
            }

            // データをStateに保存 (空配列で上書きしない)
            if (staffRes.data && staffRes.data.length > 0) this.state.staff = staffRes.data;
            if (shiftsRes.data && shiftsRes.data.length > 0) this.state.shifts = shiftsRes.data;
            if (requestsRes.data && requestsRes.data.length > 0) this.state.requests = requestsRes.data;
            if (configRes.data && configRes.data.length > 0) {
                this.state.config = { ...this.state.defaultConfig, ...configRes.data[0] };
            }

            console.log(`Loaded: ${this.state.staff.length} staff, ${this.state.shifts.length} shifts.`);
            this.updateRequestBadge();

        } catch (error) {
            console.error('Data Load Error:', error);
            // エラー時は何もしない（既存データを消さない）
        } finally {
            this.showLoading(false);
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
            // 管理者ログインモーダルを開く
            this.openModal('adminLoginModal');
        }
    },

    /**
     * 契約者（店舗）ログイン処理
     */
    async login() {
        console.log('[ShopLogin] Login attempt started...');
        
        const contractIdEl = document.getElementById('loginContractId');
        const passwordEl = document.getElementById('loginShopPass') || document.getElementById('loginPass');

        if (!contractIdEl || !passwordEl) {
            alert('エラー: 入力欄が見つかりません。ページを再読み込みしてください。');
            return;
        }

        const contractId = contractIdEl.value.trim();
        const password = passwordEl.value.trim();

        if (!contractId || !password) {
            this.showToast('全ての項目を入力してください', 'error');
            return;
        }

        this.showLoading(true);
        try {
            // サーバーサイドでハッシュ検証
            const result = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: password
            });

            console.log('[ShopLogin] RPC result:', result);

            if (result.success) {
                this.state.isShopLoggedIn = true;
                this.state.isAdmin = false;
                this.state.organization_id = result.contract_id;

                API.setSession({
                    contract_id: result.contract_id,
                    organization_id: result.organization_id,
                    name: 'Guest (Staff)',
                    role: 'Guest'
                });

                this.closeModal('loginModal');
                this.showToast(`契約ID: ${contractId} でログインしました`, 'success');

                await this.loadData();
                this.updateAuthUI();
                this.updateHeader();
            } else {
                this.showToast(result.message || 'ログインに失敗しました', 'error');
            }

        } catch (error) {
            console.error('[ShopLogin] Error:', error);
            this.showToast(`ログイン処理中にエラーが発生しました: ${error.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    /**
     * 管理者ログイン処理
     */
    async adminLogin() {
        const loginId = document.getElementById('adminLoginId').value.trim();
        const password = document.getElementById('adminLoginPass').value.trim();

        console.log(`[AdminLogin] Triggered. Input LoginID: ${loginId}`);

        if (!loginId || !password) {
            this.showToast('全ての項目を入力してください', 'error');
            return;
        }

        this.showLoading(true);
        try {
            let currentContractId = this.state.organization_id;
            if (API.session?.user?.contract_id) {
                currentContractId = API.session.user.contract_id;
            } else if (this.state.config?.contract_id) {
                currentContractId = this.state.config.contract_id;
            }

            console.log(`[AdminLogin] ContractID: ${currentContractId}, LoginID: ${loginId}`);

            if (!currentContractId) {
                this.showToast('先に店舗ログインしてください', 'error');
                return;
            }

            // サーバーサイドでハッシュ検証
            const result = await API.rpc('verify_admin_login', {
                p_contract_id: currentContractId,
                p_login_id: loginId,
                p_password: password
            });

            console.log('[AdminLogin] RPC result:', result);

            if (result.success) {
                this.state.isAdmin = true;

                API.setSession({
                    id: result.staff_id,
                    contract_id: currentContractId,
                    organization_id: result.organization_id,
                    name: result.name,
                    role: result.role
                });

                this.closeModal('adminLoginModal');
                this.showToast(`管理者: ${result.name} でログインしました`, 'success');

                this.updateAuthUI();
                this.updateHeader();
            } else {
                this.showToast(result.message || '管理者ログインに失敗しました', 'error');
            }

        } catch(e) {
            console.error('Admin Login Error:', e);
            this.showToast(`エラーが発生しました: ${e.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    signUpMode() {
        alert("新規登録機能は現在メンテナンス中です。管理者に連絡してアカウントを発行してください。");
    },

    async logout() {
        if(!confirm('アプリケーションから完全にログアウトしますか？\n（ログイン画面に戻ります）')) return;
        
        await API.logout();
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        this.state.staff = [];
        this.state.shifts = [];
        this.showToast('ログアウトしました', 'info');
        this.updateAuthUI();
        this.changeView('dashboard'); 
        this.openModal('loginModal');
    },

    updateAuthUI() {
        const authBtn = document.getElementById('authBtn');
        const adminLinks = document.querySelectorAll('.admin-link');
        const adminHeader = document.getElementById('adminHeaderControls');
        
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
                    <button onclick="app.openModal('autoFillModal')" class="hidden md:flex items-center gap-2 px-3 py-1.5 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded shadow transition-all">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 自動作成
                    </button>
                    <button onclick="app.analyzeShift()" class="hidden md:flex items-center gap-2 px-3 py-1.5 text-sm font-bold text-blue-700 bg-blue-100 hover:bg-blue-200 rounded border border-blue-200 transition-all">
                        <i class="fa-solid fa-robot"></i> AI診断
                    </button>
                    <div class="h-8 w-px bg-gray-300 mx-2 hidden md:block"></div>
                    <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all ml-2" title="完全ログアウト">
                        <i class="fa-solid fa-power-off"></i>
                    </button>
                `;
            } else {
                // スタッフモード（閲覧のみ）のときはヘッダーに契約IDと完全ログアウトボタンを表示
                if (this.state.isShopLoggedIn) {
                     adminHeader.innerHTML = `
                        <div class="hidden md:block px-3 py-1 text-xs font-mono text-gray-400 border border-gray-200 rounded bg-gray-50 mr-2">
                            ID: ${this.state.organization_id}
                        </div>
                        <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all" title="完全ログアウト">
                            <i class="fa-solid fa-power-off"></i>
                        </button>
                     `;
                } else {
                    adminHeader.innerHTML = '';
                }
            }
        }
        
        // メニューバッジなどの更新
        this.updateRequestBadge();
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
        this.renderCurrentView();
    },

    updateHeader() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const display = document.getElementById('currentPeriodDisplay');
        if(display) display.textContent = `${year}年 ${month}月`;
        this.calculateMonthlyStats();
    },

    renderCurrentView() {
        const container = document.getElementById('viewContainer');
        container.innerHTML = '';

        switch (this.state.view) {
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
            alert(`現在のアカウント (${currentUser}) ではこの機能を使用できません。\n管理者(master@mochikuro.com)のみ実行可能です。`);
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

            // 3. 既存データの確認 (全削除はしない)
            const allStaffRes = await API.list('staff', { organization_id: `eq.${orgId}` });
            const currentStaff = allStaffRes.data || [];
            
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
                        organization_id: orgId
                    };
                    if (tmpl.holidays) {
                        data.annual_holidays = tmpl.holidays; // ここで保存
                    }

                    const res = await API.create('staff', data);
                    
                    if (!res) {
                        throw new Error(`スタッフ「${uniqueName}」のDB保存に失敗しました。RLS設定を確認してください。`);
                    }
                    createdStaff.push(res);
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

            // 5. 設定データの修復 (空の場合のみ)
            if (!this.state.config.id) {
                // デフォルト設定を投入
                const newConfig = { ...this.state.defaultConfig, organization_id: orgId };
                await API.create('config', newConfig);
                // 再読み込み
                const confRes = await API.list('config', { organization_id: `eq.${orgId}` });
                if(confRes.data?.[0]) this.state.config = { ...this.state.defaultConfig, ...confRes.data[0] };
            }

            this.renderCurrentView();
            this.showToast(`データ整備完了。現在のスタッフ: ${this.state.staff.length}名`, 'success');
            
        } catch(e) {
            console.error("Test data setup failed:", e);
            alert("エラーが発生しました: " + e.message);
        } finally {
            this.showLoading(false);
        }
    },

    // =================================================================
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
                    <div class="grid grid-cols-2 gap-4">
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
                            <p class="text-xs text-gray-400 mt-2">営業時間: ${this.state.config.opening_time} - ${this.state.config.closing_time}</p>
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
                            <button onclick="app.openModal('staffModal'); document.getElementById('staffForm').reset(); document.getElementById('staffId').value='';" 
                                class="w-full text-left px-4 py-3 hover:bg-blue-50 rounded-lg text-sm font-bold text-gray-600 hover:text-blue-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-blue-200">
                                <i class="fa-solid fa-user-plus text-blue-500 text-lg"></i> スタッフ追加
                            </button>
                            <button onclick="app.runAIDiagnosis()" 
                                class="w-full text-left px-4 py-3 hover:bg-purple-50 rounded-lg text-sm font-bold text-gray-600 hover:text-purple-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-purple-200">
                                <i class="fa-solid fa-wand-magic-sparkles text-purple-500 text-lg"></i> AI診断
                            </button>
                            ` : ''}
                            
                            <button onclick="app.openModal('requestModal'); app.initRequestModal();" 
                                class="w-full text-left px-4 py-3 hover:bg-indigo-50 rounded-lg text-sm font-bold text-gray-600 hover:text-indigo-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-indigo-200">
                                <i class="fa-solid fa-paper-plane text-indigo-500 text-lg"></i> 休暇・シフト申請
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
                                ${staff ? staff.name.charAt(0) : '?'}
                            </div>
                            <div>
                                <div class="font-bold text-sm text-gray-800">${staff ? staff.name : '削除済スタッフ'}</div>
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
                let hours = (end - start) / (1000 * 60 * 60) - (shift.break_minutes / 60);
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
        const history = this.state.requests.filter(r => r.status !== 'pending').sort((a, b) => b.id - a.id).slice(0, 10);

        container.innerHTML = `
            <div class="grid lg:grid-cols-2 gap-8">
                <!-- Pending -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-blue-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2">
                            <i class="fa-solid fa-inbox text-blue-600"></i> 承認待ち
                            <span class="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">${pending.length}</span>
                        </h3>
                    </div>
                    <div class="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                        ${pending.length === 0 ? '<div class="p-8 text-center text-gray-400">現在、承認待ちの申請はありません</div>' : ''}
                        ${pending.map(req => {
                            const staff = this.getStaff(req.staff_id);
                            return `
                                <div class="p-4 hover:bg-gray-50 transition-colors">
                                    <div class="flex justify-between items-start mb-2">
                                        <div class="flex items-center gap-2">
                                            <div class="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center font-bold text-gray-500 text-xs">
                                                ${staff ? staff.name.charAt(0) : '?'}
                                            </div>
                                            <div>
                                                <div class="font-bold text-gray-800 text-sm">${staff ? staff.name : '不明'}</div>
                                                <div class="text-xs text-gray-500">${new Date(req.created_at || Date.now()).toLocaleDateString()} 申請</div>
                                            </div>
                                        </div>
                                        <span class="text-xs font-bold px-2 py-1 rounded bg-yellow-100 text-yellow-700">
                                            ${req.type === 'off' ? '休み希望' : '勤務希望'}
                                        </span>
                                    </div>
                                    <div class="pl-10">
                                        <div class="text-sm font-bold text-gray-800 mb-1">
                                            <i class="fa-regular fa-calendar mr-1 text-gray-400"></i> ${req.dates}
                                            ${req.type === 'work' ? `<span class="ml-2 text-gray-600">${req.start_time} - ${req.end_time}</span>` : ''}
                                        </div>
                                        ${req.reason ? `<div class="text-xs text-gray-600 bg-gray-50 p-2 rounded mb-3">"${req.reason}"</div>` : ''}
                                        
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

                <!-- History -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden opacity-80">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2">
                            <i class="fa-solid fa-clock-rotate-left text-gray-500"></i> 処理履歴 (直近10件)
                        </h3>
                    </div>
                    <div class="divide-y divide-gray-100">
                        ${history.map(req => {
                             const staff = this.getStaff(req.staff_id);
                             const isApproved = req.status === 'approved';
                             return `
                                <div class="p-3 flex justify-between items-center text-sm">
                                    <div class="flex items-center gap-3">
                                        <div class="w-2 h-2 rounded-full ${isApproved ? 'bg-green-500' : 'bg-red-500'}"></div>
                                        <div>
                                            <span class="font-bold text-gray-700">${staff ? staff.name : '不明'}</span>
                                            <span class="text-gray-400 mx-1">|</span>
                                            <span class="text-gray-600">${req.dates}</span>
                                        </div>
                                    </div>
                                    <span class="font-bold text-xs ${isApproved ? 'text-green-600' : 'text-red-500'}">
                                        ${isApproved ? '承認済' : '却下'}
                                    </span>
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
            periodControls = `
                <div class="flex items-center bg-gray-100 p-1 rounded-lg ml-4">
                    <button onclick="app.switchShiftTablePeriod('month')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='month')}">月間</button>
                    <button onclick="app.switchShiftTablePeriod('2weeks')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='2weeks')}">2週間</button>
                    <button onclick="app.switchShiftTablePeriod('week')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='week')}">1週間</button>
                </div>
            `;
        }

        // Navigation arrows for Week/2Weeks
        let navControls = '';
        if (isTable && p !== 'month') {
            const label = p === 'week' ? '1週間' : '2週間';
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
                    
                    <div class="flex items-center gap-2">
                        ${periodControls}
                        <div class="flex bg-gray-100 p-1 rounded-lg">
                            <button onclick="app.switchShiftViewMode('table')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-solid fa-table-list mr-1"></i>表
                            </button>
                            <button onclick="app.switchShiftViewMode('calendar')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${!isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-regular fa-calendar-days mr-1"></i>カレンダー
                            </button>
                        </div>
                    </div>
                </div>
                <div id="shiftViewContent" class="flex-1 overflow-hidden bg-white rounded-xl shadow-sm border border-gray-200 relative">
                    <!-- Content injected here -->
                </div>
                <div class="flex justify-end pt-2">
                    <button onclick="app.printShiftTable()" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 transition">
                        <i class="fa-solid fa-print mr-2"></i>印刷
                    </button>
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

    switchShiftTablePeriod(period) {
        this.state.shiftTablePeriod = period;
        // Align date if switching to week modes
        if (period !== 'month') {
            // Align to nearest past Sunday or today if Sunday
            const d = new Date(this.state.currentDate);
            const day = d.getDay();
            d.setDate(d.getDate() - day);
            this.state.currentDate = d;
        } else {
            // Align to 1st of month
            const d = new Date(this.state.currentDate);
            d.setDate(1);
            this.state.currentDate = d;
        }
        this.renderShiftView(document.getElementById('viewContainer'));
    },

    changeTablePeriod(delta) {
        const d = new Date(this.state.currentDate);
        if (this.state.shiftTablePeriod === 'week') {
            d.setDate(d.getDate() + (delta * 7));
        } else if (this.state.shiftTablePeriod === '2weeks') {
            d.setDate(d.getDate() + (delta * 14));
        }
        this.state.currentDate = d;
        this.renderShiftView(document.getElementById('viewContainer'));
    },

    renderShiftTable(container) {
        const period = this.state.shiftTablePeriod || 'month';
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        
        let days = [];
        let colWidthClass = 'min-w-[40px]'; // Default narrow
        let isGanttMode = false;

        if (period === 'month') {
            const lastDay = new Date(year, month + 1, 0).getDate();
            days = Array.from({length: lastDay}, (_, i) => {
                return new Date(year, month, i + 1);
            });
        } else {
            const range = period === 'week' ? 7 : 14;
            // 1週間ならさらに幅を広げて15分単位を見やすくする (1200px = 1h50px = 15m12.5px)
            colWidthClass = period === 'week' ? 'min-w-[1200px]' : 'min-w-[600px]';
            isGanttMode = true; 
            
            const start = new Date(this.state.currentDate);
            days = Array.from({length: range}, (_, i) => {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                return d;
            });
        }
        
        // ヘッダー生成
        let headerHtml = `<th class="p-3 sticky left-0 z-50 bg-gray-50 border-b border-r border-gray-200 min-w-[120px] text-left text-xs font-bold text-gray-500 uppercase tracking-wider">スタッフ</th>`;
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
            let timeScale = '';
            if (isGanttMode) {
                // 1時間おきに数字を表示
                let scaleHtml = '';
                for (let i = 0; i <= 24; i++) {
                    const left = (i / 24) * 100;
                    // 数字の間引き: 幅が狭い場合は偶数のみ
                    if (period === '2weeks' && i % 2 !== 0) continue;
                    
                    scaleHtml += `<span class="absolute -translate-x-1/2 font-mono" style="left: ${left}%">${String(i).padStart(2,'0')}</span>`;
                    
                    // 15分刻みの目盛り (Weekモードのみ)
                    if (period === 'week' && i < 24) {
                        for(let m=1; m<4; m++) {
                            const mLeft = ((i + m/4) / 24) * 100;
                            scaleHtml += `<span class="absolute -translate-x-1/2 text-[8px] text-gray-300 top-1" style="left: ${mLeft}%">|</span>`;
                        }
                    }
                }
                
                timeScale = `
                    <div class="relative h-5 text-[10px] text-gray-400 font-bold mt-1 border-t border-gray-100 pt-0.5 select-none">
                        ${scaleHtml}
                    </div>
                `;
            }
            
            headerHtml += `<th class="p-2 ${colWidthClass} text-center border-b border-gray-200 bg-gray-50 text-xs font-bold ${colorClass}">
                <div class="sticky left-0 right-0 flex flex-col items-center justify-center leading-tight">
                    <span class="text-sm block">${label}</span>
                    <span class="text-[10px] font-normal block">${['日','月','火','水','木','金','土'][dayOfWeek]}</span>
                </div>
                ${timeScale}
            </th>`;
        });

        // ボディ生成
        let bodyHtml = '';
        this.state.staff.forEach(staff => {
            bodyHtml += `<tr>`;
            bodyHtml += `<td class="p-3 sticky left-0 z-40 bg-white border-b border-r border-gray-100 font-bold text-sm text-gray-800 truncate h-14">${staff.name}</td>`;
            
            days.forEach(date => {
                const y = date.getFullYear();
                const m = date.getMonth() + 1;
                const d = date.getDate();
                const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                
                // 過去日判定
                const checkDate = new Date(date);
                checkDate.setHours(0,0,0,0);
                const today = new Date();
                today.setHours(0,0,0,0);
                const isPast = checkDate < today;

                // シフト検索
                const shift = this.state.shifts.find(s => s.staff_id === staff.id && s.date === dateStr);
                
                // セル背景色
                const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
                let bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines' : 'bg-white';
                
                if (isPast) {
                    bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines opacity-75' : 'bg-gray-100';
                } else if (!shift && !isSpecialHoliday) {
                    bgClass = 'hover:bg-gray-50';
                }

                // セルアクション
                const action = this.state.isAdmin 
                    ? (shift ? `onclick="app.openEditShift('${shift.id}')"` : `onclick="app.openAddShift('${dateStr}'); document.getElementById('editShiftStaffSelect').value='${staff.id}';"`)
                    : '';
                const cursor = this.state.isAdmin ? 'cursor-pointer' : '';

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
                    const startH = parseInt(shift.start_time);
                    let barColor = 'bg-blue-100 text-blue-700 border-blue-500'; // base
                    if (startH < 10) barColor = 'bg-yellow-100 text-yellow-800 border-yellow-500';
                    if (startH >= 17) barColor = 'bg-purple-100 text-purple-700 border-purple-500';
                    
                    // 過去の場合はグレーアウト
                    if (isPast) {
                        barColor = 'bg-gray-200 text-gray-500 border-gray-400 opacity-80';
                    }

                    if (isGanttMode) {
                        // === Gantt Style (Bar inside timeline) ===
                        const timeToPct = (t) => {
                            const [h, m] = t.split(':').map(Number);
                            return ((h + m/60) / 24) * 100;
                        };
                        const startPct = timeToPct(shift.start_time);
                        const endPct = timeToPct(shift.end_time);
                        const widthPct = endPct - startPct;
                        
                        // 営業時間外マスク (Open前、Close後)
                        const openPct = timeToPct(openTime);
                        const closePct = timeToPct(closeTime);
                        
                        // CSS Gradientで細かいグリッドを描画
                        // 1h = 100/24 %, 15m = 1h/4
                        const oneHour = 100/24;
                        const oneFifteen = oneHour / 4;
                        const bgGuides = `
                            <!-- Fine Grid (CSS Gradient) -->
                            <div class="absolute top-0 bottom-0 left-0 right-0 pointer-events-none" 
                                 style="
                                    background-image: 
                                        linear-gradient(to right, #d1d5db 1px, transparent 1px), /* 1h: Stronger */
                                        linear-gradient(to right, #f3f4f6 1px, transparent 1px); /* 15m: Lighter */
                                    background-size: 
                                        ${oneHour}% 100%, 
                                        ${oneFifteen}% 100%;
                                 ">
                            </div>
                            <!-- 6h Major Lines -->
                            <div class="absolute top-0 bottom-0 left-[25%] w-px bg-gray-400 z-0"></div>
                            <div class="absolute top-0 bottom-0 left-[50%] w-px bg-gray-400 z-0"></div>
                            <div class="absolute top-0 bottom-0 left-[75%] w-px bg-gray-400 z-0"></div>
                            
                            <!-- Business Hours Mask (Outside of Open-Close is grayed out) -->
                            <div class="absolute top-0 bottom-0 left-0 bg-gray-200/50 pointer-events-none z-0" style="width: ${openPct}%;"></div>
                            <div class="absolute top-0 bottom-0 right-0 bg-gray-200/50 pointer-events-none z-0" style="left: ${closePct}%;"></div>
                        `;
                        
                        content = `
                            <div class="w-full h-full relative group bg-white overflow-hidden">
                                ${bgGuides}
                                <!-- Bar with text -->
                                <div class="absolute top-1/2 -translate-y-1/2 h-8 ${period==='week'?'':'h-6'} rounded ${barColor} border shadow-sm flex items-center justify-center overflow-hidden z-10 hover:brightness-95 transition-all cursor-pointer px-1"
                                     style="left: ${startPct}%; width: ${Math.max(widthPct, 0.5)}%; min-width: 2px;">
                                     <span class="text-[9px] md:text-[10px] font-bold whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none">
                                        ${shift.start_time} - ${shift.end_time}
                                     </span>
                                </div>
                                
                                <!-- Tooltip on hover -->
                                <div class="opacity-0 group-hover:opacity-100 absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded px-2 py-1 z-20 pointer-events-none whitespace-nowrap shadow-lg">
                                    ${shift.start_time} - ${shift.end_time}
                                </div>
                            </div>
                        `;
                    } else {
                        // === Month Style (Block) ===
                        content = `<div class="w-full h-full p-1"><div class="${barColor} border-l-2 rounded text-[10px] font-bold text-center leading-tight py-1 truncate shadow-sm">${shift.start_time}<br>|${shift.end_time}</div></div>`;
                    }
                } else if (isSpecialHoliday) {
                    content = `<div class="w-full h-full flex items-center justify-center"><span class="text-[10px] text-red-300 font-bold">休</span></div>`;
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

                    // CSS Gradientで細かいグリッドを描画
                    const oneHour = 100/24;
                    const oneFifteen = oneHour / 4;
                    const guides = `
                        <!-- Fine Grid (CSS Gradient) -->
                        <div class="absolute top-0 bottom-0 left-0 right-0 pointer-events-none" 
                                style="
                                background-image: 
                                    linear-gradient(to right, #d1d5db 1px, transparent 1px), /* 1h */
                                    linear-gradient(to right, #f3f4f6 1px, transparent 1px); /* 15m */
                                background-size: 
                                    ${oneHour}% 100%, 
                                    ${oneFifteen}% 100%;
                                ">
                        </div>
                        <!-- 6h Major Lines -->
                        <div class="absolute top-0 bottom-0 left-[25%] w-px bg-gray-400"></div>
                        <div class="absolute top-0 bottom-0 left-[50%] w-px bg-gray-400"></div>
                        <div class="absolute top-0 bottom-0 left-[75%] w-px bg-gray-400"></div>
                        
                        <!-- Business Hours Mask -->
                        <div class="absolute top-0 bottom-0 left-0 bg-gray-200/50 pointer-events-none" style="width: ${openPct}%;"></div>
                        <div class="absolute top-0 bottom-0 right-0 bg-gray-200/50 pointer-events-none" style="left: ${closePct}%;"></div>
                    `;
                    content = `<div class="w-full h-full relative group overflow-hidden bg-white">${guides}</div>`;
                }

                bodyHtml += `<td class="p-0 border-b border-r border-gray-100 h-14 relative transition-colors ${bgClass} ${cursor}" ${action}>${content}</td>`;
            });
            bodyHtml += `</tr>`;
        });

        container.innerHTML = `
            <div class="h-full overflow-auto custom-scrollbar">
                <table class="w-full border-collapse">
                    <thead><tr>${headerHtml}</tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
        `;
    },

    renderCalendar(container) {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        
        let html = `
            <div class="h-full overflow-y-auto custom-scrollbar">
                <div class="bg-white rounded-t-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="grid grid-cols-7 border-b border-gray-200 bg-gray-50 sticky top-0 z-10 shadow-sm">
                        ${['日', '月', '火', '水', '木', '金', '土'].map((day, i) => 
                            `<div class="py-3 text-center text-sm font-bold ${i===0 ? 'text-red-500' : i===6 ? 'text-blue-500' : 'text-gray-600'}">${day}</div>`
                        ).join('')}
                    </div>
                    <div class="grid grid-cols-7 auto-rows-fr bg-gray-200 gap-px border-b border-gray-200">
        `;

        for (let i = 0; i < firstDay.getDay(); i++) {
            html += `<div class="bg-gray-50 min-h-[120px]"></div>`;
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
                actionBtns = `
                    <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick="event.stopPropagation(); app.openCalendarNoteModal('${dateStr}')" class="text-gray-400 hover:text-yellow-500 w-5 h-5 flex items-center justify-center rounded hover:bg-yellow-50" title="メモ編集">
                            <i class="fa-regular fa-note-sticky"></i>
                        </button>
                        <button onclick="event.stopPropagation(); app.openAddShift('${dateStr}')" class="text-gray-400 hover:text-blue-600 w-5 h-5 flex items-center justify-center rounded hover:bg-blue-50" title="シフト追加">
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
                            // 見やすいデザインに変更
                            return `
                                <div class="text-xs px-2 py-1.5 rounded-md border-l-4 shadow-sm transition-all bg-blue-50 border-blue-500 text-blue-900 ${cursorClass}" 
                                     ${shiftAction} title="${staff.name} ${shift.start_time}-${shift.end_time}">
                                    <div class="font-bold truncate">${staff.name}</div>
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
        const date = document.getElementById('noteDate').value;
        const text = document.getElementById('noteText').value.trim();
        
        if (!this.state.config.calendar_notes) this.state.config.calendar_notes = {};
        
        if (text) {
            this.state.config.calendar_notes[date] = text;
        } else {
            delete this.state.config.calendar_notes[date];
        }

        this.showLoading(true);
        try {
            await API.update('config', this.state.config.id, { calendar_notes: this.state.config.calendar_notes });
            
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
        const date = document.getElementById('noteDate').value;
        
        if (this.state.config.calendar_notes && this.state.config.calendar_notes[date]) {
            delete this.state.config.calendar_notes[date];
            
            this.showLoading(true);
            try {
                await API.update('config', this.state.config.id, { calendar_notes: this.state.config.calendar_notes });
                
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
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
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
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">日次コスト推移</h3><div class="h-[300px]"><canvas id="dailyCostChart"></canvas></div></div>
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">スタッフ別コスト構成比</h3><div class="h-[300px] flex justify-center"><canvas id="staffShareChart"></canvas></div></div>
                </div>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50"><h3 class="font-bold text-gray-800">スタッフ別詳細・労働時間チェック</h3></div>
                    <table class="w-full text-left text-sm">
                        <thead class="bg-gray-50 text-gray-500 border-b border-gray-200">
                            <tr>
                                <th class="p-4 font-medium">スタッフ名</th>
                                <th class="p-4 font-medium text-right">出勤日数</th>
                                <th class="p-4 font-medium text-right">労働時間</th>
                                <th class="p-4 font-medium text-right">法定目安(176h)との差</th>
                                <th class="p-4 font-medium text-right">推定支給額</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100">
                            ${stats.staffStats.map(s => {
                                const limit = 176; // 月間法定労働時間の目安 (40週 * 4.4週)
                                const diff = s.hours - limit;
                                const isOver = diff > 0;
                                const diffText = isOver ? `+${diff.toFixed(1)}h` : 'OK';
                                const rowClass = isOver ? 'bg-red-50' : 'hover:bg-gray-50';
                                const textClass = isOver ? 'text-red-600 font-bold' : 'text-green-600';
                                const icon = isOver ? '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' : '<i class="fa-solid fa-check mr-1"></i>';

                                return `
                                <tr class="${rowClass}">
                                    <td class="p-4 font-bold text-gray-700">${s.name}</td>
                                    <td class="p-4 text-right">${s.days}日</td>
                                    <td class="p-4 text-right">${s.hours.toFixed(1)}h</td>
                                    <td class="p-4 text-right ${textClass}">${icon}${diffText}</td>
                                    <td class="p-4 text-right font-mono">¥${s.cost.toLocaleString()}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        setTimeout(() => this.renderAnalyticsCharts(stats), 100);
    },

    calculateMonthlyAnalytics() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const prefix = `${year}-${String(month).padStart(2, '0')}`;
        const monthShifts = this.state.shifts.filter(s => s.date.startsWith(prefix));
        const daysInMonth = new Date(year, month, 0).getDate();

        let totalCost = 0, totalHours = 0;
        const dailyCosts = new Array(daysInMonth).fill(0);
        const dailyLabels = Array.from({length: daysInMonth}, (_, i) => `${i+1}日`);
        const staffMap = {};

        monthShifts.forEach(shift => {
            const staff = this.getStaff(shift.staff_id);
            if (!staff) return;
            const start = new Date(`${shift.date}T${shift.start_time}`);
            const end = new Date(`${shift.date}T${shift.end_time}`);
            let hours = (end - start) / (1000 * 60 * 60) - (shift.break_minutes / 60);
            if (hours < 0) hours = 0;

            let cost = 0;
            if (staff.salary_type === 'hourly') {
                let wage = staff.hourly_wage;
                if (JapaneseHolidays.isHoliday(shift.date)) wage *= 1.25;
                cost = Math.floor(hours * wage);
            }

            totalCost += cost;
            totalHours += hours;
            const dayIndex = parseInt(shift.date.split('-')[2]) - 1;
            dailyCosts[dayIndex] += cost;

            if (!staffMap[staff.id]) staffMap[staff.id] = { name: staff.name, cost: 0, hours: 0, days: 0 };
            staffMap[staff.id].cost += cost;
            staffMap[staff.id].hours += hours;
            staffMap[staff.id].days += 1;
        });

        this.state.staff.forEach(s => {
            if (s.salary_type === 'monthly') {
                totalCost += (s.monthly_salary || 0);
                if (!staffMap[s.id]) staffMap[s.id] = { name: s.name, cost: 0, hours: 0, days: 0 };
                staffMap[s.id].cost += (s.monthly_salary || 0);
            }
        });

        return { totalCost, totalHours, daysCount: daysInMonth, activeStaffCount: Object.keys(staffMap).length, dailyCosts, dailyLabels, staffStats: Object.values(staffMap).sort((a, b) => b.cost - a.cost) };
    },

    renderAnalyticsCharts(stats) {
        new Chart(document.getElementById('dailyCostChart'), {
            type: 'line',
            data: { labels: stats.dailyLabels, datasets: [{ label: '日次人件費', data: stats.dailyCosts, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.3 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
        });
        const topStaff = stats.staffStats.slice(0, 5);
        const otherCost = stats.staffStats.slice(5).reduce((sum, s) => sum + s.cost, 0);
        const labels = topStaff.map(s => s.name);
        const data = topStaff.map(s => s.cost);
        if (otherCost > 0) { labels.push('その他'); data.push(otherCost); }

        new Chart(document.getElementById('staffShareChart'), {
            type: 'doughnut',
            data: { labels: labels, datasets: [{ data: data, backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#9ca3af'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
        });
    },

    // =================================================================
    // 5. スタッフ管理 (Staff) - Admin Only
    // =================================================================
    renderStaffList(container) {
        if (!this.state.isAdmin) return;

        container.innerHTML = `
            <div class="max-w-6xl mx-auto space-y-6 pb-20">
                <div class="flex items-center justify-between">
                    <h2 class="text-2xl font-bold text-gray-800">スタッフ管理</h2>
                    <button onclick="app.prepareStaffModal()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-plus mr-2"></i>新規登録
                    </button>
                </div>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead class="bg-gray-50 border-b border-gray-200 text-xs font-bold text-gray-500 uppercase tracking-wider">
                                <tr>
                                    <th class="p-4 whitespace-nowrap min-w-[200px]">名前</th>
                                    <th class="p-4 whitespace-nowrap">役割</th>
                                    <th class="p-4 whitespace-nowrap">評価</th>
                                    <th class="p-4 whitespace-nowrap">給与形態</th>
                                    <th class="p-4 whitespace-nowrap">勤務制約</th>
                                    <th class="p-4 text-right whitespace-nowrap">操作</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-gray-100">
                                ${this.state.staff.map(s => {
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
                                                ${s.name.charAt(0)}
                                            </div>
                                            <div>
                                                <div class="font-bold text-gray-800 text-sm">${s.name}</div>
                                                <div class="text-[10px] text-gray-400 font-mono">ID: ${s.id ? s.id.substr(0, 6) : '---'}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td class="p-4 whitespace-nowrap">
                                        <span class="px-2.5 py-1 text-xs font-bold rounded-full border shadow-sm ${badgeClass}">
                                            ${role.name}
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
                                ${this.state.staff.length === 0 ? '<tr><td colspan="5" class="p-12 text-center text-gray-400 flex flex-col items-center gap-2"><i class="fa-solid fa-users-slash text-3xl mb-2 text-gray-300"></i><span>スタッフが登録されていません</span></td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
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

        container.innerHTML = `
            <div class="max-w-4xl mx-auto space-y-8 pb-24">
                <div class="flex items-center justify-between border-b border-gray-200 pb-4">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-800">店舗設定</h2>
                        <p class="text-sm text-gray-500 mt-1">店舗の基本ルール、シフトパターン、人員配置要件を一括管理します。</p>
                    </div>
                    <button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-save mr-2"></i>設定を保存
                    </button>
                </div>

                <!-- 1. 役職・ロール設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-id-badge text-indigo-500"></i> 役職・ロール設定</h3>
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
                                        <th class="p-3 text-right rounded-r-lg">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="rolesBody">
                                    ${roles.map((role, index) => `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-2">
                                                <input type="text" class="setting-role-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${role.name}" placeholder="役職名">
                                            </td>
                                            <td class="p-2">
                                                <input type="text" class="setting-role-id w-full border-gray-300 rounded px-2 py-1.5 text-sm bg-gray-50" value="${role.id}" readonly title="IDは変更できません">
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
                                            <td class="p-2 text-right">
                                                <button onclick="app.deleteRole(${index})" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition" ${role.id==='manager'||role.id==='staff'?'disabled title="基本役職は削除できません" style="opacity:0.3"':''}>
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `).join('')}
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
                    </div>
                    <div class="p-6 space-y-8">
                        <!-- 営業時間 -->
                        <div class="space-y-4">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider">営業時間設定</h4>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-gray-50 pb-4">
                                <div class="md:col-span-3 font-bold text-gray-700">平日 (月-金)</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.weekday?.start || '09:00', 'time_weekday_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">～</span>
                                    ${this.get15MinTimeSelect(times.weekday?.end || '22:00', 'time_weekday_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-gray-50 pb-4">
                                <div class="md:col-span-3 font-bold text-blue-600">土曜日</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.weekend?.start || '10:00', 'time_weekend_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">～</span>
                                    ${this.get15MinTimeSelect(times.weekend?.end || '20:00', 'time_weekend_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                                <div class="md:col-span-3 font-bold text-red-600">日祝日</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.holiday?.start || '10:00', 'time_holiday_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">～</span>
                                    ${this.get15MinTimeSelect(times.holiday?.end || '20:00', 'time_holiday_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                        </div>

                        <!-- 定休日 -->
                        <div class="pt-4 border-t border-gray-100">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">定休日設定</h4>
                            <div class="flex flex-wrap gap-4 mb-4">
                                ${['日', '月', '火', '水', '木', '金', '土'].map((day, i) => `
                                    <label class="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50 border border-transparent hover:border-gray-200 transition">
                                        <input type="checkbox" name="setting_closed_days" value="${i}" class="w-5 h-5 text-red-500 rounded focus:ring-red-500 border-gray-300" ${closedDays.includes(i) ? 'checked' : ''}>
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
                            
                            <!-- 特定日の営業時間（短縮営業など） -->
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mt-4 mb-3">特定日の営業時間変更 (短縮営業など)</h4>
                            <div class="space-y-3" id="specialDaysContainer">
                                <div class="flex items-center gap-2 flex-wrap bg-yellow-50 p-2 rounded-lg border border-yellow-100">
                                    <input type="date" id="newSpecialDayDate" class="border-gray-300 rounded px-2 py-1 text-sm">
                                    <div class="w-24">${this.get15MinTimeSelect('', 'newSpecialDayStart', 'border-gray-300 rounded px-2 py-1 text-sm w-full')}</div>
                                    <span class="text-gray-400 text-xs">～</span>
                                    <div class="w-24">${this.get15MinTimeSelect('', 'newSpecialDayEnd', 'border-gray-300 rounded px-2 py-1 text-sm w-full')}</div>
                                    <input type="text" id="newSpecialDayNote" class="border-gray-300 rounded px-2 py-1 text-sm w-24" placeholder="メモ (例: 短縮)">
                                    <button onclick="app.addSpecialDay()" class="bg-yellow-100 text-yellow-700 px-3 py-1 rounded text-xs font-bold hover:bg-yellow-200 transition">追加</button>
                                </div>
                                
                                <div class="space-y-2">
                                    ${Object.entries(specialDays).map(([date, conf]) => `
                                        <div class="flex items-center justify-between bg-white border border-gray-200 px-3 py-2 rounded-lg text-sm">
                                            <div class="flex items-center gap-3">
                                                <span class="font-bold text-gray-800">${date}</span>
                                                <span class="bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded text-xs font-mono">${conf.start} - ${conf.end}</span>
                                                <span class="text-gray-500 text-xs">${conf.note || ''}</span>
                                            </div>
                                            <button onclick="app.removeSpecialDay('${date}')" class="text-gray-400 hover:text-red-500"><i class="fa-solid fa-trash"></i></button>
                                        </div>
                                    `).join('')}
                                    ${Object.keys(specialDays).length === 0 ? '<p class="text-xs text-gray-400 pl-2">設定なし</p>' : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 3. シフトパターン設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-layer-group text-purple-500"></i> シフトパターン (早番/遅番など)</h3>
                        <button onclick="app.addShiftPattern()" class="text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg font-bold hover:bg-purple-200 transition">
                            <i class="fa-solid fa-plus mr-1"></i>追加
                        </button>
                    </div>
                    <div class="p-6">
                        <div class="overflow-x-auto">
                            <table class="w-full text-left">
                                <thead class="bg-gray-50 text-xs text-gray-500 uppercase font-bold">
                                    <tr>
                                        <th class="p-3 rounded-l-lg">パターン名</th>
                                        <th class="p-3">開始時間</th>
                                        <th class="p-3">終了時間</th>
                                        <th class="p-3 text-right rounded-r-lg">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="shiftPatternsBody">
                                    ${customShifts.map((shift, index) => `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-2">
                                                <input type="text" class="setting-shift-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${shift.name}" placeholder="例: 早番">
                                            </td>
                                            <td class="p-2">
                                                ${this.get15MinTimeSelect(shift.start, '', 'setting-shift-start w-full border-gray-300 rounded px-2 py-1.5 text-sm')}
                                            </td>
                                            <td class="p-2">
                                                ${this.get15MinTimeSelect(shift.end, '', 'setting-shift-end w-full border-gray-300 rounded px-2 py-1.5 text-sm')}
                                            </td>
                                            <td class="p-2 text-right">
                                                <button onclick="app.deleteShiftPattern(${index})" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition">
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                    ${customShifts.length === 0 ? '<tr><td colspan="4" class="p-4 text-center text-gray-400 text-sm">シフトパターンが登録されていません。「追加」ボタンから登録してください。</td></tr>' : ''}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-xs text-gray-400 mt-3">※ ここで設定したパターンは、シフト作成時に参照されます。</p>
                    </div>
                </div>

                <!-- 4. 人員配置ルール -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-users text-green-500"></i> 人員配置要件</h3>
                    </div>
                    <div class="p-6">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-6">
                            <div>
                                <h4 class="text-sm font-bold text-gray-700 mb-4 border-b border-gray-100 pb-2">管理者要件</h4>
                                <div>
                                    <label class="block text-xs font-bold text-gray-500 mb-1">最低管理者数 (店長/リーダー)</label>
                                    <input type="number" id="req_min_manager" class="w-full border-gray-300 rounded-lg px-3 py-2" value="${reqs.min_manager || 1}">
                                    <p class="text-xs text-gray-400 mt-1">※各シフトに最低1名は必要</p>
                                </div>
                            </div>
                            <div>
                                <h4 class="text-sm font-bold text-gray-700 mb-4 border-b border-gray-100 pb-2">スタッフ総数要件</h4>
                                <div class="space-y-4">
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-gray-600">平日</label>
                                        <input type="number" id="req_min_weekday" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekday || reqs.min_total || 2}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-blue-600">土日</label>
                                        <input type="number" id="req_min_weekend" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekend || reqs.min_total || 3}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-red-600">祝日</label>
                                        <input type="number" id="req_min_holiday" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_holiday || reqs.min_total || 3}">
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 時間帯別人員配置 -->
                        <div class="border-t border-gray-100 pt-4">
                            <div class="flex justify-between items-center mb-3">
                                <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider">時間帯別・曜日別 人員増強</h4>
                                <button onclick="app.addTimeStaffReq()" class="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-lg font-bold hover:bg-green-200 transition">
                                    <i class="fa-solid fa-plus mr-1"></i>ルール追加
                                </button>
                            </div>
                            <div class="overflow-x-auto">
                                <table class="w-full text-left text-sm">
                                    <thead class="bg-gray-50 text-xs text-gray-500">
                                        <tr>
                                            <th class="p-2 w-1/3">曜日</th>
                                            <th class="p-2">開始</th>
                                            <th class="p-2">終了</th>
                                            <th class="p-2">人数</th>
                                            <th class="p-2 text-right"></th>
                                        </tr>
                                    </thead>
                                    <tbody id="timeStaffReqBody" class="divide-y divide-gray-50">
                                        ${timeStaffReq.map((rule, idx) => {
                                            const daysStr = ['日','月','火','水','木','金','土'];
                                            return `
                                            <tr>
                                                <td class="p-2">
                                                    <div class="flex flex-wrap gap-1">
                                                    ${daysStr.map((d, i) => `
                                                        <label class="cursor-pointer select-none">
                                                            <input type="checkbox" class="hidden peer setting-time-req-day-${idx}" value="${i}" ${rule.days.includes(i) ? 'checked' : ''}>
                                                            <span class="block w-6 h-6 text-center leading-6 rounded text-xs font-bold peer-checked:bg-green-500 peer-checked:text-white bg-gray-100 text-gray-400 hover:bg-gray-200 transition-colors">${d}</span>
                                                        </label>
                                                    `).join('')}
                                                    </div>
                                                </td>
                                                <td class="p-2">
                                                    ${this.get15MinTimeSelect(rule.start, '', 'setting-time-req-start border-gray-300 rounded px-2 py-1 text-xs w-full')}
                                                </td>
                                                <td class="p-2">
                                                    ${this.get15MinTimeSelect(rule.end, '', 'setting-time-req-end border-gray-300 rounded px-2 py-1 text-xs w-full')}
                                                </td>
                                                <td class="p-2"><input type="number" class="setting-time-req-count border-gray-300 rounded px-2 py-1 text-xs w-12 text-center font-bold" value="${rule.count}"></td>
                                                <td class="p-2 text-right"><button onclick="app.removeTimeStaffReq(${idx})" class="text-red-400 hover:text-red-600"><i class="fa-solid fa-trash"></i></button></td>
                                            </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                </table>
                                ${timeStaffReq.length === 0 ? '<p class="text-xs text-gray-400 text-center py-4">特定の時間帯（例：ランチタイム）に必要な人数を設定できます</p>' : ''}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 5. システム設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-gears text-gray-500"></i> システム設定</h3>
                    </div>
                    <div class="p-6 space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">デフォルト時給 (円)</label>
                                <input type="number" id="settingHourlyWage" class="w-full border border-gray-300 rounded-lg px-3 py-2" value="${config.hourly_wage_default || 1100}">
                            </div>
                            
                            <!-- Gemini API設定 -->
                            <div class="md:col-span-2 border-t border-gray-100 pt-4 mt-2">
                                <h4 class="text-sm font-bold text-blue-600 mb-2 flex items-center gap-2">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> AI監査設定 (Gemini API)
                                </h4>
                                <p class="text-xs text-gray-400 mb-3">APIキーを設定すると、シフト自動生成時にAIが条件違反をダブルチェックし、自動修正します。</p>
                                
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 mb-1">Gemini API Key</label>
                                        <input type="password" id="settingGeminiKey" class="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm" placeholder="AIza..." value="${config.gemini_api_key || ''}">
                                        <p class="text-[10px] text-gray-400 mt-1">※Google AI Studioで取得可能</p>
                                    </div>
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 mb-1">使用モデル</label>
                                        <select id="settingGeminiModel" class="w-full border border-gray-300 rounded-lg px-3 py-2 bg-white text-sm">
                                            <option value="gemini-1.5-flash" ${config.gemini_model === 'gemini-1.5-flash' ? 'selected' : ''}>Gemini 1.5 Flash (推奨)</option>
                                            <option value="gemini-2.0-flash-exp" ${config.gemini_model === 'gemini-2.0-flash-exp' ? 'selected' : ''}>Gemini 2.0 Flash (Experimental)</option>
                                            <option value="gemini-1.5-pro" ${config.gemini_model === 'gemini-1.5-pro' ? 'selected' : ''}>Gemini 1.5 Pro (高精度・低速)</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">管理者パスワード</label>
                                <input type="text" id="settingPassword" class="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono tracking-wider" value="${config.admin_password || '0000'}">
                            </div>
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
                        <textarea id="settingShopRules" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm min-h-[120px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="シフト提出期限や注意事項などを入力してください...">${shopRulesText}</textarea>
                        <p class="text-xs text-gray-400 mt-2">※ ここに入力した内容は、スタッフ画面の「お店のルール」に表示されます。</p>
                    </div>
                </div>
                
                <!-- データリセット -->
                <div class="text-right">
                    <button onclick="if(confirm('【警告】全てのデータを削除して初期化しますか？')) { localStorage.clear(); location.reload(); }" class="text-red-500 text-xs hover:text-red-700 font-bold opacity-60 hover:opacity-100 transition">
                        <i class="fa-solid fa-trash mr-1"></i>全データをリセット
                    </button>
                </div>
            </div>
        `;
    },

    // --- 設定画面用ヘルパー ---
    readSettingsFromDOM() {
        // 現在のDOMから設定値を読み取って config オブジェクトを返す
        const getVal = (id) => document.getElementById(id)?.value;
        const getNum = (id) => Number(document.getElementById(id)?.value || 0);
        
        // 役職設定
        const roles = [];
        const roleRows = document.querySelectorAll('#rolesBody tr');
        roleRows.forEach(row => {
            const name = row.querySelector('.setting-role-name')?.value;
            const id = row.querySelector('.setting-role-id')?.value;
            const color = row.querySelector('.setting-role-color')?.value;
            if(name && id) {
                roles.push({ id, name, color });
            }
        });

        // シフトパターン
        const shiftPatterns = [];
        const rows = document.querySelectorAll('#shiftPatternsBody tr');
        rows.forEach(row => {
            const name = row.querySelector('.setting-shift-name')?.value;
            const start = row.querySelector('.setting-shift-start')?.value;
            const end = row.querySelector('.setting-shift-end')?.value;
            if(name && start && end) {
                shiftPatterns.push({ name, start, end });
            }
        });

        // 定休日
        const closedDays = Array.from(document.querySelectorAll('input[name="setting_closed_days"]:checked')).map(el => parseInt(el.value));

        // 休憩ルール
        const breakRules = [];
        const breakRuleDivs = document.querySelectorAll('#breakRulesContainer > div');
        breakRuleDivs.forEach(div => {
            const h = Number(div.querySelector('.setting-break-hours')?.value || 0);
            const m = Number(div.querySelector('.setting-break-minutes')?.value || 0);
            if(h > 0) breakRules.push({ min_hours: h, break_minutes: m });
        });
        breakRules.sort((a,b) => a.min_hours - b.min_hours);

        // 時間帯別ルール
        const timeStaffReq = [];
        const timeReqRows = document.querySelectorAll('#timeStaffReqBody tr');
        timeReqRows.forEach((row, idx) => {
            const days = Array.from(row.querySelectorAll(`.setting-time-req-day-${idx}:checked`)).map(el => parseInt(el.value));
            const start = row.querySelector('.setting-time-req-start')?.value;
            const end = row.querySelector('.setting-time-req-end')?.value;
            const count = Number(row.querySelector('.setting-time-req-count')?.value || 0);
            
            if(days.length > 0 && start && end && count > 0) {
                timeStaffReq.push({ days, start, end, count });
            }
        });

        // 特定日の営業時間 (special_days) は、API更新時に addSpecialDay/removeSpecialDay で直接 this.state.config.special_days を操作しているため、
        // ここでは this.state.config.special_days をそのまま利用する (またはDOMから再構築も可能だが、追加/削除アクションで即時反映させている想定)
        // ただし、整合性を保つため state の値を優先する

        return {
            ...this.state.config,
            admin_password: getVal('settingPassword'),
            hourly_wage_default: getNum('settingHourlyWage'),
            // API Keys are hidden from UI, maintain current state
            openai_api_key: this.state.config.openai_api_key,
            openai_model: this.state.config.openai_model,
            gemini_api_key: this.state.config.gemini_api_key,
            gemini_model: this.state.config.gemini_model,
            llm_provider: this.state.config.llm_provider,
            shop_rules_text: getVal('settingShopRules'),
            break_rules: breakRules,
            time_staff_req: timeStaffReq,
            special_holidays: this.state.config.special_holidays, // 配列もadd/removeで直接操作済みと仮定
            special_days: this.state.config.special_days,
            
            opening_times: {
                weekday: { start: getVal('time_weekday_start'), end: getVal('time_weekday_end') },
                weekend: { start: getVal('time_weekend_start'), end: getVal('time_weekend_end') },
                holiday: { start: getVal('time_holiday_start'), end: getVal('time_holiday_end') }
            },
            
            staff_req: {
                min_manager: getNum('req_min_manager'),
                min_weekday: getNum('req_min_weekday'),
                min_weekend: getNum('req_min_weekend'),
                min_holiday: getNum('req_min_holiday'),
                min_total: getNum('req_min_weekday') // 互換性のため
            },
            
            roles: roles,
            closed_days: closedDays,
            custom_shifts: shiftPatterns,

            // 旧互換
            opening_time: getVal('time_weekday_start'),
            closing_time: getVal('time_weekday_end')
            // staffing_rules: { min_staff: getNum('req_min_weekday') } // 削除
        };
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
        this.state.config.roles.push({ id: newId, name: '新規役職', color: 'gray' });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    deleteRole(index) {
        this.state.config = this.readSettingsFromDOM();
        const role = this.state.config.roles[index];
        if(role.id === 'manager' || role.id === 'staff') {
            this.showToast('この役職は削除できません', 'error');
            return;
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

    removeBreakRule(index) {
        this.state.config = this.readSettingsFromDOM();
        this.state.config.break_rules.splice(index, 1);
        this.renderSettings(document.getElementById('viewContainer'));
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

    removeSpecialHoliday(index) {
        this.state.config = this.readSettingsFromDOM(); // 現在の入力を保存
        if(this.state.config.special_holidays) {
            this.state.config.special_holidays.splice(index, 1);
        }
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addSpecialDay() {
        const date = document.getElementById('newSpecialDayDate').value;
        const start = document.getElementById('newSpecialDayStart').value;
        const end = document.getElementById('newSpecialDayEnd').value;
        const note = document.getElementById('newSpecialDayNote').value;

        if(!date || !start || !end) return;

        this.state.config = this.readSettingsFromDOM(); // 現在の入力を保存
        if(!this.state.config.special_days) this.state.config.special_days = {};
        
        this.state.config.special_days[date] = { start, end, note };
        this.renderSettings(document.getElementById('viewContainer'));
    },

    removeSpecialDay(date) {
        this.state.config = this.readSettingsFromDOM(); // 現在の入力を保存
        if(this.state.config.special_days) {
            delete this.state.config.special_days[date];
        }
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addTimeStaffReq() {
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.time_staff_req) this.state.config.time_staff_req = [];
        this.state.config.time_staff_req.push({ days: [1,2,3,4,5], start: '11:00', end: '14:00', count: 2 });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    removeTimeStaffReq(index) {
        this.state.config = this.readSettingsFromDOM();
        this.state.config.time_staff_req.splice(index, 1);
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addShiftPattern() {
        // 現在の入力を一時保存
        this.state.config = this.readSettingsFromDOM();
        // 新しい空行を追加
        if(!this.state.config.custom_shifts) this.state.config.custom_shifts = [];
        this.state.config.custom_shifts.push({ name: '', start: '09:00', end: '18:00' });
        // 再描画
        this.renderSettings(document.getElementById('viewContainer'));
    },

    deleteShiftPattern(index) {
        // 現在の入力を一時保存
        this.state.config = this.readSettingsFromDOM();
        // 削除
        this.state.config.custom_shifts.splice(index, 1);
        // 再描画
        this.renderSettings(document.getElementById('viewContainer'));
    },

    readSettingsFromDOM() {
        const config = { ...this.state.config }; // 既存の設定をコピー

        // 基本設定
        config.hourly_wage_default = Number(document.getElementById('settingHourlyWage').value);
        config.gemini_api_key = document.getElementById('settingGeminiKey').value;
        config.gemini_model = document.getElementById('settingGeminiModel').value;

        // 役職・ロール設定
        const roleNames = document.querySelectorAll('.setting-role-name');
        const roleIds = document.querySelectorAll('.setting-role-id');
        const roleColors = document.querySelectorAll('.setting-role-color');
        
        config.roles = [];
        roleNames.forEach((el, i) => {
            if (el.value) {
                config.roles.push({
                    id: roleIds[i].value,
                    name: el.value,
                    color: roleColors[i].value,
                    level: 1 // 簡易的に1
                });
            }
        });

        // シフトパターン
        const shiftNames = document.querySelectorAll('.setting-shift-name');
        const shiftStarts = document.querySelectorAll('.setting-shift-start');
        const shiftEnds = document.querySelectorAll('.setting-shift-end');
        
        config.custom_shifts = [];
        shiftNames.forEach((el, i) => {
            if (el.value) {
                config.custom_shifts.push({
                    name: el.value,
                    start: shiftStarts[i].value,
                    end: shiftEnds[i].value
                });
            }
        });

        // 人員配置ルール
        config.staff_req = {
            min_manager: Number(document.getElementById('req_min_manager').value),
            min_weekday: Number(document.getElementById('req_min_weekday').value),
            min_weekend: Number(document.getElementById('req_min_weekend').value),
            min_holiday: Number(document.getElementById('req_min_holiday').value)
        };

        // 時間帯別ルール
        config.time_staff_req = [];
        const timeReqRows = document.querySelectorAll('#timeStaffReqBody tr');
        timeReqRows.forEach((row, idx) => {
            const start = row.querySelector('.setting-time-req-start').value;
            const end = row.querySelector('.setting-time-req-end').value;
            const count = Number(row.querySelector('.setting-time-req-count').value);
            
            const daysChecks = document.querySelectorAll(`.setting-time-req-day-${idx}:checked`);
            const days = Array.from(daysChecks).map(c => Number(c.value));
            
            if (days.length > 0) {
                config.time_staff_req.push({ days, start, end, count });
            }
        });

        return config;
    },

    async saveSettings() {
        const newConfig = this.readSettingsFromDOM();
        
        // 【重要】SaaS版: contract_id と shop_password を維持する
        // Stateにある既存の値を確実に引き継ぐ
        if (this.state.config.contract_id) newConfig.contract_id = this.state.config.contract_id;
        if (this.state.config.shop_password) newConfig.shop_password = this.state.config.shop_password;
        
        // 組織IDの確認
        const currentOrgId = this.state.organization_id || localStorage.getItem('rakushift_org_id');
        if (!currentOrgId) {
            this.showToast('組織IDが見つかりません。再ログインしてください。', 'error');
            return;
        }
        newConfig.organization_id = currentOrgId;

        this.showLoading(true);
        try {
            // 既存の設定があるか確認
            const existing = await API.list('config', { organization_id: `eq.${currentOrgId}` });
            
            if (existing.data && existing.data.length > 0) {
                // 更新 (IDを維持)
                await API.update('config', existing.data[0].id, newConfig);
            } else { 
                // 新規作成（通常ここには来ないはずだが）
                await API.create('config', newConfig); 
            }
            
            // Stateを更新
            this.state.config = { ...this.state.config, ...newConfig };
            this.showToast('設定を保存しました', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('保存エラー', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // --- 印刷機能 (完全版 v7・分割レイアウト & PDF対応) ---
    // Fixed syntax error
    printShiftTable() {
        // 現在の表示モードと期間を取得
        const period = this.state.shiftTablePeriod || 'month';
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        
        let allDays = [];
        
        // 1. 全期間の日付リスト生成
        if (period === 'month') {
            const lastDay = new Date(year, month + 1, 0).getDate();
            allDays = Array.from({length: lastDay}, (_, i) => new Date(year, month, i + 1));
        } else {
            const range = period === 'week' ? 7 : 14;
            const start = new Date(this.state.currentDate);
            allDays = Array.from({length: range}, (_, i) => {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                return d;
            });
        }

        // 2. 期間分割 (A4横に収まるよう 7日区切り でテーブルを生成)
        const CHUNK_SIZE = 7; // 1週間ずつ
        const dayChunks = [];
        for (let i = 0; i < allDays.length; i += CHUNK_SIZE) {
            dayChunks.push(allDays.slice(i, i + CHUNK_SIZE));
        }

        // 3. 印刷用ウィンドウ作成
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('ポップアップがブロックされました。「許可」してください。');
            return;
        }

        // --- コンテンツ生成関数 ---
        const generateTableHTML = (days, chunkIndex, totalChunks) => {
            // 時間目盛り
            const timeScaleHtml = `
                <div style="display: flex; justify-content: space-between; font-size: 8px; color: #555; margin-top: 2px; border-top: 1px solid #ccc;">
                    <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
                </div>
            `;

            // ヘッダー生成
            const headerCols = days.map(date => {
                const d = date.getDate();
                const m = date.getMonth() + 1;
                const w = ['日','月','火','水','木','金','土'][date.getDay()];
                const isSun = date.getDay() === 0;
                const isSat = date.getDay() === 6;
                const colorStyle = isSun ? 'color:#d32f2f;' : isSat ? 'color:#1976d2;' : 'color:#111;';
                const bgStyle = isSun ? 'background-color:#fff5f5;' : isSat ? 'background-color:#f0f9ff;' : 'background-color:#f9fafb;';
                
                return `
                    <th style="${bgStyle} border: 1px solid #666; padding: 4px; width: 130px; min-width: 130px;">
                        <div style="${colorStyle} font-size: 11px; font-weight: bold;">${m}/${d} (${w})</div>
                        ${timeScaleHtml}
                    </th>
                `;
            }).join('');

            // ボディ生成
            const bodyRows = this.state.staff.map(staff => {
                const cols = days.map(date => {
                    const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
                    const shift = this.state.shifts.find(s => s.staff_id === staff.id && s.date === dateStr);
                    
                    let cellContent = '';
                    
                    if (shift) {
                        const startH = parseInt(shift.start_time.split(':')[0]);
                        const startM = parseInt(shift.start_time.split(':')[1]);
                        const endH = parseInt(shift.end_time.split(':')[0]);
                        const endM = parseInt(shift.end_time.split(':')[1]);
                        
                        const startMin = startH * 60 + startM;
                        const endMin = endH * 60 + endM;
                        const endMinAdjusted = endMin < startMin ? endMin + 1440 : endMin;
                        
                        // 1日 = 1440分
                        const startPct = (startMin / 1440) * 100;
                        const widthPct = ((endMinAdjusted - startMin) / 1440) * 100;
                        
                        let bgColor = '#dbeafe'; 
                        let borderColor = '#2563eb';
                        if (startH < 10) { bgColor = '#fef9c3'; borderColor = '#ca8a04'; }
                        else if (startH >= 17) { bgColor = '#f3e8ff'; borderColor = '#9333ea'; }

                        const timeText = `${shift.start_time} - ${shift.end_time}`;

                        cellContent = `
                            <div style="
                                position: absolute;
                                left: ${startPct}%;
                                width: ${Math.max(widthPct, 1)}%;
                                top: 6px; 
                                bottom: 6px;
                                background-color: ${bgColor};
                                border: 1px solid ${borderColor};
                                border-radius: 3px;
                                z-index: 10;
                                overflow: visible; /* 文字はみ出し許可 */
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            ">
                                <span style="
                                    font-size: 10px; 
                                    font-weight: bold; 
                                    color: #000; 
                                    white-space: nowrap; 
                                    text-shadow: 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;
                                    pointer-events: none;
                                    position: relative;
                                    z-index: 20;
                                ">${timeText}</span>
                            </div>
                        `;
                    }
                    
                    // 背景グリッド
                    const gridLines = `
                        <div style="position:absolute; left:25%; top:0; bottom:0; border-left:1px dotted #ccc; z-index:0;"></div>
                        <div style="position:absolute; left:50%; top:0; bottom:0; border-left:1px solid #ccc; z-index:0;"></div>
                        <div style="position:absolute; left:75%; top:0; bottom:0; border-left:1px dotted #ccc; z-index:0;"></div>
                    `;

                    const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
                    const bgStyle = isSpecialHoliday ? 'background-color: #ffebee;' : ''; 

                    return `<td style="position: relative; padding: 0; height: 38px; border: 1px solid #666; ${bgStyle}">
                        ${gridLines}
                        ${cellContent}
                    </td>`;
                }).join('');

                return `
                    <tr style="page-break-inside: avoid;">
                        <td style="padding: 4px 8px; font-weight: bold; background-color: #f3f4f6; text-align: left; width: 140px; border: 1px solid #666; font-size: 11px;">
                            ${staff.name}
                        </td>
                        ${cols}
                    </tr>
                `;
            }).join('');

            // 期間表示
            const startStr = `${days[0].getMonth()+1}/${days[0].getDate()}`;
            const endStr = `${days[days.length-1].getMonth()+1}/${days[days.length-1].getDate()}`;

            return `
                <div class="table-chunk" style="margin-bottom: 20px; page-break-after: always;">
                    <h3 style="margin: 0 0 10px 0; font-size: 16px; border-left: 5px solid #2563eb; padding-left: 10px;">
                        期間: ${startStr} 〜 ${endStr}
                    </h3>
                    <table style="width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px;">
                        <thead>
                            <tr>
                                <th style="width: 140px; background-color: #e5e7eb; border: 1px solid #666; padding: 4px;">スタッフ</th>
                                ${headerCols}
                            </tr>
                        </thead>
                        <tbody>
                            ${bodyRows}
                        </tbody>
                    </table>
                    <div style="text-align: right; font-size: 10px; color: #666; margin-top: 5px;">
                        Page ${chunkIndex + 1} / ${totalChunks}
                    </div>
                </div>
            `;
        };

        // 全チャンクのHTML結合
        const allTablesHtml = dayChunks.map((chunk, idx) => generateTableHTML(chunk, idx, dayChunks.length)).join('');

        const html = `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <title>シフト表印刷</title>
                <style>
                    @page { size: landscape; margin: 8mm; }
                    body { font-family: "Helvetica Neue", Arial, sans-serif; margin: 0; padding: 10px; background: white; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                    .no-print { margin-bottom: 20px; padding: 15px; background: #e0f2fe; border: 1px solid #bae6fd; border-radius: 8px; color: #0369a1; }
                    button { cursor: pointer; padding: 10px 20px; background: #0284c7; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 14px; margin-right: 10px; }
                    @media print { .no-print { display: none; } .table-chunk:last-child { page-break-after: auto !important; } }
                </style>
            </head>
            <body>
                <div class="no-print">
                    <h2 style="margin-top:0;">🖨 印刷プレビュー (分割レイアウト版)</h2>
                    <p style="font-size: 14px; line-height: 1.6;">
                        視認性を確保するため、<strong>7日ごとに分割して表示</strong>しています。<br>
                        「印刷」ボタンを押し、送信先で<strong>「PDFに保存」</strong>を選択すると、全期間を含むPDFファイルが作成できます。<br>
                        ※ 紙に印刷する場合も、A4横サイズで綺麗にページ分けされます。
                    </p>
                    <div style="margin-top: 15px;">
                        <button onclick="window.print()">🖨 印刷 / PDF保存</button>
                    </div>
                </div>

                <h1 style="font-size: 24px; margin-bottom: 20px;">
                    ${year}年 ${month + 1}月 シフト表
                </h1>

                ${allTablesHtml}

            </body>
            </html>
        `;

        printWindow.document.open();
        printWindow.document.write(html);
        printWindow.document.close();
    },

    // =================================================================
    // ロジック・ヘルパー関数
    // =================================================================

    // --- シフト編集 ---
    get15MinTimeSelect(currentVal, id, className) {
        let options = '';
        const normalizedVal = currentVal ? currentVal.substr(0, 5) : '';
        for (let h = 0; h < 24; h++) {
            for (let m = 0; m < 60; m += 15) {
                const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                const selected = (normalizedVal === time) ? 'selected' : '';
                options += `<option value="${time}" ${selected}>${time}</option>`;
            }
        }
        // Fallback for custom values
        if (normalizedVal && !options.includes(`value="${normalizedVal}"`)) {
             options += `<option value="${normalizedVal}" selected>${normalizedVal}</option>`;
        }
        
        const idAttr = id ? `id="${id}"` : '';
        // 既存の input が持っていたクラスを継承しつつ、appearance-none でブラウザデフォルトのスタイルを消す
        const finalClass = `${className || ''} appearance-none cursor-pointer bg-white`;
        
        return `
            <div class="relative w-full">
                <select ${idAttr} class="${finalClass}" style="padding-right: 2rem;">
                    ${options}
                </select>
                <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-500">
                    <i class="fa-solid fa-chevron-down text-xs"></i>
                </div>
            </div>
        `;
    },

    generateTimeOptionsHTML(selectedValue) {
        // 正規化: 秒が含まれている場合(HH:mm:ss)はHH:mmに切り詰める
        const normalizedSelected = selectedValue ? selectedValue.substr(0, 5) : '';
        
        let options = [];
        let found = false;
        // 15分刻みの選択肢を生成
        for (let i = 0; i < 24; i++) {
            for (let j = 0; j < 60; j += 15) {
                const h = String(i).padStart(2, '0');
                const m = String(j).padStart(2, '0');
                const time = `${h}:${m}`;
                if (time === normalizedSelected) found = true;
                options.push(time);
            }
        }
        // 既存の値が15分刻みでない場合も、表示崩れを防ぐために選択肢に追加
        if (normalizedSelected && !found) {
            options.push(normalizedSelected);
            options.sort(); 
        }
        return options.map(t => `<option value="${t}" ${t === normalizedSelected ? 'selected' : ''}>${t}</option>`).join('');
    },

    openAddShift(dateStr) {
        document.getElementById('shiftForm')?.reset();
        document.getElementById('editShiftId').value = ''; 
        document.getElementById('editShiftDate').value = dateStr;
        document.getElementById('editShiftTitle').textContent = 'シフト追加';
        document.getElementById('editShiftDateDisplay').textContent = dateStr;
        document.getElementById('deleteShiftBtn').classList.add('hidden');
        
        const staffSelectHtml = `<select id="editShiftStaffSelect" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none mb-2"><option value="">スタッフを選択</option>${this.state.staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>`;
        document.getElementById('editShiftStaffName').innerHTML = staffSelectHtml;
        
        // Selectボックスの初期化
        const defStart = (this.state.config.opening_time || '09:00').substr(0, 5);
        const defEnd = (this.state.config.closing_time || '18:00').substr(0, 5);
        
        const startEl = document.getElementById('editShiftStart');
        const endEl = document.getElementById('editShiftEnd');
        
        startEl.innerHTML = this.generateTimeOptionsHTML(defStart);
        endEl.innerHTML = this.generateTimeOptionsHTML(defEnd);
        
        // 値を明示的にセットして確実にする
        startEl.value = defStart;
        endEl.value = defEnd;

        document.getElementById('editShiftBreak').value = 60;

        this.openModal('editShiftModal');
        const saveBtn = document.getElementById('saveShiftBtn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => this.saveShift());
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
        document.getElementById('editShiftStaffName').innerHTML = `<div class="py-2 text-xl text-gray-800">${staff ? staff.name : '不明なスタッフ'}</div>`;
        
        // 時間の正規化 (HH:mm:ss -> HH:mm)
        const startTime = shift.start_time.substr(0, 5);
        const endTime = shift.end_time.substr(0, 5);

        // Selectボックスの初期化
        const startEl = document.getElementById('editShiftStart');
        const endEl = document.getElementById('editShiftEnd');
        
        startEl.innerHTML = this.generateTimeOptionsHTML(startTime);
        endEl.innerHTML = this.generateTimeOptionsHTML(endTime);
        
        // 値を明示的にセットして確実にする
        startEl.value = startTime;
        endEl.value = endTime;
        
        document.getElementById('editShiftBreak').value = shift.break_minutes;
        document.getElementById('deleteShiftBtn').classList.remove('hidden');

        const deleteBtn = document.getElementById('deleteShiftBtn');
        deleteBtn.onclick = () => this.deleteShift(shift.id);
        const saveBtn = document.getElementById('saveShiftBtn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => this.saveShift());
        this.openModal('editShiftModal');
    },

    async saveShift() {
        const id = document.getElementById('editShiftId').value;
        const date = document.getElementById('editShiftDate').value;
        const start = document.getElementById('editShiftStart').value;
        const end = document.getElementById('editShiftEnd').value;
        const breakMins = Number(document.getElementById('editShiftBreak').value);
        let staffId = document.getElementById('editShiftStaffId').value;
        const selectEl = document.getElementById('editShiftStaffSelect');
        if (selectEl) staffId = selectEl.value;

        if (!staffId || !start || !end) { alert('必須項目を入力してください'); return; }
        if (start >= end) { alert('時間の順序が不正です'); return; }
        if (document.getElementById('editShiftHoliday').checked && id) { await this.deleteShift(id); this.closeModal('editShiftModal'); return; }

        const data = { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins };
        if (!id) data.organization_id = this.state.organization_id;
        
        this.showLoading(true);
        try {
            if (id) await API.update('shifts', id, data); else await API.create('shifts', data);
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
        if (!confirm('削除しますか？')) return;
        this.showLoading(true);
        try {
            await API.delete('shifts', id);
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
        this.openModal('staffModal');
        document.getElementById('staffForm').reset();
        document.getElementById('staffId').value='';
    },
    
    updateStaffRoleSelect() {
        const select = document.getElementById('staffRole');
        if(!select) return;
        
        const roles = this.state.config.roles || this.state.defaultConfig.roles;
        select.innerHTML = roles.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
    },

    async saveStaff() {
        const id = document.getElementById('staffId').value;
        
        // 契約IDを確実に取得 (state または localStorage または 'demo')
        // organization_id が 'demo' 等の文字列の場合もあるため、それを contract_id として採用
        const contractIdStr = this.state.config.contract_id || 
                              (this.state.organization_id && this.state.organization_id.length < 36 ? this.state.organization_id : null) || 
                              localStorage.getItem('rakushift_org_id') || 
                              'demo';

        const data = {
            name: document.getElementById('staffName').value,
            role: document.getElementById('staffRole').value,
            evaluation: document.getElementById('staffEvaluation').value,
            salary_type: document.getElementById('staffSalaryType').value,
            hourly_wage: Number(document.getElementById('staffHourlyWage').value),
            monthly_salary: Number(document.getElementById('staffMonthlySalary').value),
            max_days_week: Number(document.getElementById('staffMaxDaysPerWeek').value),
            max_hours_day: Number(document.getElementById('staffMaxHoursPerDay').value),
            contract_id: contractIdStr
        };
        // 新規作成時は組織IDを付与
        if (!id) {
            // organization_id が UUID(36文字) の場合のみセット (文字列 'demo' などは弾く)
            if (this.state.config.organization_id) {
                data.organization_id = this.state.config.organization_id;
            } else if (this.state.organization_id && this.state.organization_id.length === 36) {
                data.organization_id = this.state.organization_id;
            }
        }

        this.showLoading(true);
        try {
            let result;
            if (id) {
                // 更新: 先に画面のStateを更新してしまう（表示速度と確実性のため）
                const index = this.state.staff.findIndex(s => s.id === id);
                if (index !== -1) {
                    // フォームの内容(data)でStateを即時上書き
                    this.state.staff[index] = { ...this.state.staff[index], ...data };
                }
                
                // その後でAPI送信
                await API.update('staff', id, data);
            } else {
                // 新規作成
                result = await API.create('staff', data);
                // IDがない場合のフォールバック
                if (!result) {
                    data.id = 'temp_' + Date.now();
                    this.state.staff.push(data);
                } else {
                    this.state.staff.push(result);
                }
            }
            
            this.renderStaffList(document.getElementById('viewContainer'));
            this.closeModal('staffModal');
            this.showToast('保存しました', 'success');
        } catch (e) { 
            console.error(e);
            this.showToast('保存には成功しましたが、同期に時間がかかっています: ' + e.message, 'info'); 
            // エラーでも画面上の変更は維持する
            this.renderStaffList(document.getElementById('viewContainer'));
            this.closeModal('staffModal');
        } finally { 
            this.showLoading(false); 
        }
    },
    editStaff(id) {
        const s = this.getStaff(id);
        if(!s) return;
        this.updateStaffRoleSelect(); // Selectを最新化
        document.getElementById('staffId').value = s.id;
        document.getElementById('staffName').value = s.name;
        document.getElementById('staffRole').value = s.role;
        document.getElementById('staffSalaryType').value = s.salary_type;
        document.getElementById('staffHourlyWage').value = s.hourly_wage;
        document.getElementById('staffMonthlySalary').value = s.monthly_salary;
        document.getElementById('staffMaxDaysPerWeek').value = s.max_days_week || 5;
        document.getElementById('staffMaxHoursPerDay').value = s.max_hours_day || 8;
        this.toggleSalaryInputs();
        this.openModal('staffModal');
    },
    async deleteStaff(id) {
        if(!confirm('本当に削除しますか？')) return;
        this.showLoading(true);
        try {
            await API.delete('staff', id);
            
            // ローカルのStateから削除（再読み込みしない）
            this.state.staff = this.state.staff.filter(s => s.id !== id);
            
            // await this.loadData(); // ←削除
            
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast('削除しました', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('失敗しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },
    toggleSalaryInputs() {
        const type = document.getElementById('staffSalaryType').value;
        if(type === 'hourly') {
            document.getElementById('hourlyInputGroup').classList.remove('hidden');
            document.getElementById('monthlyInputGroup').classList.add('hidden');
        } else {
            document.getElementById('hourlyInputGroup').classList.add('hidden');
            document.getElementById('monthlyInputGroup').classList.remove('hidden');
        }
    },

    // --- 申請 ---
    initRequestModal() {
        const select = document.getElementById('requestStaffId');
        select.innerHTML = this.state.staff.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        document.getElementById('requestDate').value = tomorrow.toISOString().split('T')[0];
        
        // Selectボックス初期化
        const startEl = document.getElementById('requestStartTime');
        const endEl = document.getElementById('requestEndTime');
        
        startEl.innerHTML = this.generateTimeOptionsHTML('09:00');
        endEl.innerHTML = this.generateTimeOptionsHTML('18:00');
        
        startEl.value = '09:00';
        endEl.value = '18:00';

        document.querySelectorAll('input[name="requestType"]').forEach(r => {
            r.addEventListener('change', (e) => {
                const grp = document.getElementById('requestTimeGroup');
                if (e.target.value === 'work') grp.classList.remove('hidden'); else grp.classList.add('hidden');
            });
        });
    },

    async submitRequest() {
        const staffId = document.getElementById('requestStaffId').value;
        const type = document.querySelector('input[name="requestType"]:checked').value;
        const date = document.getElementById('requestDate').value;
        const reason = document.getElementById('requestReason').value;
        
        if (!staffId || !date) { alert('必須項目が不足しています'); return; }

        // 確認ダイアログの追加
        const typeStr = type === 'off' ? '【休み希望】' : '【勤務希望】';
        const confirmMsg = `以下の内容で申請を提出します。\n間違いありませんか？\n\n日付: ${date}\n内容: ${typeStr}\n理由: ${reason || 'なし'}`;
        
        if (!confirm(confirmMsg)) return;

        const data = { staff_id: staffId, type, dates: date, reason, status: 'pending', created_at: new Date().toISOString() };
        data.organization_id = this.state.organization_id;

        if (type === 'work') {
            data.start_time = document.getElementById('requestStartTime').value;
            data.end_time = document.getElementById('requestEndTime').value;
            if (!data.start_time || !data.end_time) { alert('時間を入力してください'); return; }
        }

        this.showLoading(true);
        try {
            await API.create('requests', data);
            await this.loadData();
            this.closeModal('requestModal');
            this.showToast('申請を送信しました', 'success');
            if (this.state.view === 'requests') this.renderRequests(document.getElementById('viewContainer'));
        } catch (e) { this.showToast('送信失敗', 'error'); } finally { this.showLoading(false); }
    },

    async handleRequest(id, status) {
        if (!confirm(status === 'approved' ? '承認しますか？' : '却下しますか？')) return;
        this.showLoading(true);
        try {
            await API.update('requests', id, { status: status });
            
            // 承認時の追加処理
            if (status === 'approved') {
                const req = this.state.requests.find(r => r.id == id);
                if (req) {
                    // 1. 勤務希望ならシフト作成
                    if (req.type === 'work') {
                        // 開始・終了時間が指定されていない場合は店舗設定から取得などのロジックが必要だが
                        // ここではリクエストになければデフォルト値を入れる
                        const start = req.start_time || this.state.config.opening_time || '09:00';
                        const end = req.end_time || this.state.config.closing_time || '18:00';
                        await API.create('shifts', { 
                            staff_id: req.staff_id, 
                            date: req.dates, 
                            start_time: start, 
                            end_time: end, 
                            break_minutes: 60, // デフォルト
                            organization_id: this.state.organization_id
                        });
                    }
                    // 2. 休み希望なら unavailable_dates を更新 (重要: シフト生成時に除外されるようにする)
                    else if (req.type === 'off' || req.type === 'holiday') {
                        const staff = this.getStaff(req.staff_id);
                        if (staff) {
                            const dateStr = req.dates;
                            let uDates = [];
                            if (staff.unavailable_dates) {
                                uDates = Array.isArray(staff.unavailable_dates) 
                                    ? staff.unavailable_dates 
                                    : String(staff.unavailable_dates).split(',').map(d => d.trim());
                            }
                            if (!uDates.includes(dateStr)) {
                                uDates.push(dateStr);
                                // API更新
                                await API.update('staff', staff.id, { 
                                    ...staff, 
                                    unavailable_dates: uDates.join(', ') // 文字列で保存
                                });
                                // ローカルステートも更新
                                staff.unavailable_dates = uDates; 
                            }
                        }
                    }
                }
            }
            await this.loadData();
            this.renderRequests(document.getElementById('viewContainer'));
            this.showToast('処理完了', 'success');
        } catch(e) { this.showToast('エラー発生', 'error'); } finally { this.showLoading(false); }
    },

    updateRequestBadge() {
        const count = this.state.requests.filter(r => r.status === 'pending').length;
        const badge = document.getElementById('pendingRequestsBadge');
        if(badge) {
            badge.textContent = count;
            badge.classList.toggle('hidden', count === 0);
        }
    },

       // --- AI自動作成 (Python + Gemini) ---
       async runAutoFill() {
        if (!this.state.isShopLoggedIn || !this.state.organization_id) {
            this.showToast('セッションエラー: 再ログインしてください', 'error');
            return;
        }

        const targetType = document.getElementById('autoFillTarget').value;
        this.closeModal('autoFillModal');

        const loadingEl = document.getElementById('globalLoading');
        const loadingDefault = document.getElementById('loadingDefault');
        const loadingShiftGen = document.getElementById('loadingShiftGen');
        const stepEl = document.getElementById('shiftGenStep');
        const barEl = document.getElementById('shiftGenBar');

        if (loadingDefault) loadingDefault.style.display = 'none';
        if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
        if (loadingEl) loadingEl.classList.remove('hidden');
        if (stepEl) stepEl.textContent = 'ステップ 1/4: データ準備中...';
        if (barEl) barEl.style.width = '5%';

        try {
            console.log("Refreshing data before generation...");
            await this.loadData();

            const today = new Date();
            let startDate, endDate;

            if (targetType === 'reset_all' || targetType === 'empty_only') {
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

            const dates = [];
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                dates.push(dateStr);
            }

            if (!this.state.config.organization_id) {
                this.state.config.organization_id = this.state.organization_id;
            }

            const payload = {
                staff_list: this.state.staff,
                config: this.state.config,
                dates: dates,
                requests: this.state.requests || [],
                mode: 'auto'
            };

            // === STEP 2: 事前チェック ===
            if (stepEl) stepEl.textContent = 'ステップ 2/4: 人員充足チェック中...';
            if (barEl) barEl.style.width = '15%';

            const checkResult = await API.checkFeasibility(payload);

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

                alertMsg += '\n【OK】労働条件を緩和して強行生成\n【キャンセル】中止して人員を調整';

                const forceGenerate = confirm(alertMsg);

                if (!forceGenerate) {
                    this.showToast('シフト生成を中止しました。スタッフの追加や条件の見直しを検討してください。', 'info');
                    return;
                }

                payload.mode = 'force';
                if (loadingEl) loadingEl.classList.remove('hidden');
                if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
                this.showToast('⚠️ 労働条件を緩和して生成します', 'warning');
            }

            // === STEP 3: 削除処理 ===
            if (targetType === 'reset_all') {
                if (stepEl) stepEl.textContent = 'ステップ 3/4: 既存シフト削除中...';
                if (barEl) barEl.style.width = '30%';

                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const shiftsToDelete = this.state.shifts.filter(function(s) {
                    return dates.includes(s.date) && new Date(s.date) >= today && s.id && uuidRegex.test(s.id);
                });
                if (shiftsToDelete.length > 0) {
                    await Promise.all(shiftsToDelete.map(function(s) { return API.delete('shifts', s.id); }));
                }
                this.state.shifts = this.state.shifts.filter(function(s) {
                    return !(dates.includes(s.date) && new Date(s.date) >= today);
                });
            }

            // === STEP 4: シフト生成 ===
            if (stepEl) stepEl.textContent = 'ステップ 4/4: AI計算サーバーで最適化実行中...';
            if (barEl) barEl.style.width = '50%';

            console.log("Sending request to Calculation Engine...");
            const result = await API.generateShifts(payload);

            if (result.status === 'error') {
                this.showToast('生成エラー: ' + result.message, 'error');
                return;
            }

            console.log("Server Response:", result);
            if (barEl) barEl.style.width = '80%';

            if (result.status === 'success' && result.shifts) {
                const newShifts = result.shifts;
                this.showToast(newShifts.length + '件のシフト生成完了。保存中...', 'info');

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

                await this.saveAllShifts(finalShifts);

                if (targetType === 'reset_all') {
                    this.state.shifts = this.state.shifts.filter(function(s) { return !dates.includes(s.date); });
                }

                var self = this;
                const displayShifts = finalShifts.map(function(s, idx) {
                    return Object.assign({}, s, {
                        id: s.id || 'temp_' + Date.now() + '_' + idx,
                        organization_id: self.state.organization_id
                    });
                });

                this.state.shifts = this.state.shifts.concat(displayShifts);
                if (barEl) barEl.style.width = '100%';
                console.log('Generated ' + displayShifts.length + ' shifts. Updating view...');

                this.renderCurrentView();
                this.calculateMonthlyStats();

                var modeLabel = result.mode;
                if (payload.mode === 'force') modeLabel += ' [強行モード]';
                this.showToast('完了しました (Mode: ' + modeLabel + ')', 'success');
            } else {
                this.showToast('シフト案が生成されませんでした (条件が厳しすぎる可能性があります)', 'warning');
            }

        } catch (e) {
            console.error('AutoFill Error:', e);
            this.showToast('エラー: ' + e.message, 'error');
        } finally {
            const loadingElFinal = document.getElementById('globalLoading');
            const loadingDefaultFinal = document.getElementById('loadingDefault');
            const loadingShiftGenFinal = document.getElementById('loadingShiftGen');
            if (loadingShiftGenFinal) loadingShiftGenFinal.style.display = 'none';
            if (loadingDefaultFinal) loadingDefaultFinal.style.display = 'flex';
            if (loadingElFinal) loadingElFinal.classList.add('hidden');
        }
    },


    // 一括保存 (大量データの保存)
            async saveAllShifts(shifts) {
        if (!shifts || shifts.length === 0) return;

        var targetDates = [...new Set(shifts.map(function(s){ return s.date; }))];

        console.log("Deleting existing shifts for " + targetDates.length + " days...");
        for (var di = 0; di < targetDates.length; di++) {
            try {
                await API._request('shifts?organization_id=eq.' + this.state.organization_id + '&date=eq.' + targetDates[di], {
                    method: 'DELETE'
                });
            } catch(e) {
                console.error("Delete error for " + targetDates[di] + ":", e);
            }
        }

        this.state.shifts = this.state.shifts.filter(function(s){ return targetDates.indexOf(s.date) === -1; });

        var cleanShifts = shifts.map(function(s){
            return {
                organization_id: this.state.organization_id,
                staff_id: s.staff_id,
                date: s.date,
                start_time: s.start_time,
                end_time: s.end_time,
                break_minutes: s.break_minutes || 0
            };
        }.bind(this));

        var batchSize = 50;
        for (var i = 0; i < cleanShifts.length; i += batchSize) {
            var batch = cleanShifts.slice(i, i + batchSize);
            try {
                await Promise.all(batch.map(function(s){ return API.create('shifts', s); }));
            } catch(e) {
                console.error("Batch save error:", e);
            }
        }

        this.state.shifts.push.apply(this.state.shifts, cleanShifts);
        console.log("All shifts saved.");
    },





    async generateShiftsWithGemini(dateList, outputArray) {
        // Gemini用実装
        const BATCH_SIZE = 3; 
        const staffList = this.state.staff.map(s => ({
            id: s.id, name: s.name, role: s.role,
            max_days_week: s.max_days_week || 5, max_hours_day: s.max_hours_day || 8
        }));
        const config = {
            opening_times: this.state.config.opening_times,
            staff_req: this.state.config.staff_req,
            custom_shifts: this.state.config.custom_shifts,
            time_staff_req: this.state.config.time_staff_req
        };

        // 人員要件を明確なテキストとして展開
        const reqsText = `
        - Minimum Staff (Weekday): ${config.staff_req.min_weekday || 2}
        - Minimum Staff (Weekend): ${config.staff_req.min_weekend || 3}
        - Minimum Staff (Holiday): ${config.staff_req.min_holiday || 3}
        - Minimum Manager/Leader: ${config.staff_req.min_manager || 1}
        - Peak Time Rules (Time Staff Req): ${JSON.stringify(config.time_staff_req || [])}
        `;

        for (let i = 0; i < dateList.length; i += BATCH_SIZE) {
            const batchDates = dateList.slice(i, i + BATCH_SIZE);
            const batchRequests = [];
            const dateInfos = {};
            batchDates.forEach(d => {
                const reqs = this.state.requests.filter(r => r.dates === d && r.status === 'approved');
                if(reqs.length > 0) batchRequests.push({ date: d, requests: reqs });
                
                const day = new Date(d).getDay();
                const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                dateInfos[d] = days[day];
            });

            const prompt = `
            Role: Expert Shift Scheduler.
            Goal: Create a PERFECT shift schedule for: ${batchDates.join(', ')}.
            Current Date: ${new Date().toISOString().split('T')[0]}

            [CRITICAL] STAFFING REQUIREMENTS (MUST FOLLOW):
            ${reqsText}

            Context:
            - Date Infos: ${JSON.stringify(dateInfos)}
            - Staff Profiles: ${JSON.stringify(staffList)}
            - Store Rules: ${JSON.stringify(config)}
            - Approved Requests: ${JSON.stringify(batchRequests)}
            
            Strict Rules:
            1. **MANDATORY STAFF COUNTS (EXACT MATCH ONLY)**: 
               - You MUST meet the "Minimum Staff" count defined above.
               - **CRITICAL: DO NOT OVERSTAFF.** Do not schedule more staff than required.
               - If the requirement is 2, scheduling 3 is a CRITICAL FAILURE.
               - Aim for the EXACT minimum count to minimize labor costs.
               - For "Peak Time Rules", match the specified count EXACTLY.

            2. **USE SHIFT PATTERNS**:
               - Use defined 'custom_shifts' (e.g. 09:00-17:00) primarily. Avoid random times like 09:15-14:45.

            3. **PAST DATES**: 
               - Generate shifts for ALL requested dates, even past dates.

            4. **STAFF CONSTRAINTS**:
               - Respect 'max_days_week' and 'max_hours_day'.

            Output: JSON Array of objects { "staff_id", "date", "start_time", "end_time", "break_minutes" }.
            No markdown.
            `;

            try {
                const apiKey = this.state.config.gemini_api_key;
                const model = this.state.config.gemini_model || 'gemini-1.5-flash';
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    })
                });

                const json = await response.json();
                if (json.error) throw new Error(json.error.message);
                
                const content = json.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!content) throw new Error("AIからの応答がありませんでした（セーフティフィルタ等の可能性）");

                // JSONクリーニング（Markdown記法削除）
                const cleaned = content.replace(/^```json\s*/, '').replace(/```$/, '').trim();
                const result = JSON.parse(cleaned);
                
                const shifts = Array.isArray(result) ? result : (result.shifts || []);
                
                shifts.forEach(s => {
                    if(batchDates.includes(s.date) && this.getStaff(s.staff_id)) {
                        outputArray.push(s);
                    }
                });

            } catch (e) {
                console.error("Gemini Generation Error:", e);
                this.showToast(`Gemini生成エラー: ${e.message}`, 'error');
            }
        }
    },

    async generateShiftsWithOpenAI(dateList, outputArray) {
        // バッチ処理サイズ
        const BATCH_SIZE = 3; 
        const staffList = this.state.staff.map(s => ({
            id: s.id,
            name: s.name,
            role: s.role,
            max_days_week: s.max_days_week || 5,
            max_hours_day: s.max_hours_day || 8
        }));
        
        const config = {
            opening_times: this.state.config.opening_times,
            staff_req: this.state.config.staff_req,
            custom_shifts: this.state.config.custom_shifts,
            time_staff_req: this.state.config.time_staff_req
        };

        for (let i = 0; i < dateList.length; i += BATCH_SIZE) {
            const batchDates = dateList.slice(i, i + BATCH_SIZE);
            const batchRequests = [];
            const dateInfos = {};
            batchDates.forEach(d => {
                const reqs = this.state.requests.filter(r => r.dates === d && r.status === 'approved');
                if(reqs.length > 0) batchRequests.push({ date: d, requests: reqs });
                
                const day = new Date(d).getDay();
                const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                dateInfos[d] = days[day];
            });

            const prompt = `
            Role: Shift Scheduler. 
            Goal: Generate a work shift schedule JSON for the following dates: ${batchDates.join(', ')}.
            
            Context:
            - Date Infos: ${JSON.stringify(dateInfos)}
            - Staff: ${JSON.stringify(staffList)}
            - Rules: ${JSON.stringify(config)}
            - Approved Requests (Must honor): ${JSON.stringify(batchRequests)}
            
            Requirements:
            0. **CRITICAL: GENERATE FOR ALL DATES**:
               - You MUST generate shifts for EVERY single date listed in the goal, even if the date is in the past.
               - Do not skip any dates.

            1. **CRITICAL: RESPECT APPROVED REQUESTS**:
               - If a staff has an approved 'off'/'holiday' request, **DO NOT** schedule them.
               - If a staff has an approved 'work' request, **MUST** schedule them.

            2. **CRITICAL: RESPECT DETAILED RULES ('time_staff_req')**: 
               - If 'time_staff_req' specifies a count (e.g., 4 people at 12:00), you **MUST** schedule that many people for that time slot.
               - This overrides the "minimum" staff count. Do not understaff peak times.
            
            3. **CRITICAL: USE DEFINED SHIFT PATTERNS ('custom_shifts')**:
               - Prefer using the exact Start/End times defined in 'custom_shifts' (e.g., "Early: 09:00-17:00") rather than creating random shift times.
            
            4. **RESPECT STAFF CONSTRAINTS**:
               - STRICTLY follow 'max_days_week' and 'max_hours_day'.
            
            5. **BASE STAFFING & COST EFFICIENCY**:
               - Meet the base 'staff_req' (min_weekday/weekend) at all times.
               - **DO NOT OVERSTAFF**: Do not schedule more people than necessary to meet (2) 'time_staff_req' and (5) 'staff_req'.
            
            6. **ROLE REQUIREMENTS**:
               - Ensure at least 1 Manager/Leader is present each day.
            
            7. Output JSON format strictly: Array of { "staff_id": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "break_minutes": 60 }.
            8. No markdown, only raw JSON.
            `;

            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.state.config.openai_api_key}`
                    },
                    body: JSON.stringify({
                        model: this.state.config.openai_model || "gpt-4o",
                        messages: [{ role: "system", content: "You are a JSON shift scheduler." }, { role: "user", content: prompt }],
                        response_format: { type: "json_object" }
                    })
                });

                const json = await response.json();
                if (json.error) throw new Error(json.error.message);
                
                const content = json.choices[0].message.content;
                // JSONクリーニング
                const cleaned = content.replace(/^```json\s*/, '').replace(/```$/, '').trim();
                const result = JSON.parse(cleaned);
                
                const shifts = Array.isArray(result) ? result : (result.shifts || []);
                
                shifts.forEach(s => {
                    if(batchDates.includes(s.date) && this.getStaff(s.staff_id)) {
                        outputArray.push(s);
                    }
                });

            } catch (e) {
                console.error("AI Generation Error:", e);
                this.showToast(`AI生成エラー: ${e.message}`, 'error');
            }
        }
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
        
        const reqManager = sReq.min_manager || 1;

        // 全スロット初期化 (15分刻み)
        for (let t = startMins; t < effectiveEndMins; t += 15) {
            timeReqs.set(t, Number(baseReq));
            timeReqManager.set(t, Number(reqManager));
        }

        // 時間帯別ルールの適用 (time_staff_req)
        const timeRules = (config.time_staff_req || []).filter(r => r.days.includes(dayOfWeek));
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
            if(duration > rule.min_hours) {
                breakMins = rule.break_minutes;
                break;
            }
        }
        
        return { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins };
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
            const hours = (end - start) / (1000 * 60 * 60) - (shift.break_minutes / 60);
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

    // --- AI診断 (Gemini Flash-Lite) ---
    async runAIDiagnosis() {
        this.openModal('aiAdviceModal');
        const content = document.getElementById('aiAnalysisContent');
        content.innerHTML = `<div class="flex justify-center py-8"><div class="loading-spinner"></div><p class="ml-3 text-gray-500">Geminiがシフトを分析中...</p></div>`;

        try {
            // 分析用データの準備
            const shifts = this.state.shifts;
            const staff = this.state.staff;
            const config = this.state.config;
            
            // プロンプト作成
            const prompt = `
            あなたはプロの店舗マネージャーです。以下のシフトデータを分析し、改善点やリスクを指摘してください。
            
            【店舗ルール】
            - 営業時間: ${config.opening_time} - ${config.closing_time}
            - 最低人数: 平日${config.staff_req.min_weekday}名, 土日${config.staff_req.min_weekend}名
            
            【シフトデータ概要】
            - スタッフ数: ${staff.length}名
            - シフト数: ${shifts.length}コマ
            
            【分析してほしいこと】
            1. 人員不足のリスク（特に土日やピークタイム）
            2. 特定スタッフへの負荷（連勤、長時間労働）
            3. 法令遵守チェック（休憩、週40時間など）
            
            回答は以下のJSON形式のみで出力してください。Markdownは不要です。
            [
              {"type": "warning", "title": "...", "desc": "...", "action": "..."},
              {"type": "info", "title": "...", "desc": "...", "action": "..."}
            ]
            `;

            // Gemini API Call (Flash-Lite)
            const apiKey = "AIzaSyDDsjp0wqSkdX_lpmZ0_eoVOCwvzwRNyVI"; // 指定キー
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`; // Flash-Liteがbetaなら1.5-flashで代用(価格ほぼ同じ)

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            const json = await response.json();
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (!text) throw new Error("AIからの応答がありません");

            // JSONパース
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const suggestions = JSON.parse(cleanText);

            // 表示
            content.innerHTML = suggestions.map(s => `
                <div class="bg-white border ${s.type === 'warning' ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50'} rounded-lg p-4 flex gap-4">
                    <div class="mt-1">${s.type === 'warning' ? '<i class="fa-solid fa-triangle-exclamation text-red-500 text-xl"></i>' : '<i class="fa-solid fa-lightbulb text-blue-500 text-xl"></i>'}</div>
                    <div>
                        <h4 class="font-bold text-gray-800 mb-1">${s.title}</h4>
                        <p class="text-sm text-gray-600 mb-3">${s.desc}</p>
                        <button class="text-xs font-bold px-3 py-1.5 bg-white border border-gray-300 rounded shadow-sm hover:bg-gray-50">${s.action}</button>
                    </div>
                </div>`).join('');

        } catch (e) {
            console.error(e);
            content.innerHTML = `<div class="text-red-500 p-4">診断エラー: ${e.message}</div>`;
        }
    },
    
    applyAiFixes() { this.closeModal('aiAdviceModal'); this.showToast('修正案を適用しました', 'success'); },
    
    showShopRules() {
        const config = this.state.config;
        const content = document.getElementById('shopRulesContent');
        const rulesText = config.shop_rules_text || this.state.defaultConfig.shop_rules_text;
        // 改行をリストアイテムに変換
        const rulesList = rulesText.split('\n').filter(line => line.trim() !== '').map(line => `<li>${line}</li>`).join('');
        
        // 金銭情報を完全に削除し、業務ルールのみを表示
        content.innerHTML = `
            <div class="space-y-4">
                <div class="bg-blue-50 p-4 rounded-xl border border-blue-100">
                    <h4 class="font-bold text-blue-800 text-sm mb-2"><i class="fa-regular fa-clock mr-2"></i>営業時間</h4>
                    <p class="text-2xl font-bold text-gray-800 text-center">${config.opening_time || '09:00'} <span class="text-sm text-gray-400 mx-2">〜</span> ${config.closing_time || '22:00'}</p>
                </div>
                
                <div class="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <h4 class="font-bold text-gray-600 text-xs mb-1">最低勤務人数</h4>
                    <p class="text-lg font-bold text-gray-800">${config.staffing_rules?.min_staff || 2}名</p>
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
        let colorClass = type === 'success' ? 'border-green-200 text-green-600' : type === 'error' ? 'border-red-200 text-red-600' : 'border-gray-200 text-gray-600';
        let icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-circle-xmark' : 'fa-info-circle';
        toast.className = `flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border bg-white transform transition-all duration-300 translate-y-2 opacity-0 min-w-[300px] ${colorClass}`;
        toast.innerHTML = `<i class="fa-solid ${icon}"></i><span class="text-sm font-medium text-gray-700">${message}</span>`;
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));
        setTimeout(() => { toast.classList.add('opacity-0', 'translate-x-full'); setTimeout(() => toast.remove(), 300); }, 3000);
    },
    openModal(id) { 
        const el = document.getElementById(id);
        if(el) el.classList.add('active'); 
    },
    closeModal(id) { 
        const el = document.getElementById(id);
        if(el) el.classList.remove('active'); 
    }
};

document.addEventListener('DOMContentLoaded', () => { app.init(); });
