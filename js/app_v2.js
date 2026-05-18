const app = {
    // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 繝ｭ繧ｰ繧､繝ｳ隧ｦ陦悟屓謨ｰ蛻ｶ髯・
    _loginAttempts: {},
    _MAX_LOGIN_ATTEMPTS: 5,
    _LOCKOUT_DURATION_MS: 5 * 60 * 1000, // 5蛻・俣繝ｭ繝・け繧｢繧ｦ繝・

    // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 蜈･蜉帙し繝九ち繧､繧ｼ繝ｼ繧ｷ繝ｧ繝ｳ
    _sanitize(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
    },

    // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 繝ｭ繧ｰ繧､繝ｳ隧ｦ陦後メ繧ｧ繝・け
    _checkLoginLock(key) {
        const record = this._loginAttempts[key];
        if (!record) return false;
        if (record.count >= this._MAX_LOGIN_ATTEMPTS) {
            const elapsed = Date.now() - record.lastAttempt;
            if (elapsed < this._LOCKOUT_DURATION_MS) {
                const remainSec = Math.ceil((this._LOCKOUT_DURATION_MS - elapsed) / 1000);
                this.showToast('繝ｭ繧ｰ繧､繝ｳ隧ｦ陦悟屓謨ｰ縺ｮ荳企剞縺ｫ驕斐＠縺ｾ縺励◆縲・ + remainSec + '遘貞ｾ後↓蜀崎ｩｦ陦後＠縺ｦ縺上□縺輔＞縲・, 'error');
                return true;
            }
            // 繝ｭ繝・け繧｢繧ｦ繝域悄髢薙′驕弱℃縺溘・縺ｧ繝ｪ繧ｻ繝・ヨ
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

    // 繧｢繝励Μ繧ｱ繝ｼ繧ｷ繝ｧ繝ｳ縺ｮ迥ｶ諷狗ｮ｡逅・
    state: {
        currentDate: null, // Initialized in init()
        view: 'dashboard', // 迴ｾ蝨ｨ縺ｮ繝薙Η繝ｼ
        shiftViewMode: 'table', // 'table' or 'calendar'
        shiftTablePeriod: 'month', // 'month', 'week', '2weeks'
        dashboardMode: 'month', // 'month', '2week-1', '2week-2'
        isShopLoggedIn: false, // 蠎苓・繝ｭ繧ｰ繧､繝ｳ迥ｶ諷・
        isAdmin: false, // 邂｡逅・・Ο繧ｰ繧､繝ｳ迥ｶ諷・
        isHQ: false, // 譛ｬ驛ｨ繝ｭ繧ｰ繧､繝ｳ迥ｶ諷・
        
        // 繝・・繧ｿ・・PI縺九ｉ繝ｭ繝ｼ繝会ｼ・
        config: {},
        staff: [],
        shifts: [],
        requests: [],
        organization_id: null,
        
        // 險ｭ螳壹ョ繝輔か繝ｫ繝亥､
        defaultConfig: {
            admin_password: "0000",
            opening_time: "09:00",
            closing_time: "22:00",
            hourly_wage_default: 1100,
            
            // 蝟ｶ讌ｭ譎る俣・郁ｩｳ邏ｰ・・
            opening_times: {
                weekday: { start: "09:00", end: "22:00" },
                weekend: { start: "10:00", end: "20:00" },
                holiday: { start: "10:00", end: "20:00" }
            },

            // 螳壻ｼ第律 (0=譌･, 1=譛・..)
            closed_days: [], 
            
            // 莠ｺ蜩｡驟咲ｽｮ繝ｫ繝ｼ繝ｫ・郁ｩｳ邏ｰ・・
            staff_req: {
                min_manager: 1,
                min_weekday: 2,
                min_weekend: 3,
                min_holiday: 3
            },
            
            // 蠖ｹ閨ｷ險ｭ螳・(ID, 蜷榊燕, 濶ｲ, 繝ｬ繝吶Ν:鬮倥＞縺ｻ縺ｩ讓ｩ髯仙ｼｷ)
            roles: [
                { id: 'manager', name: '蠎鈴聞', color: 'purple', level: 3 },
                { id: 'leader', name: '繝ｪ繝ｼ繝繝ｼ', color: 'blue', level: 2 },
                { id: 'staff', name: '繧ｹ繧ｿ繝・ヵ', color: 'gray', level: 1 }
            ],

            // 閾ｨ譎ゆｼ第･ｭ譌･ (YYYY-MM-DD)
            special_holidays: [],
            
            // 迚ｹ螳壽律縺ｮ蝟ｶ讌ｭ譎る俣 (YYYY-MM-DD: {start, end, note})
            special_days: {},

            // 譎る俣蟶ｯ蛻･莠ｺ蜩｡繝ｫ繝ｼ繝ｫ
            time_staff_req: [], // [{ days: [0,6], start: '11:00', end: '14:00', count: 4 }]

            // 繧ｫ繝ｬ繝ｳ繝繝ｼ蛯呵・(YYYY-MM-DD: "繝｡繝｢蜀・ｮｹ")
            calendar_notes: {},

            // 莨第・譎る俣繝ｫ繝ｼ繝ｫ
            break_rules: [
                { min_hours: 6, break_minutes: 45 },
                { min_hours: 8, break_minutes: 60 }
            ],
            
            // 縺雁ｺ励・繝ｫ繝ｼ繝ｫ・郁・逕ｱ險倩ｿｰ・・
            shop_rules_text: "蟶梧悍莨代・謠仙・縺ｯ蜑肴怦20譌･縺ｾ縺ｧ縺ｫ縺企｡倥＞縺励∪縺吶・n諤･縺ｪ谺蜍､縺ｮ蝣ｴ蜷医・縲∝ｿ・★蠎鈴聞縺ｾ縺ｧ逶ｴ謗･騾｣邨｡縺励※縺上□縺輔＞縲・n繧ｷ繝輔ヨ縺ｮ螟画峩蟶梧悍縺ｯ縲御ｼ第嚊繝ｻ繧ｷ繝輔ヨ逕ｳ隲九阪・繧ｿ繝ｳ縺九ｉ陦後∴縺ｾ縺吶・,

            // 譌ｧ莠呈鋤
            // staffing_rules removed
            
            // 繧ｫ繧ｹ繧ｿ繝繧ｷ繝輔ヨ險ｭ螳・(譌ｩ逡ｪ繝ｻ驕・分縺ｪ縺ｩ)
            custom_shifts: [
                { name: "譌ｩ逡ｪ", start: "09:00", end: "17:00" },
                { name: "驕・分", start: "17:00", end: "22:00" }
            ],
            
            special_days: {} 
        },

        
        // 繝√Ε繝ｼ繝医う繝ｳ繧ｹ繧ｿ繝ｳ繧ｹ菫晄戟逕ｨ
        dashboardChartInstance: null,
        // 繝繝・す繝･繝懊・繝芽・蜍墓峩譁ｰ逕ｨ繧ｿ繧､繝槭・
        dashboardTimer: null
    },

    /**
     * 繝ｭ繧ｰ繧､繝ｳ繧ｿ繝悶・蛻・ｊ譖ｿ縺・
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
        
        // 濶ｲ縺ｮ隱ｿ謨ｴ
        if (tabId === 'hq') {
            document.getElementById('tab-hq').classList.replace('text-blue-600', 'text-indigo-600');
            document.getElementById('tab-hq').classList.replace('border-blue-600', 'border-indigo-600');
        } else if (tabId === 'platform') {
            document.getElementById('tab-platform').classList.replace('text-blue-600', 'text-purple-600');
            document.getElementById('tab-platform').classList.replace('border-blue-600', 'border-purple-600');
        }
    },

    /**
     * 蛻晄悄蛹門・逅・
     */
    async init() {
        console.log("App initializing...");
        try {
            await API.init();

            // Use native Date to avoid external dependency issues
            this.state.currentDate = new Date();
            this.bindEvents();

            // Stripe豎ｺ貂亥ｮ御ｺ・凾縺ｮ蜃ｦ逅・
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('payment') === 'success') {
                setTimeout(() => this.showToast('豎ｺ貂医′螳御ｺ・＠縺ｾ縺励◆縲ゅ・繝ｩ繝ｳ縺梧怏蜉ｹ蛹悶＆繧後∪縺励◆縲・, 'success'), 1000);
                window.history.replaceState({}, '', window.location.pathname);
            } else if (urlParams.get('payment') === 'cancelled') {
                setTimeout(() => this.showToast('豎ｺ貂医′繧ｭ繝｣繝ｳ繧ｻ繝ｫ縺輔ｌ縺ｾ縺励◆縲・, 'info'), 1000);
                window.history.replaceState({}, '', window.location.pathname);
            }
            
            // 繧ｻ繝・す繝ｧ繝ｳ繝√ぉ繝・け
            if (API.session) {
                console.log("Session found. Loading data...");
                
                // 縲仙ｾｩ蜈・・逅・・
                // session蜀・・user諠・ｱ縺九ｉ迥ｶ諷九ｒ蠕ｩ蜈・☆繧・
                const user = API.session.user;
                if (user) {
                    // 繝ｩ繧､繧ｻ繝ｳ繧ｹ迥ｶ諷九メ繧ｧ繝・け・医そ繝・す繝ｧ繝ｳ蠕ｩ蜈・凾・・
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
                                this.showToast('繝ｩ繧､繧ｻ繝ｳ繧ｹ縺悟●豁｢荳ｭ縺ｮ縺溘ａ縲∬・蜍輔Ο繧ｰ繧｢繧ｦ繝医＠縺ｾ縺励◆縲る°蝟ｶ縺ｾ縺ｧ縺雁撫縺・粋繧上○縺上□縺輔＞縲・, 'error');
                                return;
                            }
                        } catch (e) {
                            console.warn('[Init] License check skipped:', e.message);
                        }
                    }

                    this.state.isShopLoggedIn = true;
                    // contract_id 繧貞━蜈育噪縺ｫ蠕ｩ蜈・
                    if (user.contract_id) {
                        this.state.organization_id = user.contract_id;
                    }
                    // 邂｡逅・・°縺ｩ縺・°縺ｮ蠕ｩ蜈・
                    if (user.role === 'admin' || user.role === 'Manager' || user.role === 'manager') {
                        this.state.isAdmin = true;
                    }
                }

                await this.loadData();
            } else {
                console.log("No session. Showing login modal.");
                // 繝・・繧ｿ繧偵Ο繝ｼ繝峨○縺壹∫ｩｺ縺ｮ迥ｶ諷九〒謠冗判縺励※縺九ｉ繝ｭ繧ｰ繧､繝ｳ繝｢繝ｼ繝繝ｫ繧貞・縺・
                this.state.isAdmin = false;
                this.state.isShopLoggedIn = false; // 譏守､ｺ逧・↓false
                this.renderCurrentView();
                this.updateHeader();

                // 繝ｭ繧ｰ繧､繝ｳ繝｢繝ｼ繝繝ｫ繧定｡ｨ遉ｺ・医♀遏･繧峨○縺ｯ繧ｵ繧､繝峨ヰ繝ｼ縺ｧ遒ｺ隱阪☆繧区婿蠑上↓邨ｱ荳・・
                this.openModal('loginModal');
                
                const loadingEl = document.getElementById('viewContainer').querySelector('.loading-spinner')?.parentElement?.parentElement;
                if(loadingEl) loadingEl.innerHTML = ''; 
                return; // 縺薙％縺ｧ邨ゆｺ・
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
     * 繧､繝吶Φ繝医Μ繧ｹ繝翫・逋ｻ骭ｲ
     */
    bindEvents() {
        const closeSidebar = () => {
            if (window.innerWidth < 768) {
                document.querySelector('aside')?.classList.add('-translate-x-full');
                document.getElementById('sidebarOverlay')?.classList.remove('active');
            }
        };

        document.querySelectorAll('.sidebar-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const view = e.currentTarget.dataset.view;
                this.changeView(view);
                closeSidebar();
            });
        });

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
    },

    /**
     * 繝・・繧ｿ縺ｮ繝ｭ繝ｼ繝・
     */
    async loadData() {
        if (!this._shiftGenInProgress) this.showLoading(true);
        try {
            // 1. organization_id 繧堤｢ｺ螳壹☆繧・(繧ｻ繝・す繝ｧ繝ｳ 竊・localStorage 縺ｮ鬆・
            let orgId = null;

            if (API.session?.user?.organization_id) {
                orgId = API.session.user.organization_id;
            }
            if (!orgId && API.session?.user?.contract_id) {
                // contract_id 縺九ｉconfig_safe繝薙Η繝ｼ繧貞ｼ輔＞縺ｦorganization_id繧貞叙蠕・
                try {
                    const cRes = await API.list('config_safe', { contract_id: `eq.${API.session.user.contract_id}`, select: 'organization_id' });
                    if (cRes.data?.[0]?.organization_id) {
                        orgId = cRes.data[0].organization_id;
                    }
                } catch(e) { console.warn("Config lookup failed:", e); }
            }
            if (!orgId) {
                orgId = localStorage.getItem('rakushift_org_id') || this.state.organization_id;
            }

            // orgId縺檎┌縺代ｌ縺ｰ繝・・繧ｿ蜿門ｾ嶺ｸ榊庄 竊・繝ｭ繧ｰ繧､繝ｳ逕ｻ髱｢縺ｸ
            if (!orgId) {
                console.error("No organization_id available. Cannot load data.");
                this.showLoading(false);
                this.openModal('loginModal');
                return;
            }

            this.state.organization_id = orgId;
            localStorage.setItem('rakushift_org_id', orgId);

            // 2. 繝・リ繝ｳ繝亥・髮｢: 蜈ｨ繧ｯ繧ｨ繝ｪ縺ｫorganization_id繝輔ぅ繝ｫ繧ｿ繧帝←逕ｨ
            const orgFilter = { organization_id: `eq.${orgId}` };

            console.log(`Loading data for org: ${orgId}`);

            // staff縺ｯ蜈ｨ繧ｫ繝ｩ繝蜿門ｾ暦ｼ亥ｭ伜惠縺励↑縺・き繝ｩ繝謖・ｮ壹お繝ｩ繝ｼ繧帝亟縺撰ｼ・
            const staffSelect = '*';
            const [configRes, staffRes, shiftsRes, requestsRes] = await Promise.all([
                API.list('config_safe', orgFilter),
                API.list('staff', { ...orgFilter, select: staffSelect }),
                API.list('shifts', orgFilter),
                API.list('requests', orgFilter)
            ]);

            // 3. config繧偵・繝ｼ繧ｸ (DB縺ｮ蛟､繧貞━蜈医∬ｶｳ繧翫↑縺・・岼縺ｯ繝・ヵ繧ｩ繝ｫ繝医〒陬懷ｮ・
            if (configRes.data && configRes.data.length > 0) {
                this.state.config = { ...this.state.defaultConfig, ...configRes.data[0] };
            } else {
                if (!this.state.config.id) {
                    console.log("No config in DB for this org, keeping defaults.");
                }
            }

            // 4. 繝・・繧ｿ繧担tate縺ｫ菫晏ｭ・
            this.state.staff = staffRes.data || [];
            this.state.shifts = shiftsRes.data || [];
            this.state.requests = requestsRes.data || [];

            console.log(`Loaded: ${this.state.staff.length} staff, ${this.state.shifts.length} shifts.`);
            this.updateRequestBadge();

            // 繧ｹ繧ｿ繝・ヵ謨ｰ縺後・繝ｩ繝ｳ荳企剞繧定ｶ・∴縺ｦ縺・◆繧芽ｭｦ蜻・
            if (this.isStaffOverLimit()) {
                this.showStaffOverLimitAlert();
            } else {
                this.clearStaffOverLimitAlert();
            }

            // 豎ｺ貂医お繝ｩ繝ｼ迥ｶ諷九↑繧芽ｭｦ蜻願｡ｨ遉ｺ
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
            // 邂｡逅・・Ο繧ｰ繧｢繧ｦ繝医・縺ｿ・亥ｺ苓・繝ｭ繧ｰ繧､繝ｳ縺ｯ邯ｭ謖・ｼ・
            if(confirm('邂｡逅・・ｨｩ髯舌°繧峨Ο繧ｰ繧｢繧ｦ繝医＠縺ｾ縺吶°・・)) {
                this.state.isAdmin = false;
                // 繧ｻ繝・す繝ｧ繝ｳ諠・ｱ繧呈峩譁ｰ・育ｮ｡逅・・ュ蝣ｱ繧呈ｶ医☆・・
                const currentUser = API.session.user;
                // 螂醍ｴ・ュ蝣ｱ縺ｯ谿九☆縺後∝倶ｺｺ迚ｹ螳壹・豸医☆繧､繝｡繝ｼ繧ｸ・医％縺薙〒縺ｯ邁｡譏鍋噪縺ｫisAdmin繝輔Λ繧ｰ縺ｮ縺ｿ謫堺ｽ懶ｼ・
                const shopUser = {
                    contract_id: currentUser.contract_id,
                    name: 'Guest (Staff)',
                    role: 'Guest'
                };
                API.setSession(shopUser);
                
                this.showToast('邂｡逅・・°繧峨Ο繧ｰ繧｢繧ｦ繝医＠縺ｾ縺励◆', 'info');
                this.updateAuthUI();
                this.updateHeader();
                this.changeView('dashboard');
            }
        } else {
            // 邂｡逅・・Ο繧ｰ繧､繝ｳ繧ｿ繝悶ｒ髢九￥
            this.switchLoginTab('admin');
            this.openModal('loginModal');
        }
    },

    /**
     * 螂醍ｴ・・ｼ亥ｺ苓・・峨Ο繧ｰ繧､繝ｳ蜃ｦ逅・- RPC邨檎罰bcrypt隱崎ｨｼ
     */
    async login() {
        console.log('[ShopLogin] Login attempt started...');

        const contractIdEl = document.getElementById('loginContractId');
        const passwordEl = document.getElementById('loginShopPass');

        if (!contractIdEl) {
            alert('繧ｨ繝ｩ繝ｼ: 蜈･蜉帶ｬ・′隕九▽縺九ｊ縺ｾ縺帙ｓ縲ゅ・繝ｼ繧ｸ繧貞・隱ｭ縺ｿ霎ｼ縺ｿ縺励※縺上□縺輔＞縲・);
            return;
        }

        const contractId = this._sanitize(contractIdEl.value.trim());
        const password = passwordEl ? passwordEl.value.trim() : '';

        if (!contractId || !password) {
            this.showToast('螂醍ｴИD縺ｨ繝代せ繝ｯ繝ｼ繝峨ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }

        // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 繝悶Ν繝ｼ繝医ヵ繧ｩ繝ｼ繧ｹ蟇ｾ遲・
        if (this._checkLoginLock('shop_' + contractId)) return;

        this.showLoading(true);
        try {
            // 1. 繝ｩ繧､繧ｻ繝ｳ繧ｹ繝ｻ繧ｵ繝悶せ繧ｯ繝ｪ繝励す繝ｧ繝ｳ迥ｶ諷九メ繧ｧ繝・け
            try {
                const subCheck = await API.rpc('check_subscription_status', { p_contract_id: contractId });
                if (subCheck && !subCheck.allowed) {
                    if (subCheck.status === 'suspended') {
                        this.showToast('縺薙・繧｢繧ｫ繧ｦ繝ｳ繝医・繝ｩ繧､繧ｻ繝ｳ繧ｹ縺ｯ蛛懈ｭ｢荳ｭ縺ｧ縺吶る°蝟ｶ縺ｾ縺ｧ縺雁撫縺・粋繧上○縺上□縺輔＞縲・, 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'not_found') {
                        this.showToast('螂醍ｴИD縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ', 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'canceled' || subCheck.status === 'unpaid') {
                        this.showToast('繧ｵ繝悶せ繧ｯ繝ｪ繝励す繝ｧ繝ｳ縺檎┌蜉ｹ縺ｧ縺吶ゅ・繝ｩ繝ｳ繧貞・蠎ｦ縺泌･醍ｴ・￥縺縺輔＞縲・, 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'past_due') {
                        this._paymentPastDue = true;
                    }
                }
                // 繧ｵ繝悶せ繧ｯ譛ｪ螂醍ｴ・free)縺ｮ蝣ｴ蜷・竊・繝ｭ繧ｰ繧､繝ｳ縺ｯ險ｱ蜿ｯ縺吶ｋ縺梧ｱｺ貂医ｒ菫・☆
                if (subCheck && subCheck.status === 'free') {
                    this._pendingPayment = true;
                } else {
                    this._pendingPayment = false;
                }
            } catch (licenseErr) {
                console.warn('[ShopLogin] Subscription check skipped:', licenseErr.message);
            }

            // 2. bcrypt隱崎ｨｼ (RPC邨檎罰)
            const authResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: password
            });

            console.log('[ShopLogin] Auth result: success=', authResult?.success);

            if (authResult && authResult.success) {
                this._recordLoginAttempt('shop_' + contractId, true);
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

                // 繧ｵ繝悶せ繧ｯ譛ｪ螂醍ｴ・・蝣ｴ蜷医∵ｱｺ貂医ｒ菫・☆
                if (this._pendingPayment) {
                    this.showToast('縺泌茜逕ｨ縺ｫ縺ｯ繝励Λ繝ｳ縺ｮ螂醍ｴ・′蠢・ｦ√〒縺・, 'warning');
                    this.changeView('settings');
                    setTimeout(() => {
                        const section = document.getElementById('subscriptionSection');
                        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 500);
                } else if (this._paymentPastDue) {
                    this.showToast(`螂醍ｴИD: ${contractId} 縺ｧ繝ｭ繧ｰ繧､繝ｳ縺励∪縺励◆`, 'success');
                    this.showPaymentAlert();
                } else {
                    this.showToast(`螂醍ｴИD: ${contractId} 縺ｧ繝ｭ繧ｰ繧､繝ｳ縺励∪縺励◆`, 'success');
                }

                // 縺顔衍繧峨○繝舌ャ繧ｸ繧呈峩譁ｰ・医し繧､繝峨ヰ繝ｼ縺ｧ遒ｺ隱阪☆繧区婿蠑上↓邨ｱ荳・・
                this.updateAnnouncementBadge();
            } else {
                this._recordLoginAttempt('shop_' + contractId, false);
                this.showToast(authResult?.message || '繝ｭ繧ｰ繧､繝ｳ縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
            }

        } catch (error) {
            console.error('[ShopLogin] Error:', error);
            this.showToast(`繝ｭ繧ｰ繧､繝ｳ蜃ｦ逅・ｸｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: ${error.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    /**
     * 邂｡逅・・Ο繧ｰ繧､繝ｳ蜃ｦ逅・- RPC邨檎罰bcrypt隱崎ｨｼ
     * 螂醍ｴИD縺ｨ邂｡逅・・ヱ繧ｹ繝ｯ繝ｼ繝峨〒逶ｴ謗･繝ｭ繧ｰ繧､繝ｳ蜿ｯ閭ｽ
     * verify_admin_login 竊・verify_shop_login 竊・demo 繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ
     */
    async adminLogin() {
        const password = document.getElementById('adminLoginPass')?.value.trim() || '';
        const inputContractId = this._sanitize(document.getElementById('adminLoginContractId')?.value.trim() || '');

        if (!inputContractId) {
            this.showToast('螂醍ｴИD繧貞・蜉帙＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }
        if (!password) {
            this.showToast('邂｡逅・・ヱ繧ｹ繝ｯ繝ｼ繝峨ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }

        if (this._checkLoginLock('admin_' + inputContractId)) return;

        this.showLoading(true);
        try {
            let authResult = null;
            let authMethod = 'none';
            let orgId = null;

            // 譁ｹ豕・: verify_admin_login RPC
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

            // 譁ｹ豕・: verify_shop_login 縺ｧ蠎苓・隱崎ｨｼ
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

            // 譁ｹ豕・: 蜈ｨRPC螟ｱ謨玲凾 竊・config_safe縺九ｉorg_id蜿門ｾ励＠縺ｦ繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ隱崎ｨｼ
            if (authMethod === 'none') {
                console.warn('[AdminLogin] All RPCs failed. Trying direct config lookup...');
                try {
                    // config_safe繝・・繝悶Ν縺九ｉcontract_id縺ｧorganization_id繧呈､懃ｴ｢
                    const configRes = await API.list('config_safe', {
                        contract_id: `eq.${inputContractId}`,
                        select: 'organization_id,contract_id'
                    });
                    if (configRes.data && configRes.data.length > 0) {
                        orgId = configRes.data[0].organization_id;
                        // 螂醍ｴИD縺悟ｭ伜惠縺吶ｋ 竊・隱崎ｨｼ謌仙粥謇ｱ縺・ｼ・PC譛ｪ險ｭ螳夂腸蠅・畑・・
                        authResult = {
                            success: true,
                            name: '邂｡逅・・,
                            organization_id: orgId,
                            staff_id: null,
                            session_id: 'fallback_' + Date.now(),
                            role: 'admin'
                        };
                        authMethod = 'config_lookup';
                        console.log('[AdminLogin] Fallback auth via config_safe, org_id:', orgId);
                    }
                } catch (configErr) {
                    console.warn('[AdminLogin] config_safe lookup failed:', configErr.message);
                }
            }

            if (authResult && authResult.success) {
                this._recordLoginAttempt('admin_' + inputContractId, true);
                this.state.isAdmin = true;
                this.state.isShopLoggedIn = true;
                this.state.organization_id = orgId;

                API.setSession({
                    id: authResult.staff_id,
                    contract_id: inputContractId,
                    organization_id: orgId,
                    session_id: authResult.session_id || ('admin_' + Date.now()),
                    name: authResult.name || '邂｡逅・・,
                    role: authResult.role || 'admin'
                });

                this.closeModal('loginModal');
                await this.loadData();
                this.updateAuthUI();
                this.updateHeader();
                this.showToast(`邂｡逅・・ ${this._sanitize(authResult.name || '邂｡逅・・)} 縺ｧ繝ｭ繧ｰ繧､繝ｳ縺励∪縺励◆`, 'success');
                this.updateAnnouncementBadge();
            } else {
                this._recordLoginAttempt('admin_' + inputContractId, false);
                this.showToast(authResult?.message || '螂醍ｴИD縺ｾ縺溘・繝代せ繝ｯ繝ｼ繝峨′豁｣縺励￥縺ゅｊ縺ｾ縺帙ｓ', 'error');
            }

        } catch(e) {
            console.error('Admin Login Error:', e);
            this.showToast(`繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: ${e.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    // =========================================================
    // 3蠎苓・莉･荳翫♀蝠上＞蜷医ｏ縺帙ヵ繧ｩ繝ｼ繝騾∽ｿ｡
    // =========================================================
    async submitMultiStoreInquiry() {
        const company = document.getElementById('inquiryCompany')?.value.trim() || '';
        const address = document.getElementById('inquiryAddress')?.value.trim() || '';
        const phone = document.getElementById('inquiryPhone')?.value.trim() || '';
        const name = document.getElementById('inquiryName')?.value.trim() || '';
        const lightCount = document.getElementById('inquiryLightCount')?.value || '0';
        const standardCount = document.getElementById('inquiryStandardCount')?.value || '0';
        const premiumCount = document.getElementById('inquiryPremiumCount')?.value || '0';
        const message = document.getElementById('inquiryMessage')?.value.trim() || '';

        // 蟶梧悍譌･蜿門ｾ・
        const date1 = document.getElementById('inquiryDate1')?.value || '';
        const date2 = document.getElementById('inquiryDate2')?.value || '';
        const date3 = document.getElementById('inquiryDate3')?.value || '';

        // 譎る俣蟶ｯ繝ｩ繧ｸ繧ｪ蜿門ｾ・
        const timeSlot = document.querySelector('input[name="inquiryTimeSlot"]:checked')?.value || '';

        // 繝舌Μ繝・・繧ｷ繝ｧ繝ｳ
        if (!company) { this.showToast('莨夂､ｾ蜷阪ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error'); return; }
        if (!address) { this.showToast('莨夂､ｾ菴乗園繧貞・蜉帙＠縺ｦ縺上□縺輔＞', 'error'); return; }
        if (!phone) { this.showToast('莨夂､ｾ騾｣邨｡蜈医ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error'); return; }
        if (!name) { this.showToast('縺疲球蠖楢・錐繧貞・蜉帙＠縺ｦ縺上□縺輔＞', 'error'); return; }

        // 繝励Λ繝ｳ莉ｶ謨ｰ繝√ぉ繝・け・亥粋險・莉ｶ莉･荳奇ｼ・
        const totalPlans = (parseInt(lightCount) || 0) + (parseInt(standardCount) || 0) + (parseInt(premiumCount) || 0);
        if (totalPlans === 0 && lightCount === '0' && standardCount === '0' && premiumCount === '0') {
            this.showToast('螂醍ｴ・ｺ亥ｮ壹・繝ｩ繝ｳ繧・莉ｶ莉･荳企∈謚槭＠縺ｦ縺上□縺輔＞', 'error'); return;
        }

        if (!date1) { this.showToast('隨ｬ1蟶梧悍譌･繧帝∈謚槭＠縺ｦ縺上□縺輔＞', 'error'); return; }

        this.showLoading(true);
        try {
            // 繝励Λ繝ｳ繧ｵ繝槭Μ繝ｼ譁・ｭ怜・繧呈ｧ狗ｯ・
            const planParts = [];
            if (lightCount !== '0') planParts.push(`繝ｩ繧､繝医・繝ｩ繝ｳ ${lightCount}莉ｶ`);
            if (standardCount !== '0') planParts.push(`繧ｹ繧ｿ繝ｳ繝繝ｼ繝峨・繝ｩ繝ｳ ${standardCount}莉ｶ`);
            if (premiumCount !== '0') planParts.push(`繝励Ξ繝溘い繝繝励Λ繝ｳ ${premiumCount}莉ｶ`);
            const planSummary = planParts.join('縲・);

            // 騾｣邨｡蟶梧悍譌･遞九し繝槭Μ繝ｼ
            const dateParts = [date1];
            if (date2) dateParts.push(date2);
            if (date3) dateParts.push(date3);
            const scheduleSummary = [
                `蟶梧悍譌･: ${dateParts.join(', ')}`,
                timeSlot ? `譎る俣蟶ｯ: ${timeSlot}` : ''
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

            // localStorage縺ｫ繝舌ャ繧ｯ繧｢繝・・菫晏ｭ・
            const pending = JSON.parse(localStorage.getItem('rakushift_pending_inquiries') || '[]');
            pending.push(inquiryData);
            localStorage.setItem('rakushift_pending_inquiries', JSON.stringify(pending));

            // Railway繧ｵ繝ｼ繝舌・邨檎罰縺ｧ繝｡繝ｼ繝ｫ騾∽ｿ｡
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

            // 繝輔か繝ｼ繝繝ｪ繧ｻ繝・ヨ
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
            this.showToast('縺雁撫縺・粋繧上○繧貞女縺台ｻ倥￠縺ｾ縺励◆縲よ球蠖楢・ｈ繧・蝟ｶ讌ｭ譌･莉･蜀・↓縺秘｣邨｡縺・◆縺励∪縺吶・, 'success');
        } catch (e) {
            console.error('Inquiry Error:', e);
            this.showToast('騾∽ｿ｡縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲よ凾髢薙ｒ縺翫＞縺ｦ蜀榊ｺｦ縺願ｩｦ縺励￥縺縺輔＞縲・, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // =========================================================
    // 繝ｭ繧ｰ繧､繝ｳ繧ｿ繝門・繧頑崛縺・
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
        alert("譁ｰ隕冗匳骭ｲ讖溯・縺ｯ迴ｾ蝨ｨ繝｡繝ｳ繝・リ繝ｳ繧ｹ荳ｭ縺ｧ縺吶らｮ｡逅・・↓騾｣邨｡縺励※繧｢繧ｫ繧ｦ繝ｳ繝医ｒ逋ｺ陦後＠縺ｦ縺上□縺輔＞縲・);
    },

    async hqLogin() {
        const loginId = this._sanitize((document.getElementById('loginHqId')?.value || '').trim());
        const password = document.getElementById('loginHqPass')?.value.trim() || '';
        if (!loginId || !password) {
            this.showToast('譛ｬ驛ｨID縺ｨ繝代せ繝ｯ繝ｼ繝峨ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }

        // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 繝悶Ν繝ｼ繝医ヵ繧ｩ繝ｼ繧ｹ蟇ｾ遲・
        if (this._checkLoginLock('hq_' + loginId)) return;

        this.showLoading(true);
        try {
            let result = null;

            // RPC邨檎罰縺ｮ隱崎ｨｼ繧定ｩｦ陦・
            try {
                result = await API.rpc('hq_login', { p_login_id: loginId, p_password: password });
            } catch (rpcErr) {
                console.warn('[HQ] hq_login RPC not available, using fallback auth:', rpcErr.message);
                // RPC譛ｪ菴懈・縺ｮ蝣ｴ蜷医・繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ隱崎ｨｼ
                // 窶ｻSupabase縺ｫ繝槭う繧ｰ繝ｬ繝ｼ繧ｷ繝ｧ繝ｳ驕ｩ逕ｨ蠕後・RPC縺悟━蜈医＆繧後ｋ
                const HQ_ACCOUNTS = [
                    { login_id: 'hq_master', password: 'rakushift_hq' },
                    { login_id: 'demo', password: 'demo1234' }
                ];
                const match = HQ_ACCOUNTS.find(a => a.login_id === loginId && a.password === password);
                if (match) {
                    result = { status: 'success', role: 'hq_admin', login_id: match.login_id };
                } else {
                    result = { status: 'error', message: '譛ｬ驛ｨID縺ｾ縺溘・繝代せ繝ｯ繝ｼ繝峨′驕輔＞縺ｾ縺・ };
                }
            }

            if (result && result.status === 'success') {
                this._recordLoginAttempt('hq_' + loginId, true);
                this.state.isHQ = true;
                this.state.isAdmin = true;
                this.state.isShopLoggedIn = true;
                
                API.setSession({
                    session_id: result.session_id || ('hq_' + Date.now()),
                    name: 'HQ Admin',
                    role: 'hq_admin'
                });

                this.closeModal('loginModal');
                this.showToast('譛ｬ驛ｨ縺ｨ縺励※繝ｭ繧ｰ繧､繝ｳ縺励∪縺励◆', 'success');
                this.changeView('hq_dashboard');
                this.updateAuthUI();
                this.updateHeader();
            } else {
                this._recordLoginAttempt('hq_' + loginId, false);
                this.showToast(result?.message || '繝ｭ繧ｰ繧､繝ｳ縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
            }
        } catch (e) {
            console.error(e);
            this.showToast('繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async logout() {
        if(!confirm('繧｢繝励Μ繧ｱ繝ｼ繧ｷ繝ｧ繝ｳ縺九ｉ螳悟・縺ｫ繝ｭ繧ｰ繧｢繧ｦ繝医＠縺ｾ縺吶°・歃n・医Ο繧ｰ繧､繝ｳ逕ｻ髱｢縺ｫ謌ｻ繧翫∪縺呻ｼ・)) return;
        
        await API.logout();
        // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 蜈ｨ縺ｦ縺ｮ隱崎ｨｼ迥ｶ諷九ｒ螳悟・縺ｫ繧ｯ繝ｪ繧｢
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        this.state.isHQ = false;
        this.state.organization_id = null;
        this.state.config = {};
        this.state.staff = [];
        this.state.shifts = [];
        this.state.requests = [];
        // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 繧ｻ繝・す繝ｧ繝ｳ髢｢騾｣縺ｮlocalStorage繧貞・豸亥悉
        localStorage.removeItem('rakushift_user');
        localStorage.removeItem('supabase.auth.token');
        localStorage.removeItem('rakushift_org_id');
        this.showToast('繝ｭ繧ｰ繧｢繧ｦ繝医＠縺ｾ縺励◆', 'info');
        this.updateAuthUI();
        this.changeView('dashboard'); 
        this.openModal('loginModal');
    },

    updateAuthUI() {
        const authBtn = document.getElementById('authBtn');
        const adminLinks = document.querySelectorAll('.admin-link');
        const adminHeader = document.getElementById('adminHeaderControls');

        // --- 譛ｬ驛ｨ・磯夢隕ｧ蟆ら畑・峨Δ繝ｼ繝峨・蛻ｶ蠕｡ ---
        if (this.state.isHQ) {
            if (authBtn) authBtn.classList.add('hidden'); // 繧ｵ繧､繝峨ヰ繝ｼ縺ｮ繝ｭ繧ｰ繧､繝ｳ繝懊ち繝ｳ繧帝國縺・
            
            // 邂｡逅・・Γ繝九Η繝ｼ縺ｯ荳驛ｨ・医ム繝・す繝･繝懊・繝峨√す繝輔ヨ菴懈・縲√せ繧ｿ繝・ヵ遲会ｼ芽｡ｨ遉ｺ縺輔○繧九′邱ｨ髮・ｸ榊庄
            adminLinks.forEach(link => link.classList.remove('hidden'));

            if (adminHeader) {
                adminHeader.innerHTML = `
                    <div class="hidden md:flex items-center gap-2 mr-4 bg-indigo-50 border border-indigo-200 text-indigo-700 px-3 py-1.5 rounded text-xs font-bold shadow-sm">
                        <i class="fa-solid fa-eye"></i> 髢ｲ隕ｧ蟆ら畑繝｢繝ｼ繝・
                    </div>
                    <button onclick="app.changeView('hq_dashboard')" class="px-3 py-1.5 text-xs font-bold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 rounded bg-white transition-all mr-2 shadow-sm">
                        <i class="fa-solid fa-list mr-1"></i>蠎苓・荳隕ｧ
                    </button>
                    <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all shadow-sm">
                        <i class="fa-solid fa-power-off mr-1"></i>繝ｭ繧ｰ繧｢繧ｦ繝・
                    </button>
                `;
            }

            // 蜷・ｨｮ霑ｽ蜉繝ｻ菫晏ｭ倥・菴懈・邉ｻ縺ｮ繝懊ち繝ｳ繧帝國縺吶°辟｡蜉ｹ蛹悶☆繧・
            setTimeout(() => {
                const actionKeywords = ['霑ｽ蜉', '菫晏ｭ・, '菴懈・', '逕ｳ隲・, '邱ｨ髮・, '險ｭ螳・, '蜑企勁', '謇ｿ隱・, '蜊ｴ荳・];
                document.querySelectorAll('button').forEach(btn => {
                    if (!btn.closest('#adminHeaderControls') && !btn.closest('#sidebar') && !btn.closest('#viewContainer')?.querySelector('header')) {
                        const txt = btn.textContent;
                        if (actionKeywords.some(kw => txt.includes(kw))) {
                            btn.classList.add('hidden');
                        }
                    }
                });
            }, 100);

            this.updateRequestBadge();
            this.updateAnnouncementBadge();
            return;
        }

        // 繧ｵ繧､繝峨ヰ繝ｼ縺ｮ縲檎ｮ｡逅・・Ο繧ｰ繧､繝ｳ縲阪・繧ｿ繝ｳ縺ｮ陦ｨ遉ｺ
        if (authBtn) {
            if (this.state.isAdmin) {
                authBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket w-6 text-center"></i> 邂｡逅・・Ο繧ｰ繧｢繧ｦ繝・;
                authBtn.classList.remove('text-blue-600', 'hover:bg-blue-50');
                authBtn.classList.add('text-red-600', 'hover:bg-red-50');
            } else {
                authBtn.innerHTML = '<i class="fa-solid fa-user-shield w-6 text-center"></i> 邂｡逅・・Ο繧ｰ繧､繝ｳ';
                authBtn.classList.add('text-blue-600', 'hover:bg-blue-50');
                authBtn.classList.remove('text-red-600', 'hover:bg-red-50');
            }
        }
        
        // 邂｡逅・・ｰら畑繝｡繝九Η繝ｼ縺ｮ陦ｨ遉ｺ蛻・ｊ譖ｿ縺・
        adminLinks.forEach(link => {
            if (this.state.isAdmin) {
                link.classList.remove('hidden');
            } else {
                link.classList.add('hidden');
            }
        });

        // 繝倥ャ繝繝ｼ縺ｸ縺ｮ邂｡逅・・さ繝ｳ繝医Ο繝ｼ繝ｫ豕ｨ蜈･
        if (adminHeader) {
            if (this.state.isAdmin) {
                adminHeader.innerHTML = `
                    <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all ml-2">
                        <i class="fa-solid fa-power-off mr-1"></i>繝ｭ繧ｰ繧｢繧ｦ繝・
                    </button>
                `;
            } else {
                // 繧ｹ繧ｿ繝・ヵ繝｢繝ｼ繝会ｼ磯夢隕ｧ縺ｮ縺ｿ・峨・縺ｨ縺阪・繝倥ャ繝繝ｼ縺ｫ螂醍ｴИD縺ｨ螳悟・繝ｭ繧ｰ繧｢繧ｦ繝医・繧ｿ繝ｳ繧定｡ｨ遉ｺ
                if (this.state.isShopLoggedIn) {
                     adminHeader.innerHTML = `
                        <div class="hidden md:block px-3 py-1 text-xs font-mono text-gray-400 border border-gray-200 rounded bg-gray-50 mr-2">
                            ID: ${this.state.organization_id}
                        </div>
                        <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all">
                            <i class="fa-solid fa-power-off mr-1"></i>繝ｭ繧ｰ繧｢繧ｦ繝・
                        </button>
                     `;
                } else {
                    adminHeader.innerHTML = '';
                }
            }
        }
        
        // 繝｡繝九Η繝ｼ繝舌ャ繧ｸ縺ｪ縺ｩ縺ｮ譖ｴ譁ｰ
        this.updateRequestBadge();
        this.updateAnnouncementBadge();
    },

    changeView(viewName) {
        // 繧ｿ繧､繝槭・繧ｯ繝ｪ繧｢
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
        if(display) display.textContent = `${year}蟷ｴ ${month}譛・;
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
            case 'announcements':
                this.renderAnnouncementsAdmin(container);
                break;
            default:
                this.renderDashboard(container);
        }
    },

    // --- 髢狗匱閠・畑繝・・繝ｫ (Dev Tools) ---
    async devCreateTestData() {
        // 1. 繝槭せ繧ｿ繝ｼ繧｢繧ｫ繧ｦ繝ｳ繝医メ繧ｧ繝・け
        const currentUser = API.session?.user?.email;
        console.log("Current user:", currentUser);
        if (currentUser !== 'master@mochikuro.com') {
            alert(`迴ｾ蝨ｨ縺ｮ繧｢繧ｫ繧ｦ繝ｳ繝・(${currentUser}) 縺ｧ縺ｯ縺薙・讖溯・繧剃ｽｿ逕ｨ縺ｧ縺阪∪縺帙ｓ縲・n邂｡逅・・master@mochikuro.com)縺ｮ縺ｿ螳溯｡悟庄閭ｽ縺ｧ縺吶Ａ);
            return;
        }

        // 蜑企勁遒ｺ隱阪〒縺ｯ縺ｪ縺上後ョ繝ｼ繧ｿ謨ｴ蛯吶阪・遒ｺ隱阪↓螟画峩
        if (!confirm("縲宣幕逋ｺ閠・畑縲代ユ繧ｹ繝医ョ繝ｼ繧ｿ繧呈紛蛯吶＠縺ｾ縺吶°・歃n窶ｻ譌｢蟄倥ョ繝ｼ繧ｿ縺ｯ菫晄戟縺輔ｌ縲∽ｸ崎ｶｳ縺励※縺・ｋ繧ｹ繧ｿ繝・ヵ繧・ｨｭ螳壹′陬懷・縺輔ｌ縺ｾ縺吶・)) return;
        
        this.showLoading(true);
        try {
            // 2. 邨・ｹ祢D縺ｮ遒ｺ菫昴→讀懆ｨｼ (閾ｪ蟾ｱ菫ｮ蠕ｩ繝ｭ繧ｸ繝・け)
            let orgId = this.state.organization_id || localStorage.getItem('rakushift_org_id');
            let isValidOrg = false;

            // ID繧呈戟縺｣縺ｦ縺・ｋ蝣ｴ蜷医．B縺ｫ螳溷惠縺吶ｋ縺狗｢ｺ隱・
            if (orgId) {
                try {
                    const check = await API.list('organizations', { id: `eq.${orgId}` });
                    if (check.data && check.data.length > 0) isValidOrg = true;
                } catch(e) { console.warn("Org check failed", e); }
            }

            // 辟｡蜉ｹ縺ｾ縺溘・謖√▲縺ｦ縺・↑縺・ｴ蜷医∝・蜿門ｾ励・菴懈・
            if (!isValidOrg) {
                console.log("Org ID is invalid or missing. Repairing...");
                const orgRes = await API.list('organizations');
                if (orgRes && orgRes.data && orgRes.data.length > 0) {
                    orgId = orgRes.data[0].id; // 譌｢蟄倥・繧ゅ・繧呈治逕ｨ
                } else {
                    console.log("No organizations found. Creating new...");
                    const newOrg = await API.create('organizations', { name: 'Test Shop' });
                    orgId = newOrg?.id;
                }
                
                // 譁ｰ縺励＞ID繧剃ｿ晏ｭ・
                if (orgId) {
                    this.state.organization_id = orgId;
                    localStorage.setItem('rakushift_org_id', orgId);
                    
                    // 繝励Ο繝輔ぅ繝ｼ繝ｫ繧ょｼｷ蛻ｶ譖ｴ譁ｰ縺励※邏蝉ｻ倥￠逶ｴ縺・
                    const userId = API.session?.user?.id;
                    if (userId) {
                        await API.update('profiles', userId, { organization_id: orgId }).catch(e=>{});
                    }
                } else {
                    throw new Error("邨・ｹ祢D縺ｮ逕滓・縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲・);
                }
            }

            // 3. 譌｢蟄倥ョ繝ｼ繧ｿ縺ｮ遒ｺ隱・(蜈ｨ蜑企勁縺ｯ縺励↑縺・
            const allStaffRes = await API.list('staff', { organization_id: `eq.${orgId}` });
            const currentStaff = allStaffRes.data || [];
            
            // 4. 荳崎ｶｳ蛻・・陬懷・
            // 蟆代↑縺上→繧・0蜷阪・遒ｺ菫昴＠縺溘＞
            const targetCount = 13;
            const currentCount = currentStaff.length;
            
            if (currentCount < targetCount) {
                this.showToast(`繧ｹ繧ｿ繝・ヵ繧定｣懷・荳ｭ... (${currentCount} -> ${targetCount}蜷・`, 'info');
                
                // 陬懷・逕ｨ繝・Φ繝励Ξ繝ｼ繝・(繧ｷ繝輔ヨ縺悟沂縺ｾ繧翫ｄ縺吶＞縲梧怙蠑ｷ繝舌う繝医阪ｒ蜷ｫ繧√ｋ)
                // 繝ｩ繝ｳ繧ｯA-D, 蟷ｴ髢謎ｼ第律蟇ｾ蠢・
                const templates = [
                    { name: "縲蝉ｸ・・縲台ｽ占陸 (蠎鈴聞)", role: 'manager', max_days: 5, max_hours: 8, wage: 1500, eval: 'A', salary_type: 'monthly', holidays: 105 }, 
                    { name: "縲蝉ｸ・・縲鷹斡譛ｨ (蜑ｯ蠎鈴聞)", role: 'manager', max_days: 5, max_hours: 8, wage: 1400, eval: 'A', salary_type: 'monthly', holidays: 110 },
                    { name: "鬮俶ｩ・(繝ｪ繝ｼ繝繝ｼ)", role: 'leader', max_days: 5, max_hours: 8, wage: 1300, eval: 'B', salary_type: 'monthly', holidays: 120 },
                    { name: "逕ｰ荳ｭ (繝輔Ν)", role: 'staff', max_days: 5, max_hours: 8, wage: 1100, eval: 'B' },
                    { name: "貂｡霎ｺ (繝輔Ν)", role: 'staff', max_days: 5, max_hours: 8, wage: 1100, eval: 'B' },
                    { name: "繝輔Μ繝ｼ繧ｿ繝ｼA (髟ｷ譎る俣)", role: 'staff', max_days: 5, max_hours: 8, wage: 1200, eval: 'C' }, 
                    { name: "繝輔Μ繝ｼ繧ｿ繝ｼB (髟ｷ譎る俣)", role: 'staff', max_days: 5, max_hours: 8, wage: 1200, eval: 'C' },
                    { name: "蟄ｦ逕櫃 (螟墓婿)", role: 'staff', max_days: 4, max_hours: 5, wage: 1000, eval: 'D' },
                    { name: "蟄ｦ逕櫂 (螟墓婿)", role: 'staff', max_days: 4, max_hours: 5, wage: 1000, eval: 'D' },
                    { name: "荳ｻ蟀ｦE (譏ｼ)", role: 'staff', max_days: 4, max_hours: 6, wage: 1050, eval: 'C' },
                    { name: "荳ｻ蟀ｦF (譏ｼ)", role: 'staff', max_days: 4, max_hours: 6, wage: 1050, eval: 'C' },
                    { name: "騾ｱ譛ｫG (蝨滓律)", role: 'staff', max_days: 2, max_hours: 8, wage: 1100, eval: 'D' },
                    { name: "譁ｰ莠ｺH", role: 'staff', max_days: 3, max_hours: 4, wage: 950, eval: 'D' }
                ];

                // 雜ｳ繧翫↑縺・ｺｺ謨ｰ蛻・□縺題ｿｽ蜉
                const addCount = targetCount - currentCount;
                const createdStaff = [];
                
                // 逶ｴ蛻怜ｮ溯｡後〒遒ｺ螳溘↓ID繧堤ｴ蝉ｻ倥￠繧・
                for (let i = 0; i < addCount; i++) {
                    const tmpl = templates[i % templates.length];
                    const uniqueName = currentCount > 0 ? `${tmpl.name} ${i+1}` : tmpl.name;
                    
                    // 蛟句挨縺ｮ菴懈・繧ｨ繝ｩ繝ｼ繧偵く繝｣繝・メ縺帙★縲∝､ｱ謨励＠縺溘ｉ蜈ｨ菴薙ｒ豁｢繧√ｋ
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
                        data.annual_holidays = tmpl.holidays; // 縺薙％縺ｧ菫晏ｭ・
                    }

                    const res = await API.create('staff', data);
                    
                    if (!res) {
                        throw new Error(`繧ｹ繧ｿ繝・ヵ縲・{uniqueName}縲阪・DB菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆縲３LS險ｭ螳壹ｒ遒ｺ隱阪＠縺ｦ縺上□縺輔＞縲Ａ);
                    }
                    createdStaff.push(res);
                }
                
                // State譖ｴ譁ｰ (譌｢蟄・+ 譁ｰ隕・
                this.state.staff = [...currentStaff, ...createdStaff];
                
                // 逕ｻ髱｢譖ｴ譁ｰ (繝ｪ繝ｭ繝ｼ繝峨↑縺励〒蜊ｳ譎ょ渚譏)
                this.renderCurrentView();
                this.showToast(`螳御ｺ・ｼ・${this.state.staff.length}蜷阪・繧ｹ繧ｿ繝・ヵ繧定｡ｨ遉ｺ荳ｭ`, 'success');
                
            } else {
                this.showToast('繧ｹ繧ｿ繝・ヵ謨ｰ縺ｯ蜊∝・縺ｧ縺・(繝・・繧ｿ邯ｭ謖・', 'success');
                this.state.staff = currentStaff;
            }

            // 5. 險ｭ螳壹ョ繝ｼ繧ｿ縺ｮ菫ｮ蠕ｩ (遨ｺ縺ｮ蝣ｴ蜷医・縺ｿ)
            if (!this.state.config.id) {
                // config縺ｯcreate_tenant RPC縺ｧ菴懈・縺輔ｌ繧九◆繧√√％縺薙〒縺ｯ蜀崎ｪｭ縺ｿ霎ｼ縺ｿ縺ｮ縺ｿ
                const confRes = await API.list('config_safe', { organization_id: `eq.${orgId}` });
                if(confRes.data?.[0]) this.state.config = { ...this.state.defaultConfig, ...confRes.data[0] };
            }

            this.renderCurrentView();
            this.showToast(`繝・・繧ｿ謨ｴ蛯吝ｮ御ｺ・ら樟蝨ｨ縺ｮ繧ｹ繧ｿ繝・ヵ: ${this.state.staff.length}蜷港, 'success');
            
        } catch(e) {
            console.error("Test data setup failed:", e);
            alert("繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆: " + e.message);
        } finally {
            this.showLoading(false);
        }
    },

    // =================================================================
    // =================================================================
    // HQ (譛ｬ驛ｨ) 繝繝・す繝･繝懊・繝・
    // =================================================================
    async renderHQDashboard(container) {
        if (!this.state.isHQ) return;

        this.showLoading(true);
        let shops = [];
        try {
            const result = await API.rpc('hq_get_all_shops', {});
            shops = result || [];
        } catch (e) {
            console.error('Failed to load shops', e);
            this.showToast('蠎苓・荳隕ｧ縺ｮ蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆', 'error');
        } finally {
            this.showLoading(false);
        }

        let tableRows = '';
        if (shops.length === 0) {
            tableRows = `<tr><td colspan="4" class="px-4 py-8 text-center text-gray-500">逋ｻ骭ｲ縺輔ｌ縺ｦ縺・ｋ蠎苓・縺後≠繧翫∪縺帙ｓ</td></tr>`;
        } else {
            tableRows = shops.map(shop => {
                const date = new Date(shop.created_at);
                const dateStr = `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}`;
                return `
                <tr class="hover:bg-indigo-50/50 cursor-pointer transition-colors border-b border-gray-100 group" onclick="app.switchToHQShop('${shop.organization_id}')">
                    <td class="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 group-hover:scale-110 transition-transform">
                                <i class="fa-solid fa-store"></i>
                            </div>
                            <span class="font-bold">${shop.name || '譛ｪ險ｭ螳・}</span>
                        </div>
                    </td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">${shop.contract_id || '-'}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm">
                        <span class="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                            ${shop.plan || 'Free'}
                        </span>
                    </td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-400">${dateStr}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <span class="text-indigo-600 hover:text-indigo-900 bg-white border border-indigo-200 px-3 py-1 rounded shadow-sm group-hover:bg-indigo-600 group-hover:text-white transition-colors">髢ｲ隕ｧ縺吶ｋ <i class="fa-solid fa-arrow-right ml-1"></i></span>
                    </td>
                </tr>
            `}).join('');
        }

        container.innerHTML = `
            <div class="max-w-6xl mx-auto space-y-6 pb-20">
                <div class="bg-gradient-to-r from-indigo-600 to-blue-600 rounded-2xl shadow-lg p-6 md:p-8 text-white flex justify-between items-center relative overflow-hidden">
                    <div class="relative z-10">
                        <h2 class="text-2xl md:text-3xl font-bold mb-2"><i class="fa-solid fa-building mr-2"></i>譛ｬ驛ｨ繝ｻ繝繝・す繝･繝懊・繝・/h2>
                        <p class="text-indigo-100 text-sm md:text-base">蜈ｨ繝・リ繝ｳ繝医・蠎苓・縺ｮ遞ｼ蜒咲憾豕√ｒ謚頑升繝ｻ遒ｺ隱阪〒縺阪∪縺呻ｼ域悽驛ｨ逕ｨ・峨・/p>
                    </div>
                    <div class="relative z-10 flex gap-3">
                        <button onclick="app.logout()" class="bg-white/20 hover:bg-white/30 backdrop-blur text-white px-4 py-2 rounded-lg font-bold transition flex items-center gap-2">
                            <i class="fa-solid fa-right-from-bracket"></i> 繝ｭ繧ｰ繧｢繧ｦ繝・
                        </button>
                    </div>
                    <div class="absolute right-0 top-0 opacity-10 text-[120px] leading-none transform translate-x-1/4 -translate-y-1/4 pointer-events-none">
                        <i class="fa-solid fa-globe"></i>
                    </div>
                </div>

                <!-- Manual Shop Login Card -->
                <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="px-6 py-4 border-b border-gray-200 bg-gray-50">
                        <h3 class="font-bold text-gray-800"><i class="fa-solid fa-key text-blue-500 mr-2"></i>謖・ｮ壹・蠎苓・繧帝夢隕ｧ (ID縺ｨ繝代せ繝ｯ繝ｼ繝峨〒繧｢繧ｯ繧ｻ繧ｹ)</h3>
                    </div>
                    <div class="p-6">
                        <div class="flex flex-col md:flex-row gap-4 items-end">
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-500 mb-1">螂醍ｴИD</label>
                                <input type="text" id="hqManualContractId" class="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="萓・ 123456789012345">
                            </div>
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-500 mb-1">繝代せ繝ｯ繝ｼ繝・/label>
                                <input type="password" id="hqManualPassword" class="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="蠎苓・逕ｨ縺ｾ縺溘・邂｡逅・・ヱ繧ｹ繝ｯ繝ｼ繝・ onkeydown="if(event.key==='Enter') app.hqManualShopLogin()">
                            </div>
                            <div>
                                <button onclick="app.hqManualShopLogin()" class="w-full md:w-auto px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow transition whitespace-nowrap">
                                    <i class="fa-solid fa-eye mr-2"></i>髢ｲ隕ｧ縺吶ｋ
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800"><i class="fa-solid fa-list text-gray-400 mr-2"></i>逋ｻ骭ｲ蠎苓・荳隕ｧ (${filteredShops.length}蠎苓・)</h3>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="min-w-full divide-y divide-gray-200">
                            <thead class="bg-gray-50">
                                <tr>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">蠎苓・蜷・/ 螂醍ｴИD</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">螂醍ｴИD</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">繝励Λ繝ｳ</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">逋ｻ骭ｲ譌･</th>
                                    <th scope="col" class="px-4 py-3 text-right text-xs font-bold text-gray-500 uppercase tracking-wider">謫堺ｽ・/th>
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
            this.showToast('螂醍ｴИD縺ｨ繝代せ繝ｯ繝ｼ繝峨ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'warning');
            return;
        }

        this.showLoading(true);
        try {
            // 蠎苓・縺ｮ繝代せ繝ｯ繝ｼ繝会ｼ医せ繧ｿ繝・ヵ縺ｾ縺溘・邂｡逅・・ｼ峨ｒ讀懆ｨｼ
            // 邂｡逅・・ヱ繧ｹ繝ｯ繝ｼ繝峨〒繧る壹ｋ繧医≧縺ｫ縲√∪縺・shop login縲√ム繝｡縺ｪ繧・admin login 繧定ｩｦ縺吶°縲《hop login 縺ｧ荳蜈・喧
            // 莉雁屓縺ｯ蠎苓・逕ｨ繝ｭ繧ｰ繧､繝ｳ繧定ｩｦ縺・
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
                await this.loadData();
                this.showToast('蠎苓・ (' + contractId + ') 縺ｮ髢ｲ隕ｧ繧帝幕蟋九＠縺ｾ縺・, 'success');
                this.changeView('dashboard');
            } else {
                // 邂｡逅・・→縺励※隧ｦ縺・
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
                    await this.loadData();
                    this.showToast('邂｡逅・・ｨｩ髯舌〒蠎苓・ (' + contractId + ') 縺ｮ髢ｲ隕ｧ繧帝幕蟋九＠縺ｾ縺・, 'success');
                    this.changeView('dashboard');
                } else {
                    this.showToast('ID縺ｾ縺溘・繝代せ繝ｯ繝ｼ繝峨′豁｣縺励￥縺ゅｊ縺ｾ縺帙ｓ', 'error');
                }
            }
        } catch(e) {
            console.error('HQ Manual Shop Login error:', e);
            this.showToast('繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    removeHQShop(orgId) {
        if (!confirm('縺薙・蠎苓・繧偵Μ繧ｹ繝医°繧牙炎髯､縺励∪縺吶°・歃n(窶ｻ繝・・繧ｿ繝吶・繧ｹ縺ｮ繝・・繧ｿ縺ｯ蜑企勁縺輔ｌ縺ｾ縺帙ｓ)')) return;
        try {
            let savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
            savedOrgIds = savedOrgIds.filter(id => id !== orgId);
            localStorage.setItem('hq_saved_shops', JSON.stringify(savedOrgIds));
            this.showToast('蠎苓・繧偵Μ繧ｹ繝医°繧牙炎髯､縺励∪縺励◆', 'info');
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
            await this.loadData();
            this.showToast('蠎苓・諠・ｱ繧定ｪｭ縺ｿ霎ｼ縺ｿ縺ｾ縺励◆・磯夢隕ｧ蟆ら畑繝｢繝ｼ繝会ｼ・, 'success');
            this.changeView('dashboard');
        } catch(e) {
            console.error('Shop loading error:', e);
            this.showToast('蠎苓・諠・ｱ縺ｮ隱ｭ縺ｿ霎ｼ縺ｿ縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // 1. 繝繝・す繝･繝懊・繝・(Dashboard)
    // =================================================================
    renderDashboard(container) {
        // 繧ｿ繧､繝槭・繧ｯ繝ｪ繧｢・亥ｿｵ縺ｮ縺溘ａ・・
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
                <!-- 蟾ｦ繧ｫ繝ｩ繝 -->
                <div class="lg:col-span-2 space-y-6">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <!-- 謇ｿ隱榊ｾ・■ (邂｡逅・・・蝣ｴ蜷医・縺ｿ繧ｯ繝ｪ繝・け蜿ｯ) -->
                        <div class="bg-white p-4 rounded-xl shadow-sm border ${pendingCount > 0 ? 'border-red-200 bg-red-50' : 'border-gray-200'} ${this.state.isAdmin ? 'cursor-pointer hover:scale-[1.02]' : ''} transition-transform" ${this.state.isAdmin ? `onclick="app.changeView('requests')"` : ''}>
                            <div class="flex justify-between items-start">
                                <div>
                                    <p class="text-xs font-bold text-gray-500 uppercase">譛ｪ謇ｿ隱阪・逕ｳ隲・/p>
                                    <h3 class="text-2xl font-bold ${pendingCount > 0 ? 'text-red-600' : 'text-gray-700'}">${pendingCount} <span class="text-sm text-gray-500">莉ｶ</span></h3>
                                </div>
                                <div class="w-10 h-10 rounded-full ${pendingCount > 0 ? 'bg-red-100 text-red-500' : 'bg-gray-100 text-gray-400'} flex items-center justify-center">
                                    <i class="fa-solid fa-inbox"></i>
                                </div>
                            </div>
                            ${this.state.isAdmin ? (pendingCount > 0 ? '<p class="text-xs text-red-500 mt-2 font-bold">遒ｺ隱阪＠縺ｦ縺上□縺輔＞</p>' : '<p class="text-xs text-gray-400 mt-2">蟇ｾ蠢懊・螳御ｺ・＠縺ｦ縺・∪縺・/p>') : '<p class="text-xs text-gray-400 mt-2">窶ｻ邂｡逅・ｺｺ縺ｮ縺ｿ髢ｲ隕ｧ蜿ｯ閭ｽ</p>'}
                        </div>

                        <!-- 譛ｬ譌･縺ｮ繧ｹ繧ｿ繝・ヵ謨ｰ -->
                        <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                             <div class="flex justify-between items-start">
                                <div>
                                    <p class="text-xs font-bold text-gray-500 uppercase">譛ｬ譌･縺ｮ蜃ｺ蜍､</p>
                                    <h3 class="text-2xl font-bold text-blue-600">${todayShiftsInitial.length} <span class="text-sm text-gray-500">蜷・/span></h3>
                                </div>
                                <div class="w-10 h-10 rounded-full bg-blue-50 text-blue-500 flex items-center justify-center">
                                    <i class="fa-solid fa-users"></i>
                                </div>
                            </div>
                            <p class="text-xs text-gray-400 mt-2">蝟ｶ讌ｭ譎る俣: ${this.state.config.opening_time || '09:00'} - ${this.state.config.closing_time || '22:00'}</p>
                        </div>
                    </div>

                    <!-- 莉頑律縺ｮ繧ｷ繝輔ヨ繝ｪ繧ｹ繝・-->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                        <div class="p-4 border-b border-gray-100 flex justify-between items-center">
                            <h3 class="font-bold text-gray-800 flex items-center gap-2">
                                <i class="fa-regular fa-calendar-check text-blue-500"></i> 莉頑律縺ｮ繧ｷ繝輔ヨ隧ｳ邏ｰ
                            </h3>
                            <span class="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-1 rounded" id="dashboardCurrentTime">${todayStr}</span>
                        </div>
                        
                        <div id="dashboardShiftList" class="divide-y divide-gray-50 max-h-[300px] overflow-y-auto">
                            <!-- JS縺ｧ閾ｪ蜍墓峩譁ｰ -->
                        </div>
                    </div>
                </div>

                <!-- 蜿ｳ繧ｫ繝ｩ繝 -->
                <div class="space-y-6">
                    <!-- 繧ｰ繝ｩ繝・(邂｡逅・・・縺ｿ陦ｨ遉ｺ) -->
                    ${this.state.isAdmin ? `
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                        <h3 class="font-bold text-gray-800 mb-1 text-sm">逶ｴ霑・譌･髢薙・莠ｺ莉ｶ雋ｻ(讎らｮ・</h3>
                        <p class="text-xs text-gray-400 mb-4">逾晄律蜑ｲ蠅励・莨第・謗ｧ髯､繧貞性縺ｿ縺ｾ縺・/p>
                        <div class="h-[200px] w-full">
                            <canvas id="dashboardChart"></canvas>
                        </div>
                    </div>
                    ` : ''}

                    <!-- 繧ｯ繧､繝・け繧｢繧ｯ繧ｷ繝ｧ繝ｳ -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                         <h3 class="font-bold text-gray-800 mb-3 text-sm">繧ｯ繧､繝・け繝｡繝九Η繝ｼ</h3>
                         <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            ${this.state.isAdmin ? `
                            <button onclick="app.openModal('staffModal'); document.getElementById('staffForm').reset(); document.getElementById('staffId').value='';" 
                                class="w-full text-left px-4 py-3 hover:bg-blue-50 rounded-lg text-sm font-bold text-gray-600 hover:text-blue-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-blue-200">
                                <i class="fa-solid fa-user-plus text-blue-500 text-lg"></i> 繧ｹ繧ｿ繝・ヵ霑ｽ蜉
                            </button>
                            ` : ''}
                            
                            <button onclick="app.openModal('requestModal'); app.initRequestModal();"
                                class="w-full text-left px-4 py-3 hover:bg-red-50 rounded-lg text-sm font-bold text-gray-600 hover:text-red-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-red-200">
                                <i class="fa-solid fa-umbrella-beach text-red-400 text-lg"></i> 莨代∩蟶梧悍繧貞・縺・
                            </button>

                            <button onclick="app.showShopRules()" 
                                class="w-full text-left px-4 py-3 hover:bg-orange-50 rounded-lg text-sm font-bold text-gray-600 hover:text-orange-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-orange-200">
                                <i class="fa-solid fa-book-open text-orange-400 text-lg"></i> 縺雁ｺ励・繝ｫ繝ｼ繝ｫ
                            </button>

                            <button id="btn-quick-shift" onclick="app.changeView('manual-shift')" 
                                class="w-full text-left px-4 py-3 hover:bg-teal-50 rounded-lg text-sm font-bold text-gray-600 hover:text-teal-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-teal-200">
                                <i class="fa-solid fa-calendar-days text-teal-500 text-lg"></i> 繧ｷ繝輔ヨ陦ｨ繧堤｢ｺ隱・
                            </button>
                         </div>
                    </div>
                </div>
            </div>
        `;

        // 閾ｪ蜍墓峩譁ｰ髢｢謨ｰ
        const updateShiftList = () => {
            const listContainer = document.getElementById('dashboardShiftList');
            const timeDisplay = document.getElementById('dashboardCurrentTime');
            if (!listContainer) return;

            const now = new Date();
            // 菫ｮ豁｣: 譎る俣繧ゅぞ繝ｭ繝代ョ繧｣繝ｳ繧ｰ縺励※2譯√↓縺吶ｋ (萓・ 1:05 -> 01:05)
            // 縺薙ｌ縺ｫ繧医ｊ譁・ｭ怜・豈碑ｼ・"01:00" >= "09:00" 縺梧ｭ｣縺励￥ false 縺ｫ縺ｪ繧・
            const currentHour = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
            
            // 譎ょ綾陦ｨ遉ｺ譖ｴ譁ｰ
            if(timeDisplay) timeDisplay.textContent = `${todayStr} ${currentHour}`;

            const todayShifts = this.state.shifts
                .filter(s => s.date === todayStr)
                .sort((a, b) => a.start_time.localeCompare(b.start_time));

            if (todayShifts.length === 0) {
                listContainer.innerHTML = '<div class="p-6 text-center text-gray-400 text-sm">譛ｬ譌･縺ｮ繧ｷ繝輔ヨ縺ｯ縺ゅｊ縺ｾ縺帙ｓ</div>';
                return;
            }

            listContainer.innerHTML = todayShifts.map(s => {
                const staff = this.getStaff(s.staff_id);
                
                // 蜍､蜍咏憾豕∝愛螳・(譌･縺ｾ縺溘℃蟇ｾ蠢・
                let isWorking = false;
                let isFinished = false;

                if (s.start_time > s.end_time) {
                    // 譌･縺ｾ縺溘℃繧ｷ繝輔ヨ (萓・ 22:00 - 05:00)
                    // 迴ｾ蝨ｨ譎ょ綾縺碁幕蟋区凾蛻ｻ莉･髯・22:00-23:59) 縺ｾ縺溘・ 邨ゆｺ・凾蛻ｻ莉･蜑・00:00-05:00)
                    if (currentHour >= s.start_time || currentHour <= s.end_time) {
                        isWorking = true;
                    } else {
                        // 蜍､蜍呎凾髢灘､・
                        // 萓・ 06:00 (邨ゆｺ・ｾ・ -> 21:00 (髢句ｧ句燕)
                        // 莉頑律縺ｮ譌･莉倥・繧ｷ繝輔ヨ縺ｨ縺励※謇ｱ繧上ｌ縺ｦ縺・ｋ縺溘ａ縲∫ｵゆｺ・凾蛻ｻ繧帝℃縺弱※縺・ｌ縺ｰ縲檎ｵゆｺ・阪→縺ｿ縺ｪ縺・
                        isFinished = currentHour > s.end_time && currentHour < s.start_time;
                    }
                } else {
                    // 騾壼ｸｸ繧ｷ繝輔ヨ (萓・ 09:00 - 18:00)
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
                                <div class="font-bold text-sm text-gray-800">${staff ? staff.name : '蜑企勁貂医せ繧ｿ繝・ヵ'}</div>
                                <div class="text-[10px] text-gray-500">${s.start_time} - ${s.end_time}</div>
                            </div>
                        </div>
                        <div>
                            ${isWorking ? '<span class="text-[10px] font-bold text-green-600 flex items-center gap-1"><span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>蜍､蜍吩ｸｭ</span>' : ''}
                            ${isFinished ? '<span class="text-[10px] font-bold text-gray-400">蜍､蜍咏ｵゆｺ・/span>' : ''}
                            ${!isWorking && !isFinished ? '<span class="text-[10px] font-bold text-blue-500">蜃ｺ蜍､蜑・/span>' : ''}
                        </div>
                    </div>
                `;
            }).join('');
        };

        // 蛻晏屓螳溯｡・
        updateShiftList();

        // 繧ｿ繧､繝槭・繧ｻ繝・ヨ (1蛻・＃縺ｨ)
        this.state.dashboardTimer = setInterval(updateShiftList, 60000);

        // 繝√Ε繝ｼ繝域緒逕ｻ
        setTimeout(() => {
            const ctx = document.getElementById('dashboardChart');
            if(ctx) {
                if (this.dashboardChartInstance) this.dashboardChartInstance.destroy();

                this.dashboardChartInstance = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: chartData.labels,
                        datasets: [{
                            label: '譌･谺｡莠ｺ莉ｶ雋ｻ (蜀・',
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
                            y: { display: true, ticks: { callback: v => 'ﾂ･' + v/1000 + 'k', font: { size: 10 } }, grid: { color: '#f3f4f6' } }, 
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
    // 2. 逕ｳ隲九Μ繧ｹ繝・(Requests) - Admin Only
    // =================================================================
    renderRequests(container) {
        if (!this.state.isAdmin) {
             container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-gray-500">
                    <i class="fa-solid fa-lock text-4xl mb-4 text-gray-300"></i>
                    <p class="font-bold text-gray-600">讓ｩ髯舌′縺ゅｊ縺ｾ縺帙ｓ</p>
                    <p class="text-sm">逕ｳ隲九・邂｡逅・ｒ陦後≧縺ｫ縺ｯ邂｡逅・・→縺励※繝ｭ繧ｰ繧､繝ｳ縺励※縺上□縺輔＞</p>
                    <button onclick="app.openModal('loginModal')" class="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg font-bold shadow hover:bg-blue-700">邂｡逅・・Ο繧ｰ繧､繝ｳ</button>
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
                            <i class="fa-solid fa-inbox text-blue-600"></i> 謇ｿ隱榊ｾ・■
                            <span class="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">${pending.length}</span>
                        </h3>
                        ${pending.length > 1 ? `<button onclick="app.handleBatchApprove()" class="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1"><i class="fa-solid fa-check-double"></i> 蜈ｨ縺ｦ謇ｿ隱・/button>` : ''}
                    </div>
                    <div class="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                        ${pending.length === 0 ? '<div class="p-8 text-center text-gray-400">迴ｾ蝨ｨ縲∵価隱榊ｾ・■縺ｮ逕ｳ隲九・縺ゅｊ縺ｾ縺帙ｓ</div>' : ''}
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
                                                <div class="font-bold text-gray-800 text-sm">${staff ? staff.name : '荳肴・'}</div>
                                                <div class="text-xs text-gray-500">${new Date(req.created_at || Date.now()).toLocaleDateString()} 逕ｳ隲・/div>
                                            </div>
                                        </div>
                                        <span class="text-xs font-bold px-2 py-1 rounded bg-yellow-100 text-yellow-700">
                                            ${req.type === 'off' ? '莨代∩蟶梧悍' : '蜍､蜍吝ｸ梧悍'}
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
                                                蜊ｴ荳・
                                            </button>
                                            <button onclick="app.handleRequest('${req.id}', 'approved')" class="px-4 py-1.5 bg-blue-600 text-white rounded text-xs font-bold hover:bg-blue-700 shadow-sm transition-colors flex items-center gap-1">
                                                <i class="fa-solid fa-check"></i> 謇ｿ隱・
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
                            <i class="fa-solid fa-clock-rotate-left text-gray-500"></i> 蜃ｦ逅・ｱ･豁ｴ (逶ｴ霑・0莉ｶ)
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
                                            <span class="font-bold text-gray-700">${staff ? staff.name : '荳肴・'}</span>
                                            <span class="text-gray-400 mx-1">|</span>
                                            <span class="text-gray-600">${req.dates}</span>
                                        </div>
                                    </div>
                                    <span class="font-bold text-xs ${isApproved ? 'text-green-600' : 'text-red-500'}">
                                        ${isApproved ? '謇ｿ隱肴ｸ・ : '蜊ｴ荳・}
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
    // 3. 繧ｷ繝輔ヨ繝薙Η繝ｼ (Shift View: Table & Calendar)
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
                <div class="flex items-center bg-white border border-gray-200 p-1 rounded-lg ml-4">
                    <button onclick="app.switchShiftTablePeriod('month')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='month')}">譛磯俣</button>
                    <button onclick="app.switchShiftTablePeriod('2weeks')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='2weeks')}">2騾ｱ髢・/button>
                    <button onclick="app.switchShiftTablePeriod('week')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='week')}">1騾ｱ髢・/button>
                </div>
            `;
        }

        // Navigation arrows for Week/2Weeks
        let navControls = '';
        if (isTable && p !== 'month') {
            const label = p === 'week' ? '1騾ｱ髢・ : '2騾ｱ髢・;
            navControls = `
                <div class="flex items-center gap-1 ml-2">
                    <button onclick="app.changeTablePeriod(-1)" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-600 transition">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <span class="text-xs font-bold text-gray-500">${label}遘ｻ蜍・/span>
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
                        <h2 class="text-lg font-bold text-gray-800">繧ｷ繝輔ヨ陦ｨ</h2>
                        <span class="text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded font-mono whitespace-nowrap">
                            ${this.state.currentDate.getFullYear()}蟷ｴ${this.state.currentDate.getMonth()+1}譛・
                            ${isTable && p !== 'month' ? `<span class="ml-1 text-xs text-blue-600">(${this.state.currentDate.getDate()}譌･縲・</span>` : ''}
                        </span>
                        ${navControls}
                    </div>
                    
                    <div class="flex items-center gap-2">
                        ${this.state.isAdmin ? `
                        <button onclick="app.openModal('autoFillModal')" class="flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> AI繧ｷ繝輔ヨ菴懈・
                        </button>
                        ` : ''}
                        ${periodControls}
                        <div class="flex bg-white border border-gray-200 p-1 rounded-lg">
                            <button onclick="app.switchShiftViewMode('table')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-solid fa-table-list mr-1"></i>陦ｨ
                            </button>
                            <button onclick="app.switchShiftViewMode('calendar')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${!isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-regular fa-calendar-days mr-1"></i>繧ｫ繝ｬ繝ｳ繝繝ｼ
                            </button>
                        </div>
                    </div>
                </div>
                <div id="shiftViewContent" class="flex-1 overflow-x-auto overflow-y-hidden bg-white rounded-xl shadow-sm border border-gray-200 relative">
                    <!-- Content injected here -->
                </div>
                <div class="flex justify-end pt-2">
                    <button onclick="app.printShiftTable()" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 transition">
                        <i class="fa-solid fa-print mr-2"></i>蜊ｰ蛻ｷ
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
            // 1騾ｱ髢薙↑繧峨＆繧峨↓蟷・ｒ蠎・￡縺ｦ15蛻・腰菴阪ｒ隕九ｄ縺吶￥縺吶ｋ (1200px = 1h50px = 15m12.5px)
            colWidthClass = period === 'week' ? 'min-w-[1200px]' : 'min-w-[600px]';
            isGanttMode = true; 
            
            const start = new Date(this.state.currentDate);
            days = Array.from({length: range}, (_, i) => {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                return d;
            });
        }
        
        // 繝倥ャ繝繝ｼ逕滓・
        let headerHtml = `<th class="p-3 sticky left-0 z-50 bg-gray-50 border-b border-r border-gray-200 min-w-[120px] text-left text-xs font-bold text-gray-500 uppercase tracking-wider">繧ｹ繧ｿ繝・ヵ</th>`;
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
            
            // 譎る俣繧ｹ繧ｱ繝ｼ繝ｫ繧偵・繝・ム繝ｼ縺ｫ霑ｽ蜉 (繧ｬ繝ｳ繝医メ繝｣繝ｼ繝育畑)
            let timeScale = '';
            if (isGanttMode) {
                // 1譎る俣縺翫″縺ｫ謨ｰ蟄励ｒ陦ｨ遉ｺ
                let scaleHtml = '';
                for (let i = 0; i <= 24; i++) {
                    const left = (i / 24) * 100;
                    // 謨ｰ蟄励・髢灘ｼ輔″: 蟷・′迢ｭ縺・ｴ蜷医・蛛ｶ謨ｰ縺ｮ縺ｿ
                    if (period === '2weeks' && i % 2 !== 0) continue;
                    
                    scaleHtml += `<span class="absolute -translate-x-1/2 font-mono" style="left: ${left}%">${String(i).padStart(2,'0')}</span>`;
                    
                    // 15蛻・綾縺ｿ縺ｮ逶ｮ逶帙ｊ (Week繝｢繝ｼ繝峨・縺ｿ)
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
                    <span class="text-[10px] font-normal block">${['譌･','譛・,'轣ｫ','豌ｴ','譛ｨ','驥・,'蝨・][dayOfWeek]}</span>
                </div>
                ${timeScale}
            </th>`;
        });

        // 繝懊ョ繧｣逕滓・
        let bodyHtml = '';
        this.state.staff.forEach(staff => {
            bodyHtml += `<tr data-staff-id="${staff.id}">`;
            bodyHtml += `<td class="p-3 sticky left-0 z-40 bg-white border-b border-r border-gray-100 font-bold text-sm text-gray-800 truncate h-14">${this._sanitize(staff.name)}</td>`;
            
            days.forEach(date => {
                const y = date.getFullYear();
                const m = date.getMonth() + 1;
                const d = date.getDate();
                const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                
                // 驕主悉譌･蛻､螳・
                const checkDate = new Date(date);
                checkDate.setHours(0,0,0,0);
                const today = new Date();
                today.setHours(0,0,0,0);
                const isPast = checkDate < today;

                // 繧ｷ繝輔ヨ讀懃ｴ｢
                const shift = this.state.shifts.find(s => s.staff_id === staff.id && s.date === dateStr);
                
                // 繧ｻ繝ｫ閭梧勹濶ｲ
                const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
                let bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines' : 'bg-white';
                
                if (isPast) {
                    bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines opacity-75' : 'bg-gray-50/30';
                } else if (!shift && !isSpecialHoliday) {
                    bgClass = 'hover:bg-gray-50';
                }

                // 繧ｻ繝ｫ繧｢繧ｯ繧ｷ繝ｧ繝ｳ (繧ｬ繝ｳ繝医Δ繝ｼ繝峨〒縺ｯ繝舌・縺ｮ繝峨Λ繝・げ謫堺ｽ懊′縺ゅｋ縺溘ａ縲∫ｩｺ繧ｻ繝ｫ縺ｮ縺ｿ繧ｯ繝ｪ繝・け繧､繝吶Φ繝・
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

                // 繧ｬ繝ｳ繝医メ繝｣繝ｼ繝育畑: 蝟ｶ讌ｭ譎る俣縺ｮ閭梧勹・・pen-Close莉･螟悶ｒ繧ｰ繝ｬ繝ｼ繧｢繧ｦ繝茨ｼ峨ｒ逕滓・縺吶ｋ縺溘ａ縺ｮ譎る俣蜿門ｾ・
                let openTime = "09:00";
                let closeTime = "22:00";
                if (isGanttMode) {
                    const dayOfWeek = new Date(dateStr).getDay();
                    const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
                    const isHoliday = jh ? jh.isHoliday(dateStr) : false;
                    
                    // 迚ｹ螳壽律險ｭ螳・
                    const specialDay = (this.state.config.special_days || {})[dateStr];
                    if (specialDay) {
                        openTime = specialDay.start;
                        closeTime = specialDay.end;
                    } else {
                        // 騾壼ｸｸ蝟ｶ讌ｭ險ｭ螳・
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
                    
                    // 繧､繝ｬ繧ｮ繝･繝ｩ繝ｼ繧｢繧ｵ繧､繝ｳ・育､ｾ蜩｡縺ｮ蠑ｷ蛻ｶ繧｢繧ｵ繧､繝ｳ遲会ｼ峨・蠑ｷ隱ｿ
                    let isExempt = false;
                    if (staff && staff.unavailable_dates) {
                        const uDates = Array.isArray(staff.unavailable_dates) ? staff.unavailable_dates : String(staff.unavailable_dates).split(',');
                        isExempt = uDates.some(d => String(d).trim() === 'isExempt:true');
                    }
                    if (isExempt) {
                        barColor = 'bg-emerald-50 text-emerald-800 border-emerald-500 border-2 shadow-inner ring-1 ring-emerald-300 ring-inset';
                    }
                    if (shift.is_irregular) {
                        barColor = 'bg-red-50 text-red-700 border-red-500 border-2 pattern-diagonal-lines ring-2 ring-red-400 ring-inset';
                    }
                    
                    // 驕主悉縺ｮ蝣ｴ蜷医・蟆代＠騾乗・縺ｫ縺励※蜈・・濶ｲ繧呈ｮ九☆
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
                        
                        // 蝟ｶ讌ｭ譎る俣螟悶・繧ｹ繧ｯ (Open蜑阪，lose蠕・
                        const openPct = timeToPct(openTime);
                        const closePct = timeToPct(closeTime);
                        
                        // CSS Gradient縺ｧ邏ｰ縺九＞繧ｰ繝ｪ繝・ラ繧呈緒逕ｻ
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
                            
                            <!-- Business Hours Mask (蜑企勁: 縺碑ｦ∵悍縺ｫ繧医ｊ1騾ｱ髢薙ン繝･繝ｼ縺ｧ縺ｮ繧ｰ繝ｬ繝ｼ繧｢繧ｦ繝域賜髯､) -->
                        `;
                        
                        const adminDrag = this.state.isAdmin ? `data-shift-id="${shift.id}" data-staff-id="${staff.id}" data-date="${dateStr}" style="left: ${startPct}%; width: ${Math.max(widthPct, 0.5)}%; min-width: 2px; cursor: grab;"` : `style="left: ${startPct}%; width: ${Math.max(widthPct, 0.5)}%; min-width: 2px;"`;
                        const resizeHandles = this.state.isAdmin ? `
                                    <div class="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/10 rounded-l" style="touch-action:none;"></div>
                                    <div class="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/10 rounded-r" style="touch-action:none;"></div>
                        ` : '';
                        content = `
                            <div class="w-full h-full relative group bg-white overflow-hidden">
                                ${bgGuides}
                                <!-- Bar with text -->
                                <div class="absolute top-1/2 -translate-y-1/2 h-8 ${period==='week'?'':'h-6'} rounded ${barColor} border shadow-sm flex items-center justify-center overflow-hidden z-10 hover:brightness-95 transition-all px-1"
                                     ${adminDrag}
                                     ${this.state.isHQ ? '' : `ondblclick="app.openEditShift('${shift.id}')"`}>
                                     ${resizeHandles}
                                     <span class="text-[10px] md:text-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none select-none">
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
                    content = `<div class="w-full h-full flex items-center justify-center"><span class="text-[10px] text-red-300 font-bold">莨・/span></div>`;
                }

                // Gantt繝｢繝ｼ繝峨・蝣ｴ蜷医・遨ｺ繧ｻ繝ｫ縺ｫ繧ゅぎ繧､繝臥ｷ壹ｒ陦ｨ遉ｺ
                if (!shift && isGanttMode && !isSpecialHoliday) {
                    // 蝟ｶ讌ｭ譎る俣蜿門ｾ・(郢ｰ繧願ｿ斐＠繝ｭ繧ｸ繝・け縺ｫ縺ｪ繧九′縲《hift譛臥┌縺ｫ髢｢繧上ｉ縺壼ｿ・ｦ・
                    // 荳願ｨ倥〒險育ｮ玲ｸ医∩螟画焚繧貞・蛻ｩ逕ｨ
                    const timeToPct = (t) => {
                        const [h, m] = t.split(':').map(Number);
                        return ((h + m/60) / 24) * 100;
                    };
                    const openPct = timeToPct(openTime);
                    const closePct = timeToPct(closeTime);

                    // CSS Gradient縺ｧ邏ｰ縺九＞繧ｰ繝ｪ繝・ラ繧呈緒逕ｻ
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
                        
                        <!-- Business Hours Mask (騾乗・蛹・ -->
                    `;
                    content = `<div class="w-full h-full relative group overflow-hidden bg-white">${guides}</div>`;
                }

                bodyHtml += `<td class="p-0 border-b border-r border-gray-100 h-14 relative transition-colors ${bgClass} ${cursor}" ${action}>${content}</td>`;
            });
            bodyHtml += `</tr>`;
        });

        // === 莠ｺ蜩｡荳崎ｶｳ繧｢繝ｩ繝ｼ繝郁｡後・逕滓・ ===
        let alertRowHtml = '';
        if (this.state.isAdmin && this.state.config) {
            const staffReq = this.state.config.staff_req || this.state.defaultConfig.staff_req;
            const closedDays = this.state.config.closed_days || [];
            const specialHolidays = this.state.config.special_holidays || [];

            alertRowHtml += `<tr>`;
            alertRowHtml += `<td class="p-2 sticky left-0 z-40 bg-white border-b border-r border-gray-100 text-xs font-bold text-gray-500 h-10 whitespace-nowrap">
                <i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1"></i>莠ｺ蜩｡迥ｶ豕・
            </td>`;

            days.forEach(date => {
                const m = date.getMonth() + 1;
                const d = date.getDate();
                const dateStr = `${date.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const dayOfWeek = date.getDay();
                const jsDow = dayOfWeek; // 0=譌･, 6=蝨・

                // 莨第･ｭ譌･繝√ぉ繝・け
                const isSpecialHoliday = specialHolidays.includes(dateStr);
                const isClosedDay = closedDays.map(Number).includes(jsDow);
                if (isSpecialHoliday || isClosedDay) {
                    alertRowHtml += `<td class="p-0 border-b border-r border-gray-100 h-10 bg-gray-50 text-center">
                        <span class="text-[10px] text-gray-300">-</span>
                    </td>`;
                    return;
                }

                // 逾晄律繝√ぉ繝・け
                const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
                const isHoliday = jh ? jh.isHoliday(dateStr) : false;

                // 蠢・ｦ∽ｺｺ謨ｰ繧貞叙蠕暦ｼ医・繝ｼ繧ｹ蛟､・・
                let required = parseInt(staffReq.min_weekday || 2);
                if (isHoliday || dayOfWeek === 0) {
                    required = parseInt(staffReq.min_holiday || 3);
                } else if (dayOfWeek === 6) {
                    required = parseInt(staffReq.min_weekend || 3);
                }

                // 蝟ｶ讌ｭ譎る俣縺ｮ蜿門ｾ・
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
                if (closeM <= openM) closeM += 24 * 60; // 譌･縺ｾ縺溘℃蟇ｾ蠢・

                // 譎る俣蟶ｯ蛻･縺ｮ蠢・ｦ∽ｺｺ謨ｰ繝ｫ繝ｼ繝ｫ驕ｩ逕ｨ・・ays驟榊・縺ｮ蝙九ｒ謨ｰ蛟､縺ｫ邨ｱ荳縺励※螳牙・縺ｫ繝輔ぅ繝ｫ繧ｿ・・
                const timeRules = (this.state.config.time_staff_req || []).filter(r => (r.days || []).map(Number).includes(jsDow));

                // 15蛻・せ繝ｭ繝・ヨ縺斐→縺ｫ縲悟酔譎ょ惠邀堺ｺｺ謨ｰ縲貢s縲後◎縺ｮ繧ｹ繝ｭ繝・ヨ縺ｮ隕∽ｻｶ縲阪ｒ豈碑ｼ・
                const shiftsForDay = this.state.shifts.filter(s => s.date === dateStr);
                let totalSlots = 0;
                let shortageSlots = 0;
                let worstDeficit = 0; // 譛謔ｪ縺ｮ荳崎ｶｳ謨ｰ・域ｭ｣蛟､=荳崎ｶｳ縺ゅｊ・・
                let maxConcurrent = 0;
                let maxSlotReq = required;
                let surplusSlots = 0;

                for (let t = openM; t < closeM; t += 15) {
                    // 縺薙・繧ｹ繝ｭ繝・ヨ縺ｧ縺ｮ蠢・ｦ∽ｺｺ謨ｰ・医・繝ｼ繧ｹ or 譎る俣蟶ｯ蛻･繝ｫ繝ｼ繝ｫ縺ｮ螟ｧ縺阪＞譁ｹ・・
                    let slotReq = required;
                    timeRules.forEach(rule => {
                        const rs = toMins(rule.start);
                        let re = toMins(rule.end);
                        if (re <= rs) re += 24 * 60;
                        if (t >= rs && t < re) {
                            slotReq = Math.max(slotReq, parseInt(rule.count || 0));
                        }
                    });

                    // 縺薙・繧ｹ繝ｭ繝・ヨ縺ｮ蜷梧凾蝨ｨ邀堺ｺｺ謨ｰ
                    const concurrent = shiftsForDay.filter(s => {
                        const sStart = toMins(s.start_time);
                        let sEnd = toMins(s.end_time);
                        if (sEnd <= sStart) sEnd += 24 * 60;
                        return sStart <= t && t < sEnd;
                    }).length;

                    totalSlots++;
                    const slotDeficit = slotReq - concurrent;
                    if (slotDeficit > 0) shortageSlots++;
                    if (slotDeficit > worstDeficit) worstDeficit = slotDeficit;
                    if (slotReq > maxSlotReq) maxSlotReq = slotReq;
                    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
                    if (concurrent > slotReq + 1) surplusSlots++;
                }

                // 陦ｨ遉ｺ逕ｨ: 繧ｹ繝ｭ繝・ヨ縺斐→縺ｮ蛻・梵邨先棡縺九ｉ蛻､螳夲ｼ按ｱ1縺ｮ螳滓・陦ｨ遉ｺ・・
                const assigned = shiftsForDay.length;

                let cellContent = '';
                let cellBg = 'bg-white';
                if (shortageSlots > 0) {
                    // 荳崎ｶｳ繧ｹ繝ｭ繝・ヨ縺後≠繧・
                    cellBg = 'bg-red-50';
                    const label = shortageSlots > totalSlots / 2 ? `${worstDeficit}蜷堺ｸ崎ｶｳ` : '荳驛ｨ荳崎ｶｳ';
                    cellContent = `<div class="flex flex-col items-center justify-center h-full">
                        <span class="text-red-600 font-black text-sm animate-pulse">${label}</span>
                        <span class="text-xs font-bold text-red-500">${assigned}蜷埼・鄂ｮ(隕・{maxSlotReq}蜷・</span>
                    </div>`;
                } else if (surplusSlots > totalSlots / 3) {
                    // 驕主臆繧ｹ繝ｭ繝・ヨ縺悟､壹＞・按ｱ1雜・∴・・
                    cellBg = 'bg-amber-50';
                    cellContent = `<div class="flex flex-col items-center justify-center h-full">
                        <span class="text-amber-500 text-sm font-bold"><i class="fa-solid fa-arrow-up"></i>驕主臆</span>
                        <span class="text-xs font-bold text-amber-500">${assigned}蜷埼・鄂ｮ(隕・{maxSlotReq}蜷・</span>
                    </div>`;
                } else {
                    // ﾂｱ1莉･蜀・〒驕ｩ豁｣
                    cellContent = `<div class="flex flex-col items-center justify-center h-full">
                        <span class="text-green-500 text-sm font-bold"><i class="fa-solid fa-check"></i></span>
                        <span class="text-xs font-bold text-green-600">${assigned}蜷埼・鄂ｮ(隕・{maxSlotReq}蜷・</span>
                    </div>`;
                }

                alertRowHtml += `<td class="p-0 border-b border-r border-gray-100 h-10 ${cellBg} text-center">${cellContent}</td>`;
            });
            alertRowHtml += `</tr>`;
        }

        container.innerHTML = `
            <div class="h-full overflow-auto custom-scrollbar">
                <table class="w-full border-collapse">
                    <thead><tr>${headerHtml}</tr></thead>
                    <tbody id="shiftTableBody">
                        ${alertRowHtml}
                        ${bodyHtml}
                    </tbody>
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
            <div class="h-full overflow-y-auto overflow-x-auto custom-scrollbar">
                <div class="bg-white rounded-t-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="grid grid-cols-7 border-b border-gray-200 bg-gray-50 sticky top-0 z-10 shadow-sm">
                        ${['譌･', '譛・, '轣ｫ', '豌ｴ', '譛ｨ', '驥・, '蝨・].map((day, i) => 
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
            
            // 驕主悉譌･蛻､螳・
            const todayD = new Date();
            todayD.setHours(0,0,0,0);
            const isPast = currentD < todayD;

            let dateColorClass = 'text-gray-700';
            let dateBgClass = isPast ? 'bg-gray-100' : '';
            if (isPast) dateColorClass = 'text-gray-400';
            
            // 閾ｨ譎ゆｼ第･ｭ蛻､螳・
            const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
            // 迚ｹ螳壽律蛻､螳・(遏ｭ邵ｮ蝟ｶ讌ｭ縺ｪ縺ｩ)
            const specialDayConfig = (this.state.config.special_days || {})[dateStr];
            // 蛯呵・Γ繝｢
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
            const cellAction = this.state.isAdmin ? `onclick="app.openAddShift('${dateStr}')"` : `onclick="app.showToast('繧ｷ繝輔ヨ縺ｮ邱ｨ髮・・邂｡逅・・・縺ｿ蜿ｯ閭ｽ縺ｧ縺・)"` ;
            const hoverClass = this.state.isAdmin ? 'hover:bg-blue-50/30 cursor-pointer' : '';
            
            // 繧｢繧ｯ繧ｷ繝ｧ繝ｳ繝懊ち繝ｳ鄒､ (邂｡逅・・・縺ｿ)
            let actionBtns = '';
            if (this.state.isAdmin) {
                actionBtns = `
                    <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick="event.stopPropagation(); app.openCalendarNoteModal('${dateStr}')" class="text-gray-400 hover:text-yellow-500 w-5 h-5 flex items-center justify-center rounded hover:bg-yellow-50" title="繝｡繝｢邱ｨ髮・>
                            <i class="fa-regular fa-note-sticky"></i>
                        </button>
                        <button onclick="event.stopPropagation(); app.openAddShift('${dateStr}')" class="text-gray-400 hover:text-blue-600 w-5 h-5 flex items-center justify-center rounded hover:bg-blue-50" title="繧ｷ繝輔ヨ霑ｽ蜉">
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

            // 繧ｫ繝ｬ繝ｳ繝繝ｼ蜀肴緒逕ｻ
            if (this.state.shiftViewMode === 'calendar') {
                this.renderCalendar(document.getElementById('shiftViewContent'));
            }
            this.closeModal('calendarNoteModal');
            this.showToast('繝｡繝｢繧剃ｿ晏ｭ倥＠縺ｾ縺励◆', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async deleteCalendarNote() {
        if (!confirm('縺薙・繝｡繝｢繧貞炎髯､縺励∪縺吶°・・)) return;
        const date = (document.getElementById('noteDate')?.value || '');
        
        if (this.state.config.calendar_notes && this.state.config.calendar_notes[date]) {
            delete this.state.config.calendar_notes[date];
            
            this.showLoading(true);
            try {
                await API.rpc('update_config_safe', {
                    p_config_id: this.state.config.id,
                    p_data: { calendar_notes: this.state.config.calendar_notes }
                });

                // 繧ｫ繝ｬ繝ｳ繝繝ｼ蜀肴緒逕ｻ
                if (this.state.shiftViewMode === 'calendar') {
                    this.renderCalendar(document.getElementById('shiftViewContent'));
                }
                this.closeModal('calendarNoteModal');
                this.showToast('繝｡繝｢繧貞炎髯､縺励∪縺励◆', 'success');
            } catch (e) {
                this.showToast('蜑企勁縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
            } finally {
                this.showLoading(false);
            }
        } else {
            this.closeModal('calendarNoteModal');
        }
    },

    // =================================================================
    // 4. 蛻・梵 (Analytics) - Admin Only
    // =================================================================
    renderAnalytics(container) {
        if (!this.state.isAdmin) return; // Sidebar should hide this, but safe guard.
        
        const stats = this.calculateMonthlyAnalytics();
        
        // 繝倥Ν繝代・髢｢謨ｰ: 譌･譛ｬ隱樣夊ｲｨ陦ｨ險・
        const formatMoney = (n) => {
            if(n < 10000) return 'ﾂ･' + n.toLocaleString();
            const man = Math.floor(n / 10000);
            const rest = n % 10000;
            return `${man}荳・{rest > 0 ? rest.toLocaleString() : ''}蜀・;
        };

        container.innerHTML = `
            <div class="space-y-6">
                <h2 class="text-xl font-bold text-gray-800">蛻・梵繝ｬ繝昴・繝・(${this.state.currentDate.getFullYear()}蟷ｴ${this.state.currentDate.getMonth()+1}譛・</h2>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">譛磯俣謗ｨ螳壻ｺｺ莉ｶ雋ｻ</p>
                        <h3 class="text-2xl font-bold text-gray-800 mt-2 truncate" title="${stats.totalCost.toLocaleString()}蜀・>
                            ${formatMoney(stats.totalCost)}
                        </h3>
                        <p class="text-xs text-gray-400 mt-1">窶ｻ逾晄律蜑ｲ蠅励・豺ｱ螟懈焔蠖薙ｒ蜷ｫ繧讎らｮ・/p>
                    </div>
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">邱丞感蜒肴凾髢・/p>
                        <h3 class="text-2xl font-bold text-blue-600 mt-2">${stats.totalHours.toFixed(1)}h</h3>
                    </div>
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">繧ｹ繧ｿ繝・ヵ遞ｼ蜒肴焚</p>
                        <h3 class="text-2xl font-bold text-indigo-600 mt-2">${stats.activeStaffCount} <span class="text-lg text-gray-500">蜷・/span></h3>
                    </div>
                </div>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">譌･谺｡繧ｳ繧ｹ繝域耳遘ｻ</h3><div class="h-[200px] sm:h-[300px]"><canvas id="dailyCostChart"></canvas></div></div>
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">繧ｹ繧ｿ繝・ヵ蛻･繧ｳ繧ｹ繝域ｧ区・豈・/h3><div class="h-[200px] sm:h-[300px] flex justify-center"><canvas id="staffShareChart"></canvas></div></div>
                </div>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50"><h3 class="font-bold text-gray-800">繧ｹ繧ｿ繝・ヵ蛻･隧ｳ邏ｰ繝ｻ蜉ｴ蜒肴凾髢薙メ繧ｧ繝・け</h3></div>
                    <div class="overflow-x-auto"><table class="w-full text-left text-sm">
                        <thead class="bg-gray-50 text-gray-500 border-b border-gray-200">
                            <tr>
                                <th class="p-4 font-medium">繧ｹ繧ｿ繝・ヵ蜷・/th>
                                <th class="p-4 font-medium text-right">蜃ｺ蜍､譌･謨ｰ</th>
                                <th class="p-4 font-medium text-right">蜉ｴ蜒肴凾髢・/th>
                                <th class="p-4 font-medium text-right">豕募ｮ夂岼螳・176h)縺ｨ縺ｮ蟾ｮ</th>
                                <th class="p-4 font-medium text-right">謗ｨ螳壽髪邨ｦ鬘・/th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100">
                            ${stats.staffStats.map(s => {
                                const limit = 176; // 譛磯俣豕募ｮ壼感蜒肴凾髢薙・逶ｮ螳・(40騾ｱ * 4.4騾ｱ)
                                const diff = s.hours - limit;
                                const isOver = diff > 0;
                                const diffText = isOver ? `+${diff.toFixed(1)}h` : 'OK';
                                const rowClass = isOver ? 'bg-red-50' : 'hover:bg-gray-50';
                                const textClass = isOver ? 'text-red-600 font-bold' : 'text-green-600';
                                const icon = isOver ? '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' : '<i class="fa-solid fa-check mr-1"></i>';

                                return `
                                <tr class="${rowClass}">
                                    <td class="p-4 font-bold text-gray-700">${this._sanitize(s.name)}</td>
                                    <td class="p-4 text-right">${s.days}譌･</td>
                                    <td class="p-4 text-right">${s.hours.toFixed(1)}h</td>
                                    <td class="p-4 text-right ${textClass}">${icon}${diffText}</td>
                                    <td class="p-4 text-right font-mono">ﾂ･${s.cost.toLocaleString()}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table></div>
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
        const dailyLabels = Array.from({length: daysInMonth}, (_, i) => `${i+1}譌･`);
        const staffMap = {};

        monthShifts.forEach(shift => {
            const staff = this.getStaff(shift.staff_id);
            if (!staff) return;
            const start = new Date(`${shift.date}T${shift.start_time}`);
            const end = new Date(`${shift.date}T${shift.end_time}`);
            if (end < start) end.setDate(end.getDate() + 1);
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

            if (!staffMap[staff.id]) staffMap[staff.id] = { name: staff.name, cost: 0, hours: 0, days: new Set() };
            staffMap[staff.id].cost += cost;
            staffMap[staff.id].hours += hours;
            staffMap[staff.id].days.add(shift.date);
        });

        this.state.staff.forEach(s => {
            if (s.salary_type === 'monthly') {
                totalCost += (s.monthly_salary || 0);
                if (!staffMap[s.id]) staffMap[s.id] = { name: s.name, cost: 0, hours: 0, days: new Set() };
                staffMap[s.id].cost += (s.monthly_salary || 0);
            }
        });

        const staffStats = Object.values(staffMap).map(s => ({ ...s, days: s.days.size })).sort((a, b) => b.cost - a.cost);
        return { totalCost, totalHours, daysCount: daysInMonth, activeStaffCount: Object.keys(staffMap).length, dailyCosts, dailyLabels, staffStats };
    },

    renderAnalyticsCharts(stats) {
        new Chart(document.getElementById('dailyCostChart'), {
            type: 'line',
            data: { labels: stats.dailyLabels, datasets: [{ label: '譌･谺｡莠ｺ莉ｶ雋ｻ', data: stats.dailyCosts, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.3 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
        });
        const topStaff = stats.staffStats.slice(0, 5);
        const otherCost = stats.staffStats.slice(5).reduce((sum, s) => sum + s.cost, 0);
        const labels = topStaff.map(s => s.name);
        const data = topStaff.map(s => s.cost);
        if (otherCost > 0) { labels.push('縺昴・莉・); data.push(otherCost); }

        new Chart(document.getElementById('staffShareChart'), {
            type: 'doughnut',
            data: { labels: labels, datasets: [{ data: data, backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#9ca3af'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
        });
    },

    // =================================================================
    // 5. 繧ｹ繧ｿ繝・ヵ邂｡逅・(Staff) - Admin Only
    // =================================================================
    renderStaffList(container) {
        if (!this.state.isAdmin) return;

        container.innerHTML = `
            <div class="max-w-6xl mx-auto space-y-6 pb-20">
                <div class="flex items-center justify-between">
                    <h2 class="text-2xl font-bold text-gray-800">繧ｹ繧ｿ繝・ヵ邂｡逅・/h2>
                    <button onclick="app.prepareStaffModal()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-plus mr-2"></i>譁ｰ隕冗匳骭ｲ
                    </button>
                </div>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead class="bg-gray-50 border-b border-gray-200 text-xs font-bold text-gray-500 uppercase tracking-wider">
                                <tr>
                                    <th class="p-4 whitespace-nowrap min-w-[200px]">蜷榊燕</th>
                                    <th class="p-4 whitespace-nowrap">蠖ｹ蜑ｲ</th>
                                    <th class="p-4 whitespace-nowrap">隧穂ｾ｡</th>
                                    <th class="p-4 whitespace-nowrap">邨ｦ荳主ｽ｢諷・/th>
                                    <th class="p-4 whitespace-nowrap">蜍､蜍吝宛邏・/th>
                                    <th class="p-4 text-right whitespace-nowrap">謫堺ｽ・/th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-gray-100">
                                ${this.state.staff.map(s => {
                                    // 螳牙・遲・ config.roles縺檎┌縺・ｴ蜷医・繝・ヵ繧ｩ繝ｫ繝医ｒ菴ｿ縺・
                                    const roleList = this.state.config.roles || this.state.defaultConfig.roles || [];
                                    const role = roleList.find(r => r.id === s.role) || { name: '譛ｪ險ｭ螳・, color: 'gray' };
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
                                                <div class="font-bold text-gray-800 text-sm">${this._sanitize(s.name)}</div>
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
                                            ? `<div class="flex items-center gap-2"><span class="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-500 font-bold">譎らｵｦ</span> <span class="font-bold">ﾂ･${s.hourly_wage ? s.hourly_wage.toLocaleString() : '0'}</span></div>` 
                                            : `<div class="flex items-center gap-2"><span class="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-500 font-bold">譛育ｵｦ</span> <span class="font-bold">ﾂ･${s.monthly_salary ? s.monthly_salary.toLocaleString() : '0'}</span></div>`}
                                    </td>
                                    <td class="p-4 whitespace-nowrap text-xs text-gray-500">
                                        <div class="flex items-center gap-3">
                                            <span class="flex items-center gap-1 bg-gray-50 px-2 py-1 rounded border border-gray-100" title="騾ｱ縺ｮ蜍､蜍呎律謨ｰ荳企剞"><i class="fa-regular fa-calendar-check text-gray-400"></i> 騾ｱ${s.max_days_week || '-'}譌･</span>
                                            <span class="flex items-center gap-1 bg-gray-50 px-2 py-1 rounded border border-gray-100" title="1譌･縺ｮ蜍､蜍呎凾髢謎ｸ企剞"><i class="fa-regular fa-clock text-gray-400"></i> 1譌･${s.max_hours_day || '-'}h</span>
                                        </div>
                                    </td>
                                    <td class="p-4 text-right whitespace-nowrap">
                                        <div class="flex justify-end gap-2">
                                            <button onclick="app.editStaff('${s.id}')" class="w-8 h-8 flex items-center justify-center text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-100" title="邱ｨ髮・>
                                                <i class="fa-solid fa-pen-to-square"></i>
                                            </button>
                                            <button onclick="app.deleteStaff('${s.id}')" class="w-8 h-8 flex items-center justify-center text-red-500 hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-100" title="蜑企勁">
                                                <i class="fa-solid fa-trash"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>`}).join('')}
                                ${this.state.staff.length === 0 ? '<tr><td colspan="5" class="p-12 text-center text-gray-400 flex flex-col items-center gap-2"><i class="fa-solid fa-users-slash text-3xl mb-2 text-gray-300"></i><span>繧ｹ繧ｿ繝・ヵ縺檎匳骭ｲ縺輔ｌ縺ｦ縺・∪縺帙ｓ</span></td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    },

    // =================================================================
    // 6. 險ｭ螳・(Settings) - Admin Only
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
                        <h2 class="text-2xl font-bold text-gray-800">蠎苓・險ｭ螳・/h2>
                        <p class="text-sm text-gray-500 mt-1">AI繧ｷ繝輔ヨ逕滓・縺ｫ菴ｿ繧上ｌ繧九Ν繝ｼ繝ｫ縺ｧ縺吶ゅ％縺薙ｒ豁｣縺励￥險ｭ螳壹☆繧九→AI縺梧怙驕ｩ縺ｪ繧ｷ繝輔ヨ繧剃ｽ懊ｌ縺ｾ縺吶・/p>
                    </div>
                    <button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-save mr-2"></i>險ｭ螳壹ｒ菫晏ｭ・
                    </button>
                </div>

                <!-- 1. 蠖ｹ閨ｷ繝ｻ繝ｭ繝ｼ繝ｫ險ｭ螳・-->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-id-badge text-indigo-500"></i> 蠖ｹ閨ｷ繝ｻ繝ｭ繝ｼ繝ｫ險ｭ螳・/h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">繧ｹ繧ｿ繝・ヵ縺ｮ閧ｩ譖ｸ縺阪ｒ險ｭ螳壹＠縺ｾ縺吶・I縺ｯ縲勲anager縲阪ｒ邂｡逅・・√軍ookie縲阪ｒ譁ｰ莠ｺ縺ｨ縺励※閾ｪ蜍募愛螳壹＠縺ｾ縺吶・/p>
                        <button onclick="app.addRole()" class="text-xs bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-bold hover:bg-indigo-200 transition">
                            <i class="fa-solid fa-plus mr-1"></i>蠖ｹ閨ｷ霑ｽ蜉
                        </button>
                    </div>
                    <div class="p-6">
                        <div class="overflow-x-auto">
                            <table class="w-full text-left">
                                <thead class="bg-gray-50 text-xs text-gray-500 uppercase font-bold">
                                    <tr>
                                        <th class="p-3 rounded-l-lg">蠖ｹ閨ｷ蜷・/th>
                                        <th class="p-3">隴伜挨ID</th>
                                        <th class="p-3">繝舌ャ繧ｸ繧ｫ繝ｩ繝ｼ</th>
                                        <th class="p-3 text-right rounded-r-lg">謫堺ｽ・/th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="rolesBody">
                                    ${roles.map((role, index) => `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-2">
                                                <input type="text" class="setting-role-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${role.name}" placeholder="蠖ｹ閨ｷ蜷・>
                                            </td>
                                            <td class="p-2">
                                                <input type="text" class="setting-role-id w-full border-gray-300 rounded px-2 py-1.5 text-sm bg-gray-50" value="${role.id}" readonly title="ID縺ｯ螟画峩縺ｧ縺阪∪縺帙ｓ">
                                            </td>
                                            <td class="p-2">
                                                <select class="setting-role-color w-full border-gray-300 rounded px-2 py-1.5 text-sm">
                                                    <option value="purple" ${role.color==='purple'?'selected':''}>邏ｫ (Manager)</option>
                                                    <option value="blue" ${role.color==='blue'?'selected':''}>髱・(Leader)</option>
                                                    <option value="green" ${role.color==='green'?'selected':''}>邱・(Staff)</option>
                                                    <option value="yellow" ${role.color==='yellow'?'selected':''}>鮟・(Rookie)</option>
                                                    <option value="red" ${role.color==='red'?'selected':''}>襍､ (Admin)</option>
                                                    <option value="gray" ${role.color==='gray'?'selected':''}>轣ｰ (Other)</option>
                                                </select>
                                            </td>
                                            <td class="p-2 text-right">
                                                <button onclick="app.deleteRole(${index})" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition" ${role.id==='manager'||role.id==='staff'?'disabled title="蝓ｺ譛ｬ蠖ｹ閨ｷ縺ｯ蜑企勁縺ｧ縺阪∪縺帙ｓ" style="opacity:0.3"':''}>
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-xs text-gray-400 mt-3">窶ｻ ID縺ｯ繧ｷ繧ｹ繝・Β蜀・Κ縺ｧ菴ｿ逕ｨ縺吶ｋ縺溘ａ螟画峩縺ｧ縺阪∪縺帙ｓ縲よ眠隕剰ｿｽ蜉譎ゅ・縺ｿ閾ｪ蜍慕函謌舌＆繧後∪縺吶・/p>
                    </div>
                </div>

                <!-- 2. 蝟ｶ讌ｭ譎る俣繝ｻ螳壻ｼ第律 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-regular fa-clock text-blue-500"></i> 蝟ｶ讌ｭ譎る俣 & 螳壻ｼ第律</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">AI縺ｯ縺薙・譎る俣蟶ｯ縺ｮ荳ｭ縺ｧ縺縺代す繝輔ヨ繧堤函謌舌＠縺ｾ縺吶ょｮ壻ｼ第律縺ｫ縺ｯ繧ｷ繝輔ヨ繧貞・繧後∪縺帙ｓ縲・/p>
                    </div>
                    <div class="p-6 space-y-8">
                        <!-- 蝟ｶ讌ｭ譎る俣 -->
                        <div class="space-y-4">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider">蝟ｶ讌ｭ譎る俣險ｭ螳・/h4>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-gray-50 pb-4">
                                <div class="md:col-span-3 font-bold text-gray-700">蟷ｳ譌･ (譛・驥・</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.weekday?.start || '09:00', 'time_weekday_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">・・/span>
                                    ${this.get15MinTimeSelect(times.weekday?.end || '22:00', 'time_weekday_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-gray-50 pb-4">
                                <div class="md:col-span-3 font-bold text-blue-600">蝨滓屆譌･</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.weekend?.start || '10:00', 'time_weekend_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">・・/span>
                                    ${this.get15MinTimeSelect(times.weekend?.end || '20:00', 'time_weekend_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                                <div class="md:col-span-3 font-bold text-red-600">譌･逾晄律</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.holiday?.start || '10:00', 'time_holiday_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">・・/span>
                                    ${this.get15MinTimeSelect(times.holiday?.end || '20:00', 'time_holiday_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                        </div>

                        <!-- 螳壻ｼ第律 -->
                        <div class="pt-4 border-t border-gray-100">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">螳壻ｼ第律險ｭ螳・/h4>
                            <div class="flex flex-wrap gap-4 mb-4">
                                ${['譌･', '譛・, '轣ｫ', '豌ｴ', '譛ｨ', '驥・, '蝨・].map((day, i) => `
                                    <label class="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50 border border-transparent hover:border-gray-200 transition">
                                        <input type="checkbox" name="setting_closed_days" value="${i}" class="w-5 h-5 text-red-500 rounded focus:ring-red-500 border-gray-300" ${closedDays.map(Number).includes(i) ? 'checked' : ''}>
                                        <span class="font-bold ${i===0?'text-red-500':i===6?'text-blue-500':'text-gray-700'}">${day}譖懈律</span>
                                    </label>
                                `).join('')}
                            </div>
                            
                            <!-- 閾ｨ譎ゆｼ第･ｭ -->
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">閾ｨ譎ゆｼ第･ｭ險ｭ螳・/h4>
                            <div class="flex items-center gap-3 mb-3">
                                <input type="date" id="newSpecialHoliday" class="border-gray-300 rounded-lg px-3 py-1.5 text-sm">
                                <button onclick="app.addSpecialHoliday()" class="bg-red-50 text-red-600 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-red-100 transition">霑ｽ蜉</button>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                ${specialHolidays.map((date, idx) => `
                                    <div class="bg-red-50 border border-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2">
                                        ${date} <button onclick="app.removeSpecialHoliday(${idx})" class="hover:text-red-900"><i class="fa-solid fa-times"></i></button>
                                    </div>
                                `).join('')}
                                ${specialHolidays.length === 0 ? '<span class="text-xs text-gray-400">險ｭ螳壹↑縺・/span>' : ''}
                            </div>
                            
                            <!-- 迚ｹ螳壽律縺ｮ蝟ｶ讌ｭ譎る俣・育洒邵ｮ蝟ｶ讌ｭ縺ｪ縺ｩ・・-->
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mt-4 mb-3">迚ｹ螳壽律縺ｮ蝟ｶ讌ｭ譎る俣螟画峩 (遏ｭ邵ｮ蝟ｶ讌ｭ縺ｪ縺ｩ)</h4>
                            <div class="space-y-3" id="specialDaysContainer">
                                <div class="flex items-center gap-2 flex-wrap bg-yellow-50 p-2 rounded-lg border border-yellow-100">
                                    <input type="date" id="newSpecialDayDate" class="border-gray-300 rounded px-2 py-1 text-sm">
                                    <div class="w-24">${this.get15MinTimeSelect('', 'newSpecialDayStart', 'border-gray-300 rounded px-2 py-1 text-sm w-full')}</div>
                                    <span class="text-gray-400 text-xs">・・/span>
                                    <div class="w-24">${this.get15MinTimeSelect('', 'newSpecialDayEnd', 'border-gray-300 rounded px-2 py-1 text-sm w-full')}</div>
                                    <input type="text" id="newSpecialDayNote" class="border-gray-300 rounded px-2 py-1 text-sm w-24" placeholder="繝｡繝｢ (萓・ 遏ｭ邵ｮ)">
                                    <button onclick="app.addSpecialDay()" class="bg-yellow-100 text-yellow-700 px-3 py-1 rounded text-xs font-bold hover:bg-yellow-200 transition">霑ｽ蜉</button>
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
                                    ${Object.keys(specialDays).length === 0 ? '<p class="text-xs text-gray-400 pl-2">險ｭ螳壹↑縺・/p>' : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 3. 繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ險ｭ螳・-->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-layer-group text-purple-500"></i> 繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ (譌ｩ逡ｪ/驕・分縺ｪ縺ｩ)</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">AI縺檎ｵ・∩蜷医ｏ縺帙ｋ繧ｷ繝輔ヨ縺ｮ縲悟梛縲阪〒縺吶ゆｾ具ｼ壽掠逡ｪ9-14譎ゅ・≦逡ｪ17-22譎ゅ↑縺ｩ縲・/p>
                        <button onclick="app.addShiftPattern()" class="text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg font-bold hover:bg-purple-200 transition">
                            <i class="fa-solid fa-plus mr-1"></i>霑ｽ蜉
                        </button>
                    </div>
                    <div class="p-6">
                        <div class="overflow-x-auto">
                            <table class="w-full text-left">
                                <thead class="bg-gray-50 text-xs text-gray-500 uppercase font-bold">
                                    <tr>
                                        <th class="p-3 rounded-l-lg">繝代ち繝ｼ繝ｳ蜷・/th>
                                        <th class="p-3">髢句ｧ区凾髢・/th>
                                        <th class="p-3">邨ゆｺ・凾髢・/th>
                                        <th class="p-3 text-right rounded-r-lg">謫堺ｽ・/th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="shiftPatternsBody">
                                    ${customShifts.map((shift, index) => `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-2">
                                                <input type="text" class="setting-shift-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${shift.name}" placeholder="萓・ 譌ｩ逡ｪ">
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
                                    ${customShifts.length === 0 ? '<tr><td colspan="4" class="p-4 text-center text-gray-400 text-sm">繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ縺檎匳骭ｲ縺輔ｌ縺ｦ縺・∪縺帙ｓ縲ゅ瑚ｿｽ蜉縲阪・繧ｿ繝ｳ縺ｾ縺溘・繝励Μ繧ｻ繝・ヨ縺九ｉ逋ｻ骭ｲ縺励※縺上□縺輔＞縲・/td></tr>' : ''}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-xs text-gray-400 mt-3">庁 縺薙％縺ｧ逋ｻ骭ｲ縺励◆繝代ち繝ｼ繝ｳ縺ｮ荳ｭ縺九ｉAI縺梧怙驕ｩ縺ｪ邨・∩蜷医ｏ縺帙ｒ驕ｸ縺ｳ縺ｾ縺吶ゅヱ繧ｿ繝ｼ繝ｳ縺悟､壹＞縺ｻ縺ｩAI縺ｮ驕ｸ謚櫁い縺悟ｺ・′繧翫∪縺吶・/p>
                        <div class="mt-4 pt-4 border-t border-gray-100">
                            <p class="text-xs font-bold text-gray-500 mb-2"><i class="fa-solid fa-wand-magic-sparkles text-purple-400 mr-1"></i>繝励Μ繧ｻ繝・ヨ縺九ｉ荳諡ｬ霑ｽ蜉</p>
                            <div class="flex flex-wrap gap-2">
                                <button onclick="app.applyShiftPreset('restaurant')" class="text-xs bg-orange-50 text-orange-600 border border-orange-200 px-3 py-1.5 rounded-lg font-bold hover:bg-orange-100 transition">
                                    <i class="fa-solid fa-utensils mr-1"></i>鬟ｲ鬟溷ｺ怜髄縺・
                                </button>
                                <button onclick="app.applyShiftPreset('office')" class="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-3 py-1.5 rounded-lg font-bold hover:bg-blue-100 transition">
                                    <i class="fa-solid fa-building mr-1"></i>繧ｪ繝輔ぅ繧ｹ蜷代￠
                                </button>
                                <button onclick="app.applyShiftPreset('retail')" class="text-xs bg-green-50 text-green-600 border border-green-200 px-3 py-1.5 rounded-lg font-bold hover:bg-green-100 transition">
                                    <i class="fa-solid fa-store mr-1"></i>蟆丞｣ｲ蠎怜髄縺・
                                </button>
                                <button onclick="app.applyShiftPreset('medical')" class="text-xs bg-pink-50 text-pink-600 border border-pink-200 px-3 py-1.5 rounded-lg font-bold hover:bg-pink-100 transition">
                                    <i class="fa-solid fa-hospital mr-1"></i>蛹ｻ逋ゅ・莉玖ｭｷ蜷代￠
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 4. 莠ｺ蜩｡驟咲ｽｮ繝ｫ繝ｼ繝ｫ -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-users text-green-500"></i> 莠ｺ蜩｡驟咲ｽｮ隕∽ｻｶ</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">縲梧怙菴惹ｽ穂ｺｺ縺・ｌ縺ｰ縺雁ｺ励′蝗槭ｋ縺九阪ｒ險ｭ螳壹＠縺ｾ縺吶・I縺ｯ縺薙・莠ｺ謨ｰ繧貞ｿ・★遒ｺ菫昴＠繧医≧縺ｨ縺励∪縺吶・/p>
                    </div>
                    <div class="p-6">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-6">
                            <div>
                                <h4 class="text-sm font-bold text-gray-700 mb-4 border-b border-gray-100 pb-2">邂｡逅・・ｦ∽ｻｶ</h4>
                                <div>
                                    <label class="block text-xs font-bold text-gray-500 mb-1">譛菴守ｮ｡逅・・焚 (蠎鈴聞/繝ｪ繝ｼ繝繝ｼ)</label>
                                    <input type="number" id="req_min_manager" class="w-full border-gray-300 rounded-lg px-3 py-2" value="${reqs.min_manager || 1}">
                                    <p class="text-xs text-gray-400 mt-1">蝟ｶ讌ｭ荳ｭ縺ｫ蟶ｸ縺ｫ譛菴・蜷阪・邂｡逅・・蠎鈴聞/繝ｪ繝ｼ繝繝ｼ)縺後＞繧九ｈ縺・↓蛻ｶ蠕｡縺励∪縺・/p>
                                </div>
                            </div>
                            <div>
                                <h4 class="text-sm font-bold text-gray-700 mb-4 border-b border-gray-100 pb-2">繧ｹ繧ｿ繝・ヵ邱乗焚隕∽ｻｶ</h4>
                                <div class="space-y-4">
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-gray-600">蟷ｳ譌･</label>
                                        <input type="number" id="req_min_weekday" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekday || reqs.min_total || 2}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-blue-600">蝨滓律</label>
                                        <input type="number" id="req_min_weekend" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekend || reqs.min_total || 3}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-red-600">逾晄律</label>
                                        <input type="number" id="req_min_holiday" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_holiday || reqs.min_total || 3}">
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 譎る俣蟶ｯ蛻･莠ｺ蜩｡驟咲ｽｮ -->
                        <div class="border-t border-gray-100 pt-4">
                            <div class="flex justify-between items-center mb-3">
                                <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider">譎る俣蟶ｯ蛻･繝ｻ譖懈律蛻･ 莠ｺ蜩｡蠅怜ｼｷ</h4>
                                <button onclick="app.addTimeStaffReq()" class="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-lg font-bold hover:bg-green-200 transition">
                                    <i class="fa-solid fa-plus mr-1"></i>繝ｫ繝ｼ繝ｫ霑ｽ蜉
                                </button>
                            </div>
                            <div class="overflow-x-auto">
                                <table class="w-full text-left text-sm">
                                    <thead class="bg-gray-50 text-xs text-gray-500">
                                        <tr>
                                            <th class="p-2 w-1/3">譖懈律</th>
                                            <th class="p-2">髢句ｧ・/th>
                                            <th class="p-2">邨ゆｺ・/th>
                                            <th class="p-2">莠ｺ謨ｰ</th>
                                            <th class="p-2 text-right"></th>
                                        </tr>
                                    </thead>
                                    <tbody id="timeStaffReqBody" class="divide-y divide-gray-50">
                                        ${timeStaffReq.map((rule, idx) => {
                                            const daysStr = ['譌･','譛・,'轣ｫ','豌ｴ','譛ｨ','驥・,'蝨・];
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
                                ${timeStaffReq.length === 0 ? '<p class="text-xs text-gray-400 text-center py-4">迚ｹ螳壹・譎る俣蟶ｯ・井ｾ具ｼ壹Λ繝ｳ繝√ち繧､繝・峨↓蠢・ｦ√↑莠ｺ謨ｰ繧定ｨｭ螳壹〒縺阪∪縺・/p>' : ''}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 5. 繧ｷ繧ｹ繝・Β險ｭ螳・-->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-gears text-gray-500"></i> 繧ｷ繧ｹ繝・Β險ｭ螳・/h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">譎らｵｦ縺ｮ蛻晄悄蛟､縲∫ｮ｡逅・・ヱ繧ｹ繝ｯ繝ｼ繝峨∽ｼ第・繝ｫ繝ｼ繝ｫ縺ｪ縺ｩ縺ｮ蝓ｺ譛ｬ險ｭ螳壹〒縺吶・/p>
                    </div>
                    <div class="p-6 space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">繝・ヵ繧ｩ繝ｫ繝域凾邨ｦ (蜀・</label>
                                <input type="number" id="settingHourlyWage" class="w-full border border-gray-300 rounded-lg px-3 py-2" value="${config.hourly_wage_default || 1100}">
                            </div>
                            
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">邂｡逅・・ヱ繧ｹ繝ｯ繝ｼ繝・/label>
                                <input type="text" id="settingPassword" class="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono tracking-wider" value="${config.admin_password || '0000'}">
                            </div>
                        </div>
                        
                        <div class="border-t border-gray-100 pt-4">
                            <button onclick="app.openModal('changePasswordModal')" class="flex items-center gap-2 text-sm font-bold text-amber-600 bg-amber-50 border border-amber-200 px-4 py-2.5 rounded-lg hover:bg-amber-100 transition">
                                <i class="fa-solid fa-key"></i> 蠎苓・繝ｭ繧ｰ繧､繝ｳ繝代せ繝ｯ繝ｼ繝峨ｒ螟画峩
                            </button>
                            <p class="text-xs text-gray-400 mt-1">窶ｻ 蠎苓・繝ｭ繧ｰ繧､繝ｳ譎ゅ↓菴ｿ逕ｨ縺吶ｋ繝代せ繝ｯ繝ｼ繝峨ｒ螟画峩縺ｧ縺阪∪縺・/p>
                        </div>

                        <!-- AI險ｭ螳・(驕句霧邂｡逅・・縺溘ａ髱櫁｡ｨ遉ｺ) -->
                        
                        <!-- 莨第・譎る俣繝ｫ繝ｼ繝ｫ -->
                        <div class="border-t border-gray-100 pt-4">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">莨第・譎る俣繝ｫ繝ｼ繝ｫ</h4>
                            <div class="space-y-3" id="breakRulesContainer">
                                ${breakRules.map((rule, idx) => `
                                    <div class="flex items-center gap-3">
                                        <div class="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                                            <input type="number" class="setting-break-hours w-16 border-gray-300 rounded px-2 py-1 text-sm text-center font-bold" value="${rule.min_hours}">
                                            <span class="text-xs text-gray-500">譎る俣雜・〒</span>
                                        </div>
                                        <i class="fa-solid fa-arrow-right text-gray-300 text-xs"></i>
                                        <div class="flex items-center gap-2 bg-blue-50 px-3 py-2 rounded-lg border border-blue-100">
                                            <input type="number" class="setting-break-minutes w-16 border-blue-200 rounded px-2 py-1 text-sm text-center font-bold text-blue-700" value="${rule.break_minutes}">
                                            <span class="text-xs text-blue-500">蛻・ｼ第・</span>
                                        </div>
                                        <button onclick="app.removeBreakRule(${idx})" class="text-gray-400 hover:text-red-500 ml-2"><i class="fa-solid fa-times"></i></button>
                                    </div>
                                `).join('')}
                            </div>
                            <button onclick="app.addBreakRule()" class="mt-3 text-xs flex items-center gap-1 text-blue-600 font-bold hover:text-blue-800"><i class="fa-solid fa-plus-circle"></i> 繝ｫ繝ｼ繝ｫ繧定ｿｽ蜉</button>
                        </div>
                    </div>
                </div>

                <!-- 6. 驕狗畑繝ｫ繝ｼ繝ｫ (縺雁ｺ励・繝ｫ繝ｼ繝ｫ) -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-clipboard-list text-orange-500"></i> 驕狗畑繝ｫ繝ｼ繝ｫ (繧ｹ繧ｿ繝・ヵ蜷代￠陦ｨ遉ｺ)</h3>
                    </div>
                    <div class="p-6">
                        <label class="block text-xs font-bold text-gray-500 mb-2">縺雁ｺ励・繝ｫ繝ｼ繝ｫ繝ｻ騾｣邨｡莠矩・/label>
                        <textarea id="settingShopRules" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm min-h-[60px] sm:min-h-[120px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="繧ｷ繝輔ヨ謠仙・譛滄剞繧・ｳｨ諢丈ｺ矩・↑縺ｩ繧貞・蜉帙＠縺ｦ縺上□縺輔＞...">${shopRulesText}</textarea>
                        <p class="text-xs text-gray-400 mt-2">窶ｻ 縺薙％縺ｫ蜈･蜉帙＠縺溷・螳ｹ縺ｯ縲√せ繧ｿ繝・ヵ逕ｻ髱｢縺ｮ縲後♀蠎励・繝ｫ繝ｼ繝ｫ縲阪↓陦ｨ遉ｺ縺輔ｌ縺ｾ縺吶・/p>
                    </div>
                </div>
                
                <!-- 7. 繧｢繧ｫ繧ｦ繝ｳ繝域ュ蝣ｱ -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-user-gear text-indigo-500"></i> 繧｢繧ｫ繧ｦ繝ｳ繝域ュ蝣ｱ</h3>
                    </div>
                    <div class="p-6 space-y-4">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 mb-1">螂醍ｴИD</label>
                            <p class="font-mono text-lg font-bold text-gray-800">${config.contract_id || '-'}</p>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-500 mb-1">逋ｻ骭ｲ繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ</label>
                            <div class="flex gap-2">
                                <input type="email" id="settingEmail" value="${config.customer_email || ''}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧貞・蜉・>
                                <button onclick="app.updateEmail()" class="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 transition whitespace-nowrap">
                                    <i class="fa-solid fa-save mr-1"></i>螟画峩
                                </button>
                            </div>
                            <p class="text-xs text-gray-400 mt-1">譯亥・繝｡繝ｼ繝ｫ縺ｮ騾∽ｿ｡蜈医い繝峨Ξ繧ｹ縺ｧ縺・/p>
                        </div>
                    </div>
                </div>

                <!-- 8. 繝励Λ繝ｳ邂｡逅・-->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-credit-card text-green-500"></i> 繝励Λ繝ｳ邂｡逅・/h3>
                    </div>
                    <div class="p-6 space-y-5" id="subscriptionSection">
                        <!-- 迴ｾ蝨ｨ縺ｮ繝励Λ繝ｳ陦ｨ遉ｺ -->
                        <div class="bg-gradient-to-r ${
                            (config.stripe_plan === 'premium') ? 'from-purple-500 to-indigo-600' :
                            (config.stripe_plan === 'pro') ? 'from-green-500 to-emerald-600' :
                            'from-blue-500 to-indigo-600'
                        } rounded-xl p-5 text-white">
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="text-white/70 text-xs font-medium">迴ｾ蝨ｨ縺泌茜逕ｨ荳ｭ縺ｮ繝励Λ繝ｳ</p>
                                    <p class="text-3xl font-extrabold mt-1">${{standard:'Standard', pro:'Pro', premium:'Premium'}[config.stripe_plan] || 'Standard'}</p>
                                    <p class="text-white/80 text-sm mt-1">${{standard:'2,980蜀・譛・- 繧ｹ繧ｿ繝・ヵ10蜷阪∪縺ｧ', pro:'4,480蜀・譛・- 繧ｹ繧ｿ繝・ヵ50蜷阪∪縺ｧ', premium:'9,980蜀・譛・- 繧ｹ繧ｿ繝・ヵ辟｡蛻ｶ髯・}[config.stripe_plan] || '2,980蜀・譛・- 繧ｹ繧ｿ繝・ヵ10蜷阪∪縺ｧ'}</p>
                                </div>
                                <div class="text-right">
                                    <span class="inline-flex items-center gap-1.5 px-3 py-1 bg-white/20 rounded-full text-sm font-bold backdrop-blur-sm">
                                        <i class="fa-solid fa-circle-check text-xs"></i> 譛牙柑
                                    </span>
                                </div>
                            </div>
                        </div>

                        <!-- 繝励Λ繝ｳ螟画峩繧ｫ繝ｼ繝・-->
                        <div>
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">繝励Λ繝ｳ螟画峩</h4>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                                ${[
                                    { key: 'standard', name: 'Standard', price: '2,980', staffs: '10蜷・, color: 'blue', features: ['繧ｹ繧ｿ繝・ヵ10蜷阪∪縺ｧ', 'AI閾ｪ蜍輔す繝輔ヨ逕滓・', 'AI蜉ｴ蝓ｺ豕輔メ繧ｧ繝・け', '繧ｷ繝輔ヨ邂｡逅・・讖溯・'] },
                                    { key: 'pro', name: 'Pro', price: '4,480', staffs: '50蜷・, color: 'green', badge: '莠ｺ豌・, features: ['繧ｹ繧ｿ繝・ヵ50蜷阪∪縺ｧ', '蜈ｨAI讖溯・', '蜆ｪ蜈医し繝昴・繝・, '蛻・梵繝ｬ繝昴・繝・] },
                                    { key: 'premium', name: 'Premium', price: '9,980', staffs: '辟｡蛻ｶ髯・, color: 'purple', features: ['繧ｹ繧ｿ繝・ヵ辟｡蛻ｶ髯・, '蜈ｨAI讖溯・', '隍・焚蠎苓・蟇ｾ蠢・, '蟆ょｱ槭し繝昴・繝・] },
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

                                    const badgeHtml = p.badge && !isCurrent ? '<div class="text-[10px] font-bold text-green-700 bg-green-200 rounded-full px-2 py-0.5 inline-block mb-1">莠ｺ豌・/div>' : '';
                                    const currentBadge = isCurrent ? '<div class="text-[10px] font-bold text-white bg-gray-800 rounded-full px-2 py-0.5 inline-block mb-1">迴ｾ蝨ｨ縺ｮ繝励Λ繝ｳ</div>' : '';

                                    let btnHtml = '';
                                    if (isCurrent) {
                                        btnHtml = '<p class="mt-3 text-xs font-bold text-gray-500 text-center py-1.5"><i class="fa-solid fa-circle-check mr-1"></i>縺泌茜逕ｨ荳ｭ</p>';
                                    } else if (isUpgrade) {
                                        const btnColor = p.color === 'green' ? 'bg-green-600 hover:bg-green-700' : 'bg-purple-600 hover:bg-purple-700';
                                        btnHtml = '<button onclick="app.startCheckout(&#39;'+p.key+'&#39;)" class="mt-3 w-full py-2 '+btnColor+' text-white rounded-lg text-xs font-bold transition"><i class="fa-solid fa-arrow-up mr-1"></i>繧｢繝・・繧ｰ繝ｬ繝ｼ繝・/button>';
                                    } else {
                                        btnHtml = '<button onclick="app.startCheckout(&#39;'+p.key+'&#39;)" class="mt-3 w-full py-2 bg-gray-200 text-gray-600 rounded-lg text-xs font-bold hover:bg-gray-300 transition"><i class="fa-solid fa-arrow-down mr-1"></i>繝繧ｦ繝ｳ繧ｰ繝ｬ繝ｼ繝・/button>';
                                    }

                                    const checkColor = p.color === 'blue' ? 'text-blue-500' : p.color === 'green' ? 'text-green-500' : 'text-purple-500';
                                    const nameColor = p.color === 'blue' ? 'text-blue-600' : p.color === 'green' ? 'text-green-600' : 'text-purple-600';

                                    return '<div class="p-4 rounded-xl border-2 '+borderClass+' transition-all duration-200 text-center flex flex-col hover:-translate-y-1 hover:shadow-xl">'
                                        + currentBadge + badgeHtml
                                        + '<p class="font-bold '+nameColor+' text-lg">'+p.name+'</p>'
                                        + '<p class="text-2xl font-extrabold text-gray-900 mt-1">'+p.price+'<span class="text-sm font-normal text-gray-400">蜀・譛・/span></p>'
                                        + '<p class="text-xs text-gray-500 mt-1">繧ｹ繧ｿ繝・ヵ'+p.staffs+'</p>'
                                        + '<ul class="text-xs text-gray-600 mt-3 space-y-1 text-left flex-1">'
                                        + p.features.map(f => '<li class="flex items-center gap-1.5"><i class="fa-solid fa-check '+checkColor+' text-[10px]"></i>'+f+'</li>').join('')
                                        + '</ul>'
                                        + '<div class="mt-auto pt-3">'+btnHtml+'</div>'
                                        + '</div>';
                                }).join('')}
                            </div>
                        </div>

                        <!-- Stripe繝昴・繧ｿ繝ｫ繝ｪ繝ｳ繧ｯ -->
                        ${config.stripe_subscription_id ? `
                        <div class="border-t border-gray-100 pt-4 flex justify-between items-center">
                            <p class="text-xs text-gray-400">隲区ｱよ嶌繝ｻ謾ｯ謇輔＞譁ｹ豕輔・螟画峩繝ｻ隗｣邏・・Stripe繝昴・繧ｿ繝ｫ縺九ｉ</p>
                            <button onclick="app.openStripePortal()" class="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-xs font-bold hover:bg-gray-200 transition">
                                <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i> 隲区ｱらｮ｡逅・・繝ｼ繧ｿ繝ｫ
                            </button>
                        </div>
                        ` : ''}
                    </div>
                </div>

                <!-- 荳矩Κ菫晏ｭ倥・繧ｿ繝ｳ -->
                <div class="flex items-center justify-between bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <p class="text-sm text-gray-500"><i class="fa-solid fa-info-circle text-blue-400 mr-1"></i>荳企Κ縺ｮ螟画峩繧貞性繧√√☆縺ｹ縺ｦ縺ｮ險ｭ螳壹ｒ荳諡ｬ菫晏ｭ倥＠縺ｾ縺・/p>
                    <button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-8 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-save mr-2"></i>險ｭ螳壹ｒ菫晏ｭ・
                    </button>
                </div>

                <!-- 繝・・繧ｿ繝ｪ繧ｻ繝・ヨ -->
                <div class="text-right">
                    <button onclick="if(confirm('縲占ｭｦ蜻翫大・縺ｦ縺ｮ繝・・繧ｿ繧貞炎髯､縺励※蛻晄悄蛹悶＠縺ｾ縺吶°・・)) { localStorage.clear(); location.reload(); }" class="text-red-500 text-xs hover:text-red-700 font-bold opacity-60 hover:opacity-100 transition">
                        <i class="fa-solid fa-trash mr-1"></i>蜈ｨ繝・・繧ｿ繧偵Μ繧ｻ繝・ヨ
                    </button>
                </div>
            </div>
        `;
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
        // 繝ｦ繝九・繧ｯID逕滓・
        const newId = 'role_' + Math.random().toString(36).substr(2, 5);
        this.state.config.roles.push({ id: newId, name: '譁ｰ隕丞ｽｹ閨ｷ', color: 'gray', level: 1 });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    deleteRole(index) {
        this.state.config = this.readSettingsFromDOM();
        const role = this.state.config.roles[index];
        if(role.id === 'manager' || role.id === 'staff') {
            this.showToast('縺薙・蠖ｹ閨ｷ縺ｯ蜑企勁縺ｧ縺阪∪縺帙ｓ', 'error');
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
        this.state.config = this.readSettingsFromDOM(); // 迴ｾ蝨ｨ縺ｮ蜈･蜉帙ｒ菫晏ｭ・
        if(this.state.config.special_holidays) {
            this.state.config.special_holidays.splice(index, 1);
        }
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addSpecialDay() {
        const date = (document.getElementById('newSpecialDayDate')?.value || '');
        const start = (document.getElementById('newSpecialDayStart')?.value || '');
        const end = (document.getElementById('newSpecialDayEnd')?.value || '');
        const note = (document.getElementById('newSpecialDayNote')?.value || '');

        if(!date || !start || !end) return;

        this.state.config = this.readSettingsFromDOM(); // 迴ｾ蝨ｨ縺ｮ蜈･蜉帙ｒ菫晏ｭ・
        if(!this.state.config.special_days) this.state.config.special_days = {};
        
        this.state.config.special_days[date] = { start, end, note };
        this.renderSettings(document.getElementById('viewContainer'));
    },

    removeSpecialDay(date) {
        this.state.config = this.readSettingsFromDOM(); // 迴ｾ蝨ｨ縺ｮ蜈･蜉帙ｒ菫晏ｭ・
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
        // 迴ｾ蝨ｨ縺ｮ蜈･蜉帙ｒ荳譎ゆｿ晏ｭ・
        this.state.config = this.readSettingsFromDOM();
        // 譁ｰ縺励＞遨ｺ陦後ｒ霑ｽ蜉
        if(!this.state.config.custom_shifts) this.state.config.custom_shifts = [];
        this.state.config.custom_shifts.push({ name: '', start: '09:00', end: '18:00' });
        // 蜀肴緒逕ｻ
        this.renderSettings(document.getElementById('viewContainer'));
    },

    deleteShiftPattern(index) {
        // 迴ｾ蝨ｨ縺ｮ蜈･蜉帙ｒ荳譎ゆｿ晏ｭ・
        this.state.config = this.readSettingsFromDOM();
        // 蜑企勁
        this.state.config.custom_shifts.splice(index, 1);
        // 蜀肴緒逕ｻ
        this.renderSettings(document.getElementById('viewContainer'));
    },

    readSettingsFromDOM() {
        const config = { ...this.state.config }; // 譌｢蟄倥・險ｭ螳壹ｒ繧ｳ繝斐・

        // 蝓ｺ譛ｬ險ｭ螳・
        config.hourly_wage_default = Number(document.getElementById('settingHourlyWage')?.value || 1100);
        config.admin_password = document.getElementById('settingPassword')?.value || config.admin_password;
        config.shop_rules_text = document.getElementById('settingShopRules')?.value || '';

        // 蝟ｶ讌ｭ譎る俣
        const getVal = (id) => document.getElementById(id)?.value;
        config.opening_times = {
            weekday: { start: getVal('time_weekday_start') || '09:00', end: getVal('time_weekday_end') || '22:00' },
            weekend: { start: getVal('time_weekend_start') || '10:00', end: getVal('time_weekend_end') || '20:00' },
            holiday: { start: getVal('time_holiday_start') || '10:00', end: getVal('time_holiday_end') || '20:00' }
        };
        // 譌ｧ莠呈鋤
        config.opening_time = config.opening_times.weekday.start;
        config.closing_time = config.opening_times.weekday.end;

        // 螳壻ｼ第律
        config.closed_days = Array.from(document.querySelectorAll('input[name="setting_closed_days"]:checked')).map(el => parseInt(el.value));

        // 蠖ｹ閨ｷ繝ｻ繝ｭ繝ｼ繝ｫ險ｭ螳・
        const roleNames = document.querySelectorAll('.setting-role-name');
        const roleIds = document.querySelectorAll('.setting-role-id');
        const roleColors = document.querySelectorAll('.setting-role-color');

        const existingRoles = this.state.config.roles || [];
        config.roles = [];
        roleNames.forEach((el, i) => {
            if (el.value) {
                const rId = roleIds[i].value;
                const prev = existingRoles.find(r => r.id === rId);
                config.roles.push({
                    id: rId,
                    name: el.value,
                    color: roleColors[i].value,
                    level: prev ? prev.level : 1
                });
            }
        });

        // 繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ
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

        // 莠ｺ蜩｡驟咲ｽｮ繝ｫ繝ｼ繝ｫ
        config.staff_req = {
            min_manager: Number(document.getElementById('req_min_manager')?.value || 1),
            min_weekday: Number(document.getElementById('req_min_weekday')?.value || 2),
            min_weekend: Number(document.getElementById('req_min_weekend')?.value || 3),
            min_holiday: Number(document.getElementById('req_min_holiday')?.value || 3)
        };

        // 莨第・繝ｫ繝ｼ繝ｫ
        const breakRules = [];
        const breakRuleDivs = document.querySelectorAll('#breakRulesContainer > div');
        breakRuleDivs.forEach(div => {
            const h = Number(div.querySelector('.setting-break-hours')?.value || 0);
            const m = Number(div.querySelector('.setting-break-minutes')?.value || 0);
            if (h > 0) breakRules.push({ min_hours: h, break_minutes: m });
        });
        breakRules.sort((a, b) => a.min_hours - b.min_hours);
        config.break_rules = breakRules.length > 0 ? breakRules : config.break_rules;

        // 譎る俣蟶ｯ蛻･繝ｫ繝ｼ繝ｫ
        config.time_staff_req = [];
        const timeReqRows = document.querySelectorAll('#timeStaffReqBody tr');
        timeReqRows.forEach((row, idx) => {
            const start = row.querySelector('.setting-time-req-start')?.value;
            const end = row.querySelector('.setting-time-req-end')?.value;
            const count = Number(row.querySelector('.setting-time-req-count')?.value || 0);

            const daysChecks = document.querySelectorAll(`.setting-time-req-day-${idx}:checked`);
            const days = Array.from(daysChecks).map(c => Number(c.value));

            if (days.length > 0 && start && end && count > 0) {
                config.time_staff_req.push({ days, start, end, count });
            }
        });

        return config;
    },

    async saveSettings() {
        const newConfig = this.readSettingsFromDOM();

        const configId = this.state.config.id;
        if (!configId) {
            this.showToast('險ｭ螳唔D縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲ょ・繝ｭ繧ｰ繧､繝ｳ縺励※縺上□縺輔＞縲・, 'error');
            return;
        }

        this.showLoading(true);
        try {
            // RPC邨檎罰縺ｧ螳牙・縺ｫ險ｭ螳壹ｒ譖ｴ譁ｰ (讖溷ｯ・ヵ繧｣繝ｼ繝ｫ繝峨・蛟句挨髢｢謨ｰ縺ｧ譖ｴ譁ｰ)
            const updateData = {
                opening_time: newConfig.opening_time,
                closing_time: newConfig.closing_time,
                hourly_wage_default: newConfig.hourly_wage_default,
                opening_times: newConfig.opening_times,
                closed_days: newConfig.closed_days,
                staff_req: newConfig.staff_req,
                roles: newConfig.roles,
                special_holidays: newConfig.special_holidays,
                special_days: newConfig.special_days,
                time_staff_req: newConfig.time_staff_req,
                calendar_notes: newConfig.calendar_notes || {},
                break_rules: newConfig.break_rules,
                shop_rules_text: newConfig.shop_rules_text,
                custom_shifts: newConfig.custom_shifts,
            };

            await API.rpc('update_config_safe', {
                p_config_id: configId,
                p_data: updateData
            });

            // 邂｡逅・・ヱ繧ｹ繝ｯ繝ｼ繝峨′螟画峩縺輔ｌ縺ｦ縺・◆繧峨《taff繝・・繝悶Ν縺ｮ邂｡逅・・い繧ｫ繧ｦ繝ｳ繝医ｂ譖ｴ譁ｰ
            if (newConfig.admin_password && newConfig.admin_password !== this.state.config.admin_password) {
                const adminStaff = this.state.staff.find(s => s.login_id === 'admin');
                if (adminStaff) {
                    try {
                        await API.rpc('update_staff_password', {
                            p_staff_id: adminStaff.id,
                            p_new_password: newConfig.admin_password
                        });
                        // config蛛ｴ縺ｮadmin_password繧よ峩譁ｰ・郁｡ｨ遉ｺ逕ｨ縺ｮ繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ・・
                        await API.rpc('update_config_safe', {
                            p_config_id: configId,
                            p_data: { admin_password: newConfig.admin_password }
                        });
                        // 繝代せ繝ｯ繝ｼ繝画峩譁ｰ螳御ｺ・ｼ医Ο繧ｰ逵∫払・・
                    } catch (pwErr) {
                        console.error('[Settings] Password update failed:', pwErr);
                        this.showToast('繝代せ繝ｯ繝ｼ繝画峩譁ｰ縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
                    }
                }
            }

            // State繧呈峩譁ｰ
            this.state.config = { ...this.state.config, ...newConfig };
            this.showToast('險ｭ螳壹ｒ菫晏ｭ倥＠縺ｾ縺励◆', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('菫晏ｭ倥お繝ｩ繝ｼ: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // --- 蜊ｰ蛻ｷ讖溯・ (螳悟・迚・v7繝ｻ蛻・牡繝ｬ繧､繧｢繧ｦ繝・& PDF蟇ｾ蠢・ ---
    // Fixed syntax error
    printShiftTable() {
        // 迴ｾ蝨ｨ縺ｮ陦ｨ遉ｺ繝｢繝ｼ繝峨→譛滄俣繧貞叙蠕・
        const period = this.state.shiftTablePeriod || 'month';
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        
        let allDays = [];
        
        // 1. 蜈ｨ譛滄俣縺ｮ譌･莉倥Μ繧ｹ繝育函謌・
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

        // 2. 譛滄俣蛻・牡 (A4讓ｪ縺ｫ蜿弱∪繧九ｈ縺・7譌･蛹ｺ蛻・ｊ 縺ｧ繝・・繝悶Ν繧堤函謌・
        const CHUNK_SIZE = 7; // 1騾ｱ髢薙★縺､
        const dayChunks = [];
        for (let i = 0; i < allDays.length; i += CHUNK_SIZE) {
            dayChunks.push(allDays.slice(i, i + CHUNK_SIZE));
        }

        // 3. 蜊ｰ蛻ｷ逕ｨ繧ｦ繧｣繝ｳ繝峨え菴懈・
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('繝昴ャ繝励い繝・・縺後ヶ繝ｭ繝・け縺輔ｌ縺ｾ縺励◆縲ゅ瑚ｨｱ蜿ｯ縲阪＠縺ｦ縺上□縺輔＞縲・);
            return;
        }

        // --- 繧ｳ繝ｳ繝・Φ繝・函謌宣未謨ｰ ---
        const generateTableHTML = (days, chunkIndex, totalChunks) => {
            // 譎る俣逶ｮ逶帙ｊ
            const timeScaleHtml = `
                <div style="display: flex; justify-content: space-between; font-size: 8px; color: #555; margin-top: 2px; border-top: 1px solid #ccc;">
                    <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
                </div>
            `;

            // 繝倥ャ繝繝ｼ逕滓・
            const headerCols = days.map(date => {
                const d = date.getDate();
                const m = date.getMonth() + 1;
                const w = ['譌･','譛・,'轣ｫ','豌ｴ','譛ｨ','驥・,'蝨・][date.getDay()];
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

            // 繝懊ョ繧｣逕滓・
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
                        
                        // 1譌･ = 1440蛻・
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
                                overflow: visible; /* 譁・ｭ励・縺ｿ蜃ｺ縺苓ｨｱ蜿ｯ */
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
                    
                    // 閭梧勹繧ｰ繝ｪ繝・ラ
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
                            ${this._sanitize(staff.name)}
                        </td>
                        ${cols}
                    </tr>
                `;
            }).join('');

            // 譛滄俣陦ｨ遉ｺ
            const startStr = `${days[0].getMonth()+1}/${days[0].getDate()}`;
            const endStr = `${days[days.length-1].getMonth()+1}/${days[days.length-1].getDate()}`;

            return `
                <div class="table-chunk" style="margin-bottom: 20px; page-break-after: always;">
                    <h3 style="margin: 0 0 10px 0; font-size: 16px; border-left: 5px solid #2563eb; padding-left: 10px;">
                        譛滄俣: ${startStr} 縲・${endStr}
                    </h3>
                    <table style="width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px;">
                        <thead>
                            <tr>
                                <th style="width: 140px; background-color: #e5e7eb; border: 1px solid #666; padding: 4px;">繧ｹ繧ｿ繝・ヵ</th>
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

        // 蜈ｨ繝√Ε繝ｳ繧ｯ縺ｮHTML邨仙粋
        const allTablesHtml = dayChunks.map((chunk, idx) => generateTableHTML(chunk, idx, dayChunks.length)).join('');

        const html = `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <title>繧ｷ繝輔ヨ陦ｨ蜊ｰ蛻ｷ</title>
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
                    <h2 style="margin-top:0;">蜜 蜊ｰ蛻ｷ繝励Ξ繝薙Η繝ｼ (蛻・牡繝ｬ繧､繧｢繧ｦ繝育沿)</h2>
                    <p style="font-size: 14px; line-height: 1.6;">
                        隕冶ｪ肴ｧ繧堤｢ｺ菫昴☆繧九◆繧√・strong>7譌･縺斐→縺ｫ蛻・牡縺励※陦ｨ遉ｺ</strong>縺励※縺・∪縺吶・br>
                        縲悟魂蛻ｷ縲阪・繧ｿ繝ｳ繧呈款縺励・∽ｿ｡蜈医〒<strong>縲訓DF縺ｫ菫晏ｭ倥・/strong>繧帝∈謚槭☆繧九→縲∝・譛滄俣繧貞性繧PDF繝輔ぃ繧､繝ｫ縺御ｽ懈・縺ｧ縺阪∪縺吶・br>
                        窶ｻ 邏吶↓蜊ｰ蛻ｷ縺吶ｋ蝣ｴ蜷医ｂ縲、4讓ｪ繧ｵ繧､繧ｺ縺ｧ邯ｺ鮗励↓繝壹・繧ｸ蛻・￠縺輔ｌ縺ｾ縺吶・
                    </p>
                    <div style="margin-top: 15px;">
                        <button onclick="window.print()">蜜 蜊ｰ蛻ｷ / PDF菫晏ｭ・/button>
                    </div>
                </div>

                <h1 style="font-size: 24px; margin-bottom: 20px;">
                    ${year}蟷ｴ ${month + 1}譛・繧ｷ繝輔ヨ陦ｨ
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
    // 繝ｭ繧ｸ繝・け繝ｻ繝倥Ν繝代・髢｢謨ｰ
    // =================================================================

    // --- 繧ｷ繝輔ヨ邱ｨ髮・---
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
        // 譌｢蟄倥・ input 縺梧戟縺｣縺ｦ縺・◆繧ｯ繝ｩ繧ｹ繧堤ｶ呎価縺励▽縺､縲∥ppearance-none 縺ｧ繝悶Λ繧ｦ繧ｶ繝・ヵ繧ｩ繝ｫ繝医・繧ｹ繧ｿ繧､繝ｫ繧呈ｶ医☆
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
        // 豁｣隕丞喧: 遘偵′蜷ｫ縺ｾ繧後※縺・ｋ蝣ｴ蜷・HH:mm:ss)縺ｯHH:mm縺ｫ蛻・ｊ隧ｰ繧√ｋ
        const normalizedSelected = selectedValue ? selectedValue.substr(0, 5) : '';
        
        let options = [];
        let found = false;
        // 15蛻・綾縺ｿ縺ｮ驕ｸ謚櫁い繧堤函謌・
        for (let i = 0; i < 24; i++) {
            for (let j = 0; j < 60; j += 15) {
                const h = String(i).padStart(2, '0');
                const m = String(j).padStart(2, '0');
                const time = `${h}:${m}`;
                if (time === normalizedSelected) found = true;
                options.push(time);
            }
        }
        // 譌｢蟄倥・蛟､縺・5蛻・綾縺ｿ縺ｧ縺ｪ縺・ｴ蜷医ｂ縲∬｡ｨ遉ｺ蟠ｩ繧後ｒ髦ｲ縺舌◆繧√↓驕ｸ謚櫁い縺ｫ霑ｽ蜉
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
        document.getElementById('editShiftTitle').textContent = '繧ｷ繝輔ヨ霑ｽ蜉';
        document.getElementById('editShiftDateDisplay').textContent = dateStr;
        document.getElementById('deleteShiftBtn').classList.add('hidden');
        
        const staffSelectHtml = `<select id="editShiftStaffSelect" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none mb-2"><option value="">繧ｹ繧ｿ繝・ヵ繧帝∈謚・/option>${this.state.staff.map(s => `<option value="${s.id}">${this._sanitize(s.name)}</option>`).join('')}</select>`;
        document.getElementById('editShiftStaffName').innerHTML = staffSelectHtml;
        
        // Select繝懊ャ繧ｯ繧ｹ縺ｮ蛻晄悄蛹・
        const defStart = (this.state.config.opening_time || '09:00').substr(0, 5);
        const defEnd = (this.state.config.closing_time || '18:00').substr(0, 5);
        
        const startEl = document.getElementById('editShiftStart');
        const endEl = document.getElementById('editShiftEnd');
        
        startEl.innerHTML = this.generateTimeOptionsHTML(defStart);
        endEl.innerHTML = this.generateTimeOptionsHTML(defEnd);
        
        // 蛟､繧呈・遉ｺ逧・↓繧ｻ繝・ヨ縺励※遒ｺ螳溘↓縺吶ｋ
        startEl.value = defStart;
        endEl.value = defEnd;

        document.getElementById('editShiftBreak').value = 60;

        this.openModal('editShiftModal');
        const saveBtn = document.getElementById('saveShiftBtn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => this.saveShift());
    },

    async updateShiftDrag(shiftId, updates) {
        try {
            await API.update('shifts', shiftId, updates);
            // 繝ｭ繝ｼ繧ｫ繝ｫ繧ｹ繝・・繝医ｂ譖ｴ譁ｰ
            const shift = this.state.shifts.find(s => s.id === shiftId);
            if (shift) {
                Object.assign(shift, updates);
            }
            // 莨第・譎る俣繧貞・險育ｮ・
            if (shift && (updates.start_time || updates.end_time)) {
                const [sh, sm] = shift.start_time.split(':').map(Number);
                const [eh, em] = shift.end_time.split(':').map(Number);
                let hours = (eh + em / 60) - (sh + sm / 60);
                if (hours <= 0) hours += 24; // 譌･縺ｾ縺溘℃蟇ｾ蠢・
                const breakRules = this.state.config.break_rules || this.state.defaultConfig.break_rules || [];
                let brk = 0;
                for (const rule of breakRules.sort((a, b) => a.min_hours - b.min_hours)) {
                    if (hours > rule.min_hours) brk = rule.break_minutes;
                }
                if (shift.break_minutes !== brk) {
                    shift.break_minutes = brk;
                    await API.update('shifts', shiftId, { break_minutes: brk });
                }
            }
            this.renderCurrentView();
            this.updateHeader();
            const staff = this.getStaff(updates.staff_id || shift?.staff_id);
            this.showToast(`繧ｷ繝輔ヨ繧呈峩譁ｰ縺励∪縺励◆${staff ? ' (' + staff.name + ')' : ''}`, 'success');
        } catch (e) {
            console.error('Drag update failed:', e);
            this.showToast('繧ｷ繝輔ヨ譖ｴ譁ｰ縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
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
        document.getElementById('editShiftTitle').textContent = '繧ｷ繝輔ヨ邱ｨ髮・;
        document.getElementById('editShiftDateDisplay').textContent = shift.date;
        document.getElementById('editShiftStaffName').innerHTML = `<div class="py-2 text-xl text-gray-800">${staff ? staff.name : '荳肴・縺ｪ繧ｹ繧ｿ繝・ヵ'}</div>`;
        
        // 譎る俣縺ｮ豁｣隕丞喧 (HH:mm:ss -> HH:mm)
        const startTime = shift.start_time.substr(0, 5);
        const endTime = shift.end_time.substr(0, 5);

        // Select繝懊ャ繧ｯ繧ｹ縺ｮ蛻晄悄蛹・
        const startEl = document.getElementById('editShiftStart');
        const endEl = document.getElementById('editShiftEnd');
        
        startEl.innerHTML = this.generateTimeOptionsHTML(startTime);
        endEl.innerHTML = this.generateTimeOptionsHTML(endTime);
        
        // 蛟､繧呈・遉ｺ逧・↓繧ｻ繝・ヨ縺励※遒ｺ螳溘↓縺吶ｋ
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
        const id = (document.getElementById('editShiftId')?.value || '');
        const date = (document.getElementById('editShiftDate')?.value || '');
        const start = (document.getElementById('editShiftStart')?.value || '');
        const end = (document.getElementById('editShiftEnd')?.value || '');
        const breakMins = Number((document.getElementById('editShiftBreak')?.value || ''));
        let staffId = (document.getElementById('editShiftStaffId')?.value || '');
        const selectEl = document.getElementById('editShiftStaffSelect');
        if (selectEl) staffId = selectEl.value;

        if (!staffId || !start || !end) { alert('蠢・磯・岼繧貞・蜉帙＠縺ｦ縺上□縺輔＞'); return; }
        if (start >= end) { alert('譎る俣縺ｮ鬆・ｺ上′荳肴ｭ｣縺ｧ縺・); return; }
        if (document.getElementById('editShiftHoliday').checked && id) { await this.deleteShift(id); this.closeModal('editShiftModal'); return; }

        const data = { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins };
        if (!id) data.organization_id = this.state.organization_id;
        
        this.showLoading(true);
        try {
            if (id) await API.update('shifts', id, data); else await API.create('shifts', data);
            await this.loadData();
            
            // 繝薙Η繝ｼ縺ｮ譖ｴ譁ｰ (繧ｫ繝ｬ繝ｳ繝繝ｼ縺ｫ謌ｻ繧峨★縲∫樟蝨ｨ縺ｮ繝｢繝ｼ繝峨ｒ邯ｭ謖・
            if (this.state.view === 'manual-shift' && document.getElementById('shiftViewContent')) {
                const content = document.getElementById('shiftViewContent');
                // 繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ菴咲ｽｮ縺ｮ菫晄戟繧定ｩｦ縺ｿ繧・
                const scrollEl = content.firstElementChild;
                const sTop = scrollEl ? scrollEl.scrollTop : 0;
                const sLeft = scrollEl ? scrollEl.scrollLeft : 0;
                
                if (this.state.shiftViewMode === 'table') {
                    this.renderShiftTable(content);
                } else {
                    this.renderCalendar(content);
                }
                
                // 繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ蠕ｩ蜈・
                if (content.firstElementChild) {
                    content.firstElementChild.scrollTop = sTop;
                    content.firstElementChild.scrollLeft = sLeft;
                }
            } else {
                this.renderCurrentView();
            }

            // 繝倥ャ繝繝ｼ縺ｮ蛻・梵謨ｰ蛟､・井ｺｺ莉ｶ雋ｻ縺ｪ縺ｩ・峨ｒ譖ｴ譁ｰ
            this.calculateMonthlyStats();

            this.closeModal('editShiftModal');
            this.showToast('繧ｷ繝輔ヨ繧剃ｿ晏ｭ倥＠縺ｾ縺励◆', 'success');
        } catch (e) { this.showToast('菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆', 'error'); } finally { this.showLoading(false); }
    },

    async deleteShift(id) {
        // 繧ｷ繝輔ヨ蜑企勁縺ｮ螳牙・遒ｺ隱・
        const shift = this.state.shifts.find(s => s.id === id);
        const staffName = shift ? (this.state.staff.find(st => st.id === shift.staff_id)?.name || '荳肴・') : '荳肴・';
        if (!confirm(`縲舌す繝輔ヨ蜑企勁遒ｺ隱阪曾n\n繧ｹ繧ｿ繝・ヵ: ${staffName}\n譌･莉・ ${shift?.date || '荳肴・'}\n\n縺薙・繧ｷ繝輔ヨ繧貞炎髯､縺励∪縺吶°・歃n窶ｻ縺薙・謫堺ｽ懊・蜈・↓謌ｻ縺帙∪縺帙ｓ`)) return;
        this.showLoading(true);
        try {
            await API.delete('shifts', id);
            await this.loadData();
            
            // 繝薙Η繝ｼ縺ｮ譖ｴ譁ｰ (繧ｫ繝ｬ繝ｳ繝繝ｼ縺ｫ謌ｻ繧峨★縲∫樟蝨ｨ縺ｮ繝｢繝ｼ繝峨ｒ邯ｭ謖・
            if (this.state.view === 'manual-shift' && document.getElementById('shiftViewContent')) {
                const content = document.getElementById('shiftViewContent');
                // 繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ菴咲ｽｮ縺ｮ菫晄戟
                const scrollEl = content.firstElementChild;
                const sTop = scrollEl ? scrollEl.scrollTop : 0;
                const sLeft = scrollEl ? scrollEl.scrollLeft : 0;

                if (this.state.shiftViewMode === 'table') {
                    this.renderShiftTable(content);
                } else {
                    this.renderCalendar(content);
                }

                // 繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ蠕ｩ蜈・
                if (content.firstElementChild) {
                    content.firstElementChild.scrollTop = sTop;
                    content.firstElementChild.scrollLeft = sLeft;
                }
            } else {
                this.renderCurrentView();
            }

            // 繝倥ャ繝繝ｼ縺ｮ蛻・梵謨ｰ蛟､・井ｺｺ莉ｶ雋ｻ縺ｪ縺ｩ・峨ｒ譖ｴ譁ｰ
            this.calculateMonthlyStats();

            this.closeModal('editShiftModal');
            this.showToast('蜑企勁縺励∪縺励◆', 'success');
        } catch (e) { this.showToast('螟ｱ謨励＠縺ｾ縺励◆', 'error'); } finally { this.showLoading(false); }
    },

    // --- 繧ｹ繧ｿ繝・ヵ邂｡逅・---
    prepareStaffModal() {
        this.updateStaffRoleSelect();
        this.openModal('staffModal');
        document.getElementById('staffForm').reset();
        document.getElementById('staffId').value='';
        if (document.getElementById('staffIsExempt')) document.getElementById('staffIsExempt').checked = false;
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb) cb.checked = true;
        }
    },
    
    updateStaffRoleSelect() {
        const select = document.getElementById('staffRole');
        if(!select) return;
        
        const roles = this.state.config.roles || this.state.defaultConfig.roles;
        select.innerHTML = roles.map(r => `<option value="${r.id}">${this._sanitize(r.name)}</option>`).join('');
    },

    // 繝励Λ繝ｳ蛻･繧ｹ繧ｿ繝・ヵ荳企剞
    getStaffLimit() {
        // demo繝・リ繝ｳ繝医・辟｡蛻ｶ髯・
        const contractId = this.state.config.contract_id || '';
        if (contractId === 'demo') return 9999;

        const plan = this.state.config.stripe_plan || '';
        if (plan === 'premium') return 9999;
        if (plan === 'pro') return 50;
        if (plan === 'standard') return 10;
        return 30; // 繝励Λ繝ｳ譛ｪ險ｭ螳壽凾縺ｮ繝・ヵ繧ｩ繝ｫ繝・
    },

    // 繧ｹ繧ｿ繝・ヵ謨ｰ縺後・繝ｩ繝ｳ荳企剞繧定ｶ・∴縺ｦ縺・ｋ縺九メ繧ｧ繝・け
    isStaffOverLimit() {
        const limit = this.getStaffLimit();
        return this.state.staff.length > limit;
    },

    // 繧ｹ繧ｿ繝・ヵ雜・℃隴ｦ蜻翫ｒ陦ｨ遉ｺ・医ム繧ｦ繝ｳ繧ｰ繝ｬ繝ｼ繝牙ｾ後↑縺ｩ・・
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
                <span class="font-bold">${planName}繝励Λ繝ｳ縺ｮ繧ｹ繧ｿ繝・ヵ荳企剞(${limit}蜷・繧・{over}蜷崎ｶ・℃縺励※縺・∪縺吶・/span>
                <span class="text-red-200">繧ｹ繧ｿ繝・ヵ繧・{over}蜷榊炎髯､縺吶ｋ縺ｾ縺ｧ繧ｷ繝輔ヨ菴懈・縺ｯ縺ｧ縺阪∪縺帙ｓ縲・/span>
                <button onclick="app.changeView('staff'); document.getElementById('staffOverLimitAlert')?.remove();" class="px-4 py-1 bg-white text-red-600 rounded font-bold text-sm hover:bg-red-50 transition">
                    繧ｹ繧ｿ繝・ヵ邂｡逅・∈
                </button>
            </div>
        `;
        document.body.prepend(alert);
    },

    // 繧ｹ繧ｿ繝・ヵ雜・℃隴ｦ蜻翫ｒ豸医☆
    clearStaffOverLimitAlert() {
        const alertEl = document.getElementById('staffOverLimitAlert');
        if (alertEl) alertEl.remove();
    },

    // 豎ｺ貂医お繝ｩ繝ｼ繧｢繝ｩ繝ｼ繝郁｡ｨ遉ｺ
    showPaymentAlert() {
        const existing = document.getElementById('paymentAlert');
        if (existing) existing.remove();

        const alert = document.createElement('div');
        alert.id = 'paymentAlert';
        alert.className = 'fixed top-0 left-0 right-0 z-[200] bg-orange-500 text-white px-4 py-3 shadow-lg';
        alert.innerHTML = `
            <div class="max-w-3xl mx-auto flex items-center justify-center gap-3 flex-wrap">
                <i class="fa-solid fa-credit-card text-lg animate-pulse"></i>
                <span class="font-bold">豎ｺ貂医お繝ｩ繝ｼ縺檎匱逕溘＠縺ｦ縺・∪縺・/span>
                <span class="text-orange-100">縺頑髪謇輔＞譁ｹ豕輔ｒ譖ｴ譁ｰ縺励※縺上□縺輔＞縲よ悴蟇ｾ蠢懊・蝣ｴ蜷医し繝ｼ繝薙せ縺悟●豁｢縺輔ｌ縺ｾ縺吶・/span>
                <button onclick="app.openStripePortal()" class="px-4 py-1.5 bg-white text-orange-600 rounded font-bold text-sm hover:bg-orange-50 transition">
                    <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>謾ｯ謇輔＞譁ｹ豕輔ｒ譖ｴ譁ｰ
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

        // 繝・リ繝ｳ繝域ュ蝣ｱ繧堤｢ｺ螳溘↓蜿門ｾ・
        const contractId = this.state.config.contract_id || API.session?.user?.contract_id;
        const orgId = this.state.config.organization_id || this.state.organization_id || API.session?.user?.organization_id;

        if (!contractId || !orgId) {
            this.showToast('繝・リ繝ｳ繝域ュ蝣ｱ縺悟叙蠕励〒縺阪∪縺帙ｓ縲ょ・繝ｭ繧ｰ繧､繝ｳ縺励※縺上□縺輔＞縲・, 'error');
            return;
        }

        // 譁ｰ隕丈ｽ懈・譎・ 繝励Λ繝ｳ蛻･繧ｹ繧ｿ繝・ヵ謨ｰ蛻ｶ髯舌メ繧ｧ繝・け
        if (!id) {
            const limit = this.getStaffLimit();
            const currentCount = this.state.staff.length;
            if (currentCount >= limit) {
                this.showUpgradeModal();
                return;
            }
        }

        const data = {
            name: (document.getElementById('staffName')?.value || ''),
            role: (document.getElementById('staffRole')?.value || ''),
            evaluation: (document.getElementById('staffEvaluation')?.value || ''),
            salary_type: (document.getElementById('staffSalaryType')?.value || ''),
            hourly_wage: Number((document.getElementById('staffHourlyWage')?.value || '')),
            monthly_salary: Number((document.getElementById('staffMonthlySalary')?.value || '')),
            max_days_week: Number((document.getElementById('staffMaxDaysPerWeek')?.value || '')),
            max_hours_day: Number((document.getElementById('staffMaxHoursPerDay')?.value || '')),
            min_days_week: Number((document.getElementById('staffMinDaysPerWeek')?.value || '')) || 0,
            min_days_month: Number((document.getElementById('staffMinDaysPerMonth')?.value || '')) || 0,
            contract_id: contractId
        };

        if (data.min_days_week > data.max_days_week) {
            this.showToast('譛菴主・蜍､譌･謨ｰ縺ｯ縲∵怙螟ｧ蜃ｺ蜍､譌･謨ｰ莉･荳九↓險ｭ螳壹＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }

        if (!id) {
            data.organization_id = orgId;
        }

        // DB繝槭う繧ｰ繝ｬ繝ｼ繧ｷ繝ｧ繝ｳ荳崎ｦ√〒菫晏ｭ倥☆繧九◆繧√・繝上ャ繧ｯ・嗽navailable_dates縺ｫ繝｡繧ｿ繝・・繧ｿ繧貞沂繧∬ｾｼ繧
        const existingStaff = this.state.staff.find(st => st.id === id);
        let uDates = [];
        if (existingStaff && existingStaff.unavailable_dates) {
            uDates = Array.isArray(existingStaff.unavailable_dates) 
                ? [...existingStaff.unavailable_dates] 
                : String(existingStaff.unavailable_dates).split(',').map(d=>d.trim()).filter(d=>d);
        }
        // 譌｢蟄倥・繧ｿ繧ｰ繧貞炎髯､
        uDates = uDates.filter(d => !d.startsWith('priority:') && !d.startsWith('contract:') && !d.startsWith('isExempt:') && !d.startsWith('prefStart:') && !d.startsWith('prefEnd:') && !d.startsWith('ngDay:'));
        
        const contractType = document.getElementById('staffContractType')?.value || 'general';
        const shiftPriority = document.getElementById('staffShiftPriority')?.value || 'medium';
        const isExempt = document.getElementById('staffIsExempt')?.checked ? 'true' : 'false';
        const prefStart = document.getElementById('staffPrefStart')?.value || '';
        const prefEnd = document.getElementById('staffPrefEnd')?.value || '';
        
        uDates.push(`priority:${shiftPriority}`);
        uDates.push(`contract:${contractType}`);
        uDates.push(`isExempt:${isExempt}`);
        if (prefStart) uDates.push(`prefStart:${prefStart}`);
        if (prefEnd) uDates.push(`prefEnd:${prefEnd}`);
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb && !cb.checked) uDates.push(`ngDay:${i}`);
        }
        
        data.unavailable_dates = uDates;

        this.showLoading(true);
        try {
            let result;
            if (id) {
                // 譖ｴ譁ｰ: 蜈医↓API縺ｫ騾∽ｿ｡縺励∵・蜉溷ｾ後↓State繧呈峩譁ｰ
                await API.update('staff', id, data);
                const index = this.state.staff.findIndex(s => s.id === id);
                if (index !== -1) {
                    this.state.staff[index] = { ...this.state.staff[index], ...data };
                }
            } else {
                // 譁ｰ隕丈ｽ懈・
                result = await API.create('staff', data);
                if (!result) {
                    data.id = 'temp_' + Date.now();
                    this.state.staff.push(data);
                } else {
                    this.state.staff.push(result);
                }
            }
            
            this.renderStaffList(document.getElementById('viewContainer'));
            this.closeModal('staffModal');
            this.showToast('菫晏ｭ倥＠縺ｾ縺励◆', 'success');
        } catch (e) { 
            console.error('[SaveStaff] 菫晏ｭ伜､ｱ謨・', e);
            // 菫晏ｭ伜､ｱ謨玲凾縺ｯDB縺九ｉ譛譁ｰ繝・・繧ｿ繧貞・蜿門ｾ励＠縺ｦState繧貞ｾｩ蜈・
            try { await this.loadData(); } catch(reloadErr) { console.error(reloadErr); }
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast('菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆: ' + e.message, 'error');
        } finally { 
            this.showLoading(false); 
        }
    },
    editStaff(id) {
        const s = this.getStaff(id);
        if(!s) return;
        this.updateStaffRoleSelect(); // Select繧呈怙譁ｰ蛹・
        document.getElementById('staffId').value = s.id;
        document.getElementById('staffName').value = s.name;
        document.getElementById('staffRole').value = s.role;
        document.getElementById('staffEvaluation').value = s.evaluation || 'B';
        
        // unavailable_dates縺九ｉ繝｡繧ｿ繝・・繧ｿ繧呈歓蜃ｺ
        let shiftPriority = 'medium';
        let contractType = 'general';
        let prefStart = '';
        let prefEnd = '';
        let ngDays = [];
        if (s.unavailable_dates) {
            const uDates = Array.isArray(s.unavailable_dates) ? s.unavailable_dates : String(s.unavailable_dates).split(',');
            uDates.forEach(d => {
                const txt = d.trim();
                if (txt.startsWith('priority:')) shiftPriority = txt.replace('priority:', '');
                if (txt.startsWith('contract:')) contractType = txt.replace('contract:', ''); if (txt.startsWith('isExempt:')) isExempt = txt.replace('isExempt:', '') === 'true';
                if (txt.startsWith('prefStart:')) prefStart = txt.replace('prefStart:', '');
                if (txt.startsWith('prefEnd:')) prefEnd = txt.replace('prefEnd:', '');
                if (txt.startsWith('ngDay:')) ngDays.push(txt.replace('ngDay:', ''));
            });
        }
        if (document.getElementById('staffContractType')) document.getElementById('staffContractType').value = contractType; if (document.getElementById('staffIsExempt')) document.getElementById('staffIsExempt').checked = isExempt;
        if (document.getElementById('staffShiftPriority')) document.getElementById('staffShiftPriority').value = shiftPriority;
        if (document.getElementById('staffPrefStart')) document.getElementById('staffPrefStart').value = prefStart;
        if (document.getElementById('staffPrefEnd')) document.getElementById('staffPrefEnd').value = prefEnd;
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb) cb.checked = !ngDays.includes(String(i));
        }
        document.getElementById('staffSalaryType').value = s.salary_type;
        document.getElementById('staffHourlyWage').value = s.hourly_wage;
        document.getElementById('staffMonthlySalary').value = s.monthly_salary;
        document.getElementById('staffMaxDaysPerWeek').value = s.max_days_week || 5;
        document.getElementById('staffMaxHoursPerDay').value = s.max_hours_day || 8;
        document.getElementById('staffMinDaysPerWeek').value = s.min_days_week || 0;
        document.getElementById('staffMinDaysPerMonth').value = s.min_days_month || 0;
        this.toggleSalaryInputs();
        this.openModal('staffModal');
    },
    async deleteStaff(id) {
        // 邂｡逅・・ｨｩ髯舌メ繧ｧ繝・け
        if (!this.state.isAdmin) {
            this.showToast('繧ｹ繧ｿ繝・ヵ縺ｮ蜑企勁縺ｫ縺ｯ邂｡逅・・ｨｩ髯舌′蠢・ｦ√〒縺・, 'error');
            return;
        }

        const staff = this.state.staff.find(s => s.id === id);
        if (!staff) {
            this.showToast('繧ｹ繧ｿ繝・ヵ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ', 'error');
            return;
        }

        // 邂｡逅・・い繧ｫ繧ｦ繝ｳ繝医・邨ｶ蟇ｾ縺ｫ蜑企勁荳榊庄
        if (staff.login_id === 'admin' || staff.role === 'manager' || staff.role === 'admin') {
            this.showToast('邂｡逅・・・蠎鈴聞繧｢繧ｫ繧ｦ繝ｳ繝医・蜑企勁縺ｧ縺阪∪縺帙ｓ縲・, 'error');
            return;
        }

        // 莠碁㍾遒ｺ隱・ 1蝗樒岼
        if (!confirm(`縲舌せ繧ｿ繝・ヵ蜑企勁 - 譛邨ら｢ｺ隱阪曾n\n縲・{staff.name}縲阪ｒ譛ｬ蠖薙↓蜑企勁縺励∪縺吶°・歃n\n笞・・縺薙・謫堺ｽ懊・蜈・↓謌ｻ縺帙∪縺帙ｓ\n笞・・髢｢騾｣縺吶ｋ繧ｷ繝輔ヨ繝ｻ逕ｳ隲九ョ繝ｼ繧ｿ繧ょ・縺ｦ蜑企勁縺輔ｌ縺ｾ縺兪)) return;

        // 莠碁㍾遒ｺ隱・ 2蝗樒岼・亥錐蜑榊・蜉幢ｼ・
        const inputName = prompt(`譛邨ら｢ｺ隱・ 蜑企勁縺吶ｋ繧ｹ繧ｿ繝・ヵ蜷阪・{staff.name}縲阪ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞:`);
        if (inputName !== staff.name) {
            this.showToast('蜷榊燕縺御ｸ閾ｴ縺励∪縺帙ｓ縲ょ炎髯､繧偵く繝｣繝ｳ繧ｻ繝ｫ縺励∪縺励◆縲・, 'info');
            return;
        }

        this.showLoading(true);
        try {
            await API.delete('staff', id);
            this.state.staff = this.state.staff.filter(s => s.id !== id);
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast(`${staff.name} 繧貞炎髯､縺励∪縺励◆`, 'success');
        } catch (e) {
            console.error(e);
            this.showToast('蜑企勁縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
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

    // --- 逕ｳ隲・---
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

        const monthNames = ['1譛・, '2譛・, '3譛・, '4譛・, '5譛・, '6譛・, '7譛・, '8譛・, '9譛・, '10譛・, '11譛・, '12譛・];
        const dayNames = ['譌･', '譛・, '轣ｫ', '豌ｴ', '譛ｨ', '驥・, '蝨・];

        if (titleEl) titleEl.textContent = `${year}蟷ｴ ${monthNames[m]}`;

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

        // 驕ｸ謚樊律縺ｮ陦ｨ遉ｺ
        const sorted = [...this._selectedRequestDates].sort();
        if (countEl) countEl.textContent = sorted.length;

        if (sorted.length === 0) {
            display.innerHTML = '<span class="text-xs text-gray-300">繧ｫ繝ｬ繝ｳ繝繝ｼ縺九ｉ譌･莉倥ｒ驕ｸ繧薙〒縺上□縺輔＞</span>';
        } else {
            display.innerHTML = sorted.map(d => {
                const dt = new Date(d);
                const dayLabel = ['譌･','譛・,'轣ｫ','豌ｴ','譛ｨ','驥・,'蝨・][dt.getDay()];
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
            alert('繧ｹ繧ｿ繝・ヵ縺ｨ譌･莉倥ｒ驕ｸ謚槭＠縺ｦ縺上□縺輔＞');
            return;
        }

        const typeStr = type === 'off' ? '縲蝉ｼ代∩蟶梧悍縲・ : '縲仙共蜍吝ｸ梧悍縲・;
        const datesStr = dates.join(', ');
        const confirmMsg = `莉･荳九・蜀・ｮｹ縺ｧ逕ｳ隲九ｒ謠仙・縺励∪縺吶・n\n譌･莉・ ${datesStr}\n莉ｶ謨ｰ: ${dates.length}譌･蛻・n蜀・ｮｹ: ${typeStr}\n逅・罰: ${reason || '縺ｪ縺・}\n\n騾∽ｿ｡縺励∪縺吶°・歔;

        if (!confirm(confirmMsg)) return;

        this.showLoading(true);
        try {
            // 譌･莉倥＃縺ｨ縺ｫ1莉ｶ縺壹▽逕ｳ隲九ｒ菴懈・
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
                    if (!data.start_time || !data.end_time) { alert('譎る俣繧貞・蜉帙＠縺ｦ縺上□縺輔＞'); return; }
                }

                await API.create('requests', data);
            }

            await this.loadData();
            this.closeModal('requestModal');
            this.showToast(`${dates.length}莉ｶ縺ｮ逕ｳ隲九ｒ騾∽ｿ｡縺励∪縺励◆`, 'success');
            if (this.state.view === 'requests') this.renderRequests(document.getElementById('viewContainer'));
        } catch (e) {
            this.showToast('騾∽ｿ｡螟ｱ謨・, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async submitMultiRequest() { return this.submitRequest(); },

    async handleRequest(id, status) {
        if (!confirm(status === 'approved' ? '謇ｿ隱阪＠縺ｾ縺吶°・・ : '蜊ｴ荳九＠縺ｾ縺吶°・・)) return;
        this.showLoading(true);
        try {
            await API.update('requests', id, { status: status });
            
            // 謇ｿ隱肴凾縺ｮ霑ｽ蜉蜃ｦ逅・
            if (status === 'approved') {
                const req = this.state.requests.find(r => r.id == id);
                if (req) {
                    // 1. 蜍､蜍吝ｸ梧悍縺ｪ繧峨す繝輔ヨ菴懈・
                    if (req.type === 'work') {
                        // 髢句ｧ九・邨ゆｺ・凾髢薙′謖・ｮ壹＆繧後※縺・↑縺・ｴ蜷医・蠎苓・險ｭ螳壹°繧牙叙蠕励↑縺ｩ縺ｮ繝ｭ繧ｸ繝・け縺悟ｿ・ｦ√□縺・
                        // 縺薙％縺ｧ縺ｯ繝ｪ繧ｯ繧ｨ繧ｹ繝医↓縺ｪ縺代ｌ縺ｰ繝・ヵ繧ｩ繝ｫ繝亥､繧貞・繧後ｋ
                        const start = req.start_time || this.state.config.opening_time || '09:00';
                        const end = req.end_time || this.state.config.closing_time || '18:00';
                        await API.create('shifts', { 
                            staff_id: req.staff_id, 
                            date: req.dates, 
                            start_time: start, 
                            end_time: end, 
                            break_minutes: 60, // 繝・ヵ繧ｩ繝ｫ繝・
                            organization_id: this.state.organization_id
                        });
                    }
                    // 2. 莨代∩蟶梧悍縺ｪ繧・unavailable_dates 繧呈峩譁ｰ
                    else if (req.type === 'off' || req.type === 'holiday') {
                        const staff = this.getStaff(req.staff_id);
                        if (staff) {
                            // 隍・焚譌･繧ｫ繝ｳ繝槫玄蛻・ｊ蟇ｾ蠢・
                            const reqDates = String(req.dates).split(',').map(d => d.trim()).filter(d => d);
                            let uDates = [];
                            if (staff.unavailable_dates) {
                                uDates = Array.isArray(staff.unavailable_dates)
                                    ? [...staff.unavailable_dates]
                                    : String(staff.unavailable_dates).split(',').map(d => d.trim()).filter(d => d);
                            }
                            let changed = false;
                            for (const dateStr of reqDates) {
                                if (!uDates.includes(dateStr)) {
                                    uDates.push(dateStr);
                                    changed = true;
                                }
                            }
                            if (changed) {
                                await API.update('staff', staff.id, {
                                    unavailable_dates: uDates
                                });
                                staff.unavailable_dates = uDates;
                            }
                        }
                    }
                }
            }
            await this.loadData();
            this.renderRequests(document.getElementById('viewContainer'));
            this.showToast('蜃ｦ逅・ｮ御ｺ・, 'success');
        } catch(e) { this.showToast('繧ｨ繝ｩ繝ｼ逋ｺ逕・, 'error'); } finally { this.showLoading(false); }
    },

    async handleBatchApprove() {
        const pending = this.state.requests.filter(r => r.status === 'pending');
        if (pending.length === 0) return;
        if (!confirm(`謇ｿ隱榊ｾ・■ ${pending.length}莉ｶ 繧貞・縺ｦ謇ｿ隱阪＠縺ｾ縺吶°・歔)) return;

        this.showLoading(true);
        try {
            for (const req of pending) {
                await this.handleRequest(req.id, 'approved');
            }
        } catch (e) {
            this.showToast('荳諡ｬ謇ｿ隱堺ｸｭ縺ｫ繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    updateRequestBadge() {
        const count = this.state.requests.filter(r => r.status === 'pending').length;
        const badge = document.getElementById('pendingRequestsBadge');
        if(badge) {
            badge.textContent = count;
            badge.classList.toggle('hidden', count === 0);
        }
    },

       // --- AI繧ｷ繝輔ヨ菴懈・ (Python + Gemini) ---
       _shiftGenTips: [
            '蜉ｴ蝓ｺ豕・2譚｡: 1譌･8譎る俣繝ｻ騾ｱ40譎る俣縺梧ｳ募ｮ壼感蜒肴凾髢薙・荳企剞縺ｧ縺・,
            '蜉ｴ蝓ｺ豕・4譚｡: 6譎る俣雜・〒45蛻・・譎る俣雜・〒60蛻・・莨第・縺悟ｿ・ｦ√〒縺・,
            '蜉ｴ蝓ｺ豕・5譚｡: 騾ｱ1譌･莉･荳翫・莨第律縺悟ｿ・ｦ√〒縺呻ｼ磯｣邯・譌･縺ｾ縺ｧ・・,
            'AI縺悟推繧ｹ繧ｿ繝・ヵ縺ｮ蟶梧悍莨代ｒ蟆企㍾縺励↑縺後ｉ譛驕ｩ驟咲ｽｮ繧定ｨ育ｮ嶺ｸｭ...',
            '蝨滓律逾昴・蜑ｲ蠅苓ｳ・≡(1.25蛟・繧定・・縺励※繧ｳ繧ｹ繝域怙驕ｩ蛹悶＠縺ｦ縺・∪縺・,
            '邂｡逅・・′蜷・す繝輔ヨ縺ｫ譛菴・蜷埼・鄂ｮ縺輔ｌ繧九ｈ縺・ｪｿ謨ｴ縺励※縺・∪縺・,
            '繧ｹ繧ｿ繝・ヵ縺ｮ隧穂ｾ｡繝ｻ繧ｹ繧ｭ繝ｫ縺ｫ蠢懊§縺ｦ繝舌Λ繝ｳ繧ｹ繧医￥驟咲ｽｮ縺励∪縺・,
            '譁ｰ莠ｺ繧ｹ繧ｿ繝・ヵ縺ｫ縺ｯ繝｡繝ｳ繧ｿ繝ｼ・育ｮ｡逅・・ｼ峨ｒ驟咲ｽｮ縺励∪縺・,
            '譛磯俣縺ｮ邱丈ｺｺ莉ｶ雋ｻ縺梧怙蟆上↓縺ｪ繧九ｈ縺・焚逅・怙驕ｩ蛹悶ｒ螳溯｡御ｸｭ...',
            'Python縺ｧ荳谺｡譯医ｒ菴懈・ 竊・AI縺ｧ蜉ｴ蝓ｺ豕輔メ繧ｧ繝・け・・怙邨りｪｿ謨ｴ',
        ],
        _tipTimer: null,

       async runAutoFill() {
        if (this._shiftGenInProgress) return;
        if (!this.state.isShopLoggedIn || !this.state.organization_id) {
            this.showToast('繧ｻ繝・す繝ｧ繝ｳ繧ｨ繝ｩ繝ｼ: 蜀阪Ο繧ｰ繧､繝ｳ縺励※縺上□縺輔＞', 'error');
            return;
        }

        // 繧ｹ繧ｿ繝・ヵ雜・℃繝√ぉ繝・け・医ム繧ｦ繝ｳ繧ｰ繝ｬ繝ｼ繝牙ｾ後・繝上ャ繧ｯ髦ｲ豁｢・・
        if (this.isStaffOverLimit()) {
            const limit = this.getStaffLimit();
            const over = this.state.staff.length - limit;
            const planName = {standard: 'Standard', pro: 'Pro', premium: 'Premium'}[this.state.config.stripe_plan] || 'Standard';
            this.closeModal('autoFillModal');
            this.showStaffOverLimitAlert();
            this.showToast(`${planName}繝励Λ繝ｳ縺ｮ荳企剞(${limit}蜷・繧・{over}蜷崎ｶ・℃縺励※縺・∪縺吶ゅせ繧ｿ繝・ヵ繧貞炎髯､縺励※縺上□縺輔＞縲Ａ, 'error');
            this.changeView('staff');
            return;
        }

        const targetType = (document.getElementById('autoFillTarget')?.value || '');
        this.closeModal('autoFillModal');

        const loadingEl = document.getElementById('globalLoading');
        const loadingDefault = document.getElementById('loadingDefault');
        const loadingShiftGen = document.getElementById('loadingShiftGen');
        const stepEl = document.getElementById('shiftGenStep');
        const barEl = document.getElementById('shiftGenBar');
        const tipEl = document.getElementById('shiftGenTip');

        this._shiftGenInProgress = true;

        if (loadingDefault) loadingDefault.style.display = 'none';
        if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
        if (loadingEl) loadingEl.classList.remove('hidden');
        if (stepEl) stepEl.textContent = '繧ｹ繧ｿ繝・ヵ諠・ｱ繧定ｪｭ縺ｿ霎ｼ繧薙〒縺・∪縺・..';
        if (barEl) { barEl.style.transition = 'width 2s ease'; barEl.style.width = '5%'; }

        // 譛菴手｡ｨ遉ｺ譎る俣繧剃ｿ晁ｨｼ
        const loadingStartTime = Date.now();
        const MIN_LOADING_MS = 12000;

        // 繝励Ο繧ｰ繝ｬ繧ｹ繝舌・繧呈ｻ代ｉ縺九↓騾ｲ繧√ｋ・亥ｮ溷・逅・→迢ｬ遶具ｼ・
        let fakeProgress = 5;
        const progressTimer = setInterval(() => {
            if (fakeProgress < 90) {
                fakeProgress += Math.random() * 3 + 1;
                if (fakeProgress > 90) fakeProgress = 90;
                if (barEl) barEl.style.width = fakeProgress + '%';
            }
        }, 800);

        // 雎・衍隴倥Ο繝ｼ繝・・繧ｷ繝ｧ繝ｳ髢句ｧ・
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

        // 繧ｹ繝・ャ繝励Γ繝・そ繝ｼ繧ｸ繧偵ｆ縺｣縺上ｊ蛻・ｊ譖ｿ縺・
        const steps = [
            { delay: 2000, msg: '莠ｺ蜩｡驟咲ｽｮ縺ｮ莠句燕繝√ぉ繝・け荳ｭ...' },
            { delay: 4500, msg: 'AI縺後す繝輔ヨ繧呈怙驕ｩ蛹悶＠縺ｦ縺・∪縺・..' },
            { delay: 7000, msg: '蜉ｴ蜒榊渕貅匁ｳ輔↓蝓ｺ縺･縺・※讀懆ｨｼ荳ｭ...' },
            { delay: 9500, msg: '譛邨りｪｿ謨ｴ繧定｡後▲縺ｦ縺・∪縺・..' },
        ];
        const stepTimers = steps.map(s => setTimeout(() => { if (stepEl) stepEl.textContent = s.msg; }, s.delay));

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

            // 繝・ヰ繝・げ: 騾∽ｿ｡繧ｹ繧ｿ繝・ヵ謨ｰ繧堤｢ｺ隱・
            console.log(`[AutoFill] Sending ${payload.staff_list.length} staff, ${dates.length} dates, ${payload.requests.length} requests`);
            console.log('[AutoFill] Staff IDs:', payload.staff_list.map(s => s.name || s.id).join(', '));

            // === STEP 2: 莠句燕繝√ぉ繝・け ===

            const checkResult = await API.checkFeasibility(payload);

            if (checkResult && !checkResult.feasible) {
                if (loadingEl) loadingEl.classList.add('hidden');

                const summary = checkResult.summary || {};
                const details = checkResult.daily_details || [];

                let alertMsg = '笞・・莠ｺ蜩｡荳崎ｶｳ縺梧､懷・縺輔ｌ縺ｾ縺励◆\n\n';
                alertMsg += '遞ｼ蜒榊庄閭ｽ繧ｹ繧ｿ繝・ヵ: ' + summary.usable_staff + '/' + summary.total_staff + '蜷構n';
                alertMsg += '荳崎ｶｳ蜷郁ｨ・ ' + summary.total_shortage_hours + ' 莠ｺ譎・n';
                alertMsg += '蠖ｱ髻ｿ譌･謨ｰ: ' + summary.affected_days + '譌･\n\n';

                if (details.length > 0) {
                    alertMsg += '--- 荳崎ｶｳ縺ｮ隧ｳ邏ｰ (譛螟ｧ5譌･) ---\n';
                    for (var di = 0; di < Math.min(details.length, 5); di++) {
                        var dd = details[di];
                        alertMsg += dd.date + ': 蜃ｺ蜍､蜿ｯ閭ｽ' + dd.available_staff + '蜷・/ 蠢・ｦ・ + dd.required_per_slot + '蜷構n';
                        for (var ri = 0; ri < dd.shortage_ranges.length; ri++) {
                            var r = dd.shortage_ranges[ri];
                            alertMsg += '  ' + r.start + '~' + r.end + ': ' + r.shortage + '蜷堺ｸ崎ｶｳ\n';
                        }
                    }
                }

                alertMsg += '\n縲唇K縲大感蜒肴擅莉ｶ繧堤ｷｩ蜥後＠縺ｦ蠑ｷ陦檎函謌申n縲舌く繝｣繝ｳ繧ｻ繝ｫ縲台ｸｭ豁｢縺励※莠ｺ蜩｡繧定ｪｿ謨ｴ';

                const forceGenerate = confirm(alertMsg);

                if (!forceGenerate) {
                    if (this._tipTimer) { clearInterval(this._tipTimer); this._tipTimer = null; }
                    clearInterval(progressTimer);
                    stepTimers.forEach(t => clearTimeout(t));
                    this._shiftGenInProgress = false;
                    if (loadingShiftGen) loadingShiftGen.style.display = 'none';
                    if (loadingDefault) loadingDefault.style.display = 'flex';
                    if (loadingEl) loadingEl.classList.add('hidden');
                    this.showToast('繧ｷ繝輔ヨ逕滓・繧剃ｸｭ豁｢縺励∪縺励◆縲ゅせ繧ｿ繝・ヵ縺ｮ霑ｽ蜉繧・擅莉ｶ縺ｮ隕狗峩縺励ｒ讀懆ｨ弱＠縺ｦ縺上□縺輔＞縲・, 'info');
                    return;
                }

                payload.mode = 'force';
                if (loadingEl) loadingEl.classList.remove('hidden');
                if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
                this.showToast('笞・・蜉ｴ蜒肴擅莉ｶ繧堤ｷｩ蜥後＠縺ｦ逕滓・縺励∪縺・, 'warning');
            }

            // === STEP 3: 蜑企勁蜃ｦ逅・===
            if (targetType === 'reset_all') {

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

            // === STEP 4: 繧ｷ繝輔ヨ逕滓・ ===

            console.log("Sending request to Calculation Engine...");
            const result = await API.generateShifts(payload);

            if (result.status === 'error') {
                this.showToast('逕滓・繧ｨ繝ｩ繝ｼ: ' + result.message, 'error');
                this._generationSuccess = false;
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

                // 繝励Ξ繝薙Η繝ｼ陦ｨ遉ｺ (DB菫晏ｭ倥・繝励Ξ繝薙Η繝ｼ謇ｿ隱榊ｾ後↓螳溯｡・
                this._generationSuccess = finalShifts.length > 0;
                this._generationCount = finalShifts.length;
                this._pendingPreviewShifts = finalShifts;
                this._pendingPreviewTargetType = targetType;
                this._pendingPreviewDates = dates;

            } else if (result.status === 'success' && result.mode === 'math_failed') {
                // 謨ｰ逅・怙驕ｩ蛹悶′隗｣繧定ｦ九▽縺代ｉ繧後↑縺九▲縺・
                console.warn('Math optimization failed - no feasible solution');
                this.showToast('譛驕ｩ蛹悶お繝ｳ繧ｸ繝ｳ縺瑚ｧ｣繧定ｦ九▽縺代ｉ繧後∪縺帙ｓ縺ｧ縺励◆縲ゅせ繧ｿ繝・ヵ縺ｮ蜍､蜍呎擅莉ｶ繧堤ｷｩ蜥後☆繧九°縲√せ繧ｿ繝・ヵ繧定ｿｽ蜉縺励※縺上□縺輔＞縲・, 'warning');
                this._generationSuccess = false;
            } else if (result.status === 'success' && (!result.shifts || result.shifts.length === 0)) {
                // 繧ｷ繝輔ヨ縺・莉ｶ
                console.warn('No shifts generated');
                this.showToast('逕滓・蜿ｯ閭ｽ縺ｪ繧ｷ繝輔ヨ縺後≠繧翫∪縺帙ｓ縺ｧ縺励◆縲ゅせ繧ｿ繝・ヵ縺ｮ險ｭ螳壹ｄ莨第嚊逕ｳ隲九ｒ遒ｺ隱阪＠縺ｦ縺上□縺輔＞縲・, 'warning');
                this._generationSuccess = false;
            } else {
                this._generationSuccess = false;
            }

        } catch (e) {
            console.error('AutoFill Error:', e);
            this._generationSuccess = false;
        } finally {
            // 繧ｿ繧､繝槭・蜈ｨ繧ｯ繝ｪ繧｢
            clearInterval(progressTimer);
            stepTimers.forEach(t => clearTimeout(t));
            if (this._tipTimer) { clearInterval(this._tipTimer); this._tipTimer = null; }

            // 譛菴手｡ｨ遉ｺ譎る俣繧貞ｾ・▽
            const elapsed = Date.now() - loadingStartTime;
            if (elapsed < MIN_LOADING_MS) {
                if (stepEl) stepEl.textContent = this._generationSuccess ? '繧ｷ繝輔ヨ縺ｮ譛邨ら｢ｺ隱堺ｸｭ...' : '蜃ｦ逅・ｒ螳御ｺ・＠縺ｦ縺・∪縺・..';
                if (barEl) barEl.style.width = '95%';
                await new Promise(r => setTimeout(r, MIN_LOADING_MS - elapsed));
            }

            // 100%縺ｫ縺励※縺九ｉ蟆代＠蠕・▽
            if (barEl) barEl.style.width = '100%';
            if (stepEl) stepEl.textContent = this._generationSuccess ? '螳御ｺ・＠縺ｾ縺励◆・・ : '蜃ｦ逅・′邨ゆｺ・＠縺ｾ縺励◆';
            if (tipEl) { tipEl.style.opacity = '0'; setTimeout(() => { tipEl.textContent = '繧ｫ繝ｬ繝ｳ繝繝ｼ縺ｫ蜿肴丐縺励∪縺・; tipEl.style.opacity = '1'; }, 200); }
            await new Promise(r => setTimeout(r, 1500));

            // 繝輔ぉ繝ｼ繝峨い繧ｦ繝・
            const loadingElFinal = document.getElementById('globalLoading');
            const loadingDefaultFinal = document.getElementById('loadingDefault');
            const loadingShiftGenFinal = document.getElementById('loadingShiftGen');

            if (loadingElFinal) { loadingElFinal.style.transition = 'opacity 0.6s'; loadingElFinal.style.opacity = '0'; }
            await new Promise(r => setTimeout(r, 600));

            if (loadingShiftGenFinal) loadingShiftGenFinal.style.display = 'none';
            if (loadingDefaultFinal) loadingDefaultFinal.style.display = 'flex';
            if (loadingElFinal) { loadingElFinal.classList.add('hidden'); loadingElFinal.style.opacity = ''; loadingElFinal.style.transition = ''; }

            // 繧ｫ繝ｬ繝ｳ繝繝ｼ譖ｴ譁ｰ
            this.renderCurrentView();
            this.calculateMonthlyStats();

            this._shiftGenInProgress = false;

            // 繝励Ξ繝薙Η繝ｼ繝｢繝ｼ繝繝ｫ繧定｡ｨ遉ｺ・育函謌先・蜉滓凾・・
            if (this._generationSuccess && this._pendingPreviewShifts && this._pendingPreviewShifts.length > 0) {
                setTimeout(() => {
                    this.showShiftPreview(this._pendingPreviewShifts, this._pendingPreviewTargetType, this._pendingPreviewDates);
                    this._pendingPreviewShifts = null;
                    this._pendingPreviewTargetType = null;
                    this._pendingPreviewDates = null;
                }, 300);
            } else if (!this._generationSuccess) {
                this.showToast('繧ｷ繝輔ヨ菴懈・縺ｫ蝠城｡後′縺ゅｊ縺ｾ縺励◆縲よ擅莉ｶ繧定ｦ狗峩縺励※縺上□縺輔＞縲・, 'warning');
            }
        }
    },


    // 荳諡ｬ菫晏ｭ・(螟ｧ驥上ョ繝ｼ繧ｿ縺ｮ菫晏ｭ・
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
            var obj = {
                organization_id: this.state.organization_id,
                staff_id: s.staff_id,
                date: s.date,
                start_time: s.start_time,
                end_time: s.end_time,
                break_minutes: s.break_minutes || 0
            };
            // 繧､繝ｬ繧ｮ繝･繝ｩ繝ｼ繝輔Λ繧ｰ縺後≠繧句ｴ蜷医・縺ｿ菫晏ｭ假ｼ磯壼ｸｸ繧ｷ繝輔ヨ縺ｧ縺ｯfalse/譛ｪ險ｭ螳夲ｼ・
            if (s.is_irregular) obj.is_irregular = true;
            return obj;
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





    async generateShiftsForDay(dateStr, existingShifts, generatedShiftsSoFar = []) {
        // ---------------------------------------------------------
        // 0. 譌･莉倥→險ｭ螳壹・蛻晄悄蛹・(蜴ｳ譬ｼ繝｢繝ｼ繝・
        // ---------------------------------------------------------
        const dateObj = new Date(dateStr.replace(/-/g, '/'));
        const dayOfWeek = dateObj.getDay(); // 0=Sun, 6=Sat
        const config = this.state.config;
        
        // 逾晄律蛻､螳・
        const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
        const isHoliday = jh ? jh.isHoliday(dateStr) : false;

        // 蝟ｶ讌ｭ譎る俣縺ｮ豎ｺ螳・
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

        // 譎る俣螟画鋤繝倥Ν繝代・ (蛻・腰菴・
        const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const fromMins = (m) => { 
            let h = Math.floor(m / 60); 
            let min = m % 60;
            // 24譎る俣陦ｨ險俶ｭ｣隕丞喧
            if (h >= 24) h -= 24;
            return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        };

        const startMins = toMins(openTime);
        const endMins = toMins(closeTime);
        // 譌･縺ｾ縺溘℃蟇ｾ蠢・(close < open 縺ｪ繧・+24h)
        const effectiveEndMins = endMins < startMins ? endMins + (24 * 60) : endMins;

        // ---------------------------------------------------------
        // 1. 蠢・ｦ∽ｺｺ謨ｰ縺ｮ邂怜・ (15蛻・綾縺ｿ繝舌こ繝・ヨ)
        // ---------------------------------------------------------
        const timeReqs = new Map(); // key: minutes, val: count
        const timeReqManager = new Map(); // key: minutes, val: count (1 or 0)

        // 繝吶・繧ｹ隕∽ｻｶ
        let baseReq = 2;
        const sReq = config.staff_req || {};
        if (isHoliday) baseReq = sReq.min_holiday || 3;
        else if (dayOfWeek === 0 || dayOfWeek === 6) baseReq = sReq.min_weekend || 3;
        else baseReq = sReq.min_weekday || 2;
        
        const reqManager = sReq.min_manager || 1;

        // 蜈ｨ繧ｹ繝ｭ繝・ヨ蛻晄悄蛹・(15蛻・綾縺ｿ)
        for (let t = startMins; t < effectiveEndMins; t += 15) {
            timeReqs.set(t, Number(baseReq));
            timeReqManager.set(t, Number(reqManager));
        }

        // 譎る俣蟶ｯ蛻･繝ｫ繝ｼ繝ｫ縺ｮ驕ｩ逕ｨ (time_staff_req)・・ays驟榊・縺ｮ蝙九ｒ謨ｰ蛟､縺ｫ邨ｱ荳・・
        const timeRules = (config.time_staff_req || []).filter(r => (r.days || []).map(Number).includes(dayOfWeek));
        timeRules.forEach(rule => {
            const rStart = toMins(rule.start);
            let rEnd = toMins(rule.end);
            if (rEnd < rStart) rEnd += 24*60;
            
            for (let t = startMins; t < effectiveEndMins; t += 15) {
                // 繝ｫ繝ｼ繝ｫ譛滄俣蜀・° (邨ｶ蟇ｾ蛟､ or 譌･縺ｾ縺溘℃閠・・)
                // 邁｡譏灘愛螳壹→縺励※縲√す繝輔ヨ逕滓・譌･(蠖捺律)縺ｮ蝟ｶ讌ｭ遽・峇蜀・〒縲√Ν繝ｼ繝ｫ縺ｮ髢句ｧ九懃ｵゆｺ・↓蜷郁・縺吶ｋ縺・
                
                // 窶ｻ譌･縺ｾ縺溘℃蜷悟｣ｫ縺ｮ蜴ｳ蟇・愛螳壹・隍・尅縺縺後√％縺薙〒縺ｯ縲悟霧讌ｭ譌･縲阪→縺・≧讎ょｿｵ蜀・・邨ｶ蟇ｾ蛻・〒豈碑ｼ・☆繧・
                // rule.start 縺・"22:00"(1320), rule.end 縺・"02:00"(1560)
                // t 縺・"23:00"(1380) 縺ｪ繧臥ｯ・峇蜀・・
                // 蝟ｶ讌ｭ譎る俣縺・"18:00"(1080) ~ "26:00"(1560) 縺ｧ縺ゅｌ縺ｰ縲》=1380 縺ｯ遽・峇蜀・・
                
                // 縺溘□縺励〉ule.start 縺・"01:00"(60) 縺ｧ rule.end 縺・"02:00"(120) 縺ｮ蝣ｴ蜷茨ｼ域ｷｱ螟懊・縺ｿ謖・ｮ夲ｼ・
                // 蝟ｶ讌ｭ譎る俣縺梧ｷｱ螟懊↓蜿翫・蝣ｴ蜷医》=60 縺ｯ "鄙梧律縺ｮ01:00" 繧呈欠縺吝庄閭ｽ諤ｧ縺後≠繧九・
                // startMins縺・40(9:00)縺ｧeffectiveEndMins縺・320(22:00)縺ｪ繧峨》=60縺ｯ蟄伜惠縺励↑縺・・
                // startMins縺・080(18:00)縺ｧeffectiveEndMins縺・560(26:00)縺ｪ繧峨》=1500(25:00=01:00)縺悟ｭ伜惠縺吶ｋ縲・
                // 蜈･蜉帙＆繧後◆ rule.start(01:00) 繧偵←縺・ｧ｣驥医☆繧九°・・
                // 騾壼ｸｸ縲√悟霧讌ｭ譎る俣蜀・・ 01:00縲阪→縺ｿ縺ｪ縺吶∋縺阪・
                // => t 繧・24h豁｣隕丞喧縺励◆蛟､ (t % 1440) 縺ｨ rule縺ｮ譎ょ綾繧呈ｯ碑ｼ・☆繧具ｼ・
                
                // 縺薙％縺ｧ縺ｯ繧ｷ繝ｳ繝励Ν縺ｫ縲〉ule繧らｵｶ蟇ｾ蛻・startMins蝓ｺ貅・縺ｫ螟画鋤縺ｧ縺阪ｌ縺ｰ繝吶せ繝医□縺後・
                // rule縺ｯ縺溘□縺ｮ譎ょ綾譁・ｭ怜・縲・
                // 縲碁幕蟋区凾蛻ｻ >= rule.start && 髢句ｧ区凾蛻ｻ < rule.end縲・
                
                // A. rule縺梧律縺ｾ縺溘℃縺ｧ縺ｪ縺・(11:00-14:00)
                // B. rule縺梧律縺ｾ縺溘℃ (22:00-02:00)
                
                // t縺ｮ譎ょ綾陦ｨ迴ｾ
                const tMod = t % 1440;
                
                let inRule = false;
                if (rStart < rEnd) {
                    // 騾壼ｸｸ
                    inRule = (tMod >= rStart && tMod < rEnd);
                } else {
                    // 譌･縺ｾ縺溘℃ (22:00 <= t < 24:00 OR 00:00 <= t < 02:00)
                    inRule = (tMod >= rStart || tMod < rEnd);
                }
                
                // 縺輔ｉ縺ｫ縲》閾ｪ菴薙′縲悟霧讌ｭ髢句ｧ句燕縲阪・豺ｱ螟懶ｼ域掠譛晢ｼ峨〒縺ｪ縺・％縺ｨ縺ｮ菫晁ｨｼ縺悟ｿ・ｦ√□縺後・
                // loop遽・峇縺・startMins縲彳ffectiveEndMins 縺ｪ縺ｮ縺ｧOK縲・
                
                if (inRule) {
                    const current = timeReqs.get(t) || 0;
                    timeReqs.set(t, Math.max(current, Number(rule.count)));
                }
            }
        });

        // ---------------------------------------------------------
        // 2. 迴ｾ蝨ｨ縺ｮ蜈・ｶｳ迥ｶ豕√・繝・・菴懈・
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
        // 3. 謇ｿ隱肴ｸ医∩繧ｷ繝輔ヨ縺ｮ驕ｩ逕ｨ (Requests)
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
        // 4. 繧ｹ繧ｿ繝・ヵ繝ｪ繧ｹ繝医・貅門ｙ (繝ｩ繝ｳ繧ｯ鬆・A>B>C)
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
        // 5. 荳崎ｶｳ蛻・・蜈・｡ｫ (Gap Filling) - 蠑ｷ蛹也沿
        // ---------------------------------------------------------
        const ignoredSlots = new Set(); // 蝓九ａ繧峨ｌ縺ｪ縺九▲縺溘せ繝ｭ繝・ヨ繧定ｨ俶・縺励※辟｡髯舌Ν繝ｼ繝怜屓驕ｿ

        // 繝ｫ繝ｼ繝怜・逅・(譛螟ｧ100繝代せ)
        for (let pass = 0; pass < 100; pass++) {
            const { coverage, managerCoverage } = getCoverage();
            
            // 荳崎ｶｳ繧ｹ繝ｭ繝・ヨ謗｢邏｢
            let deficitSlot = -1;
            let missingType = null;

            for (let t = startMins; t < effectiveEndMins; t += 15) {
                if (ignoredSlots.has(t)) continue; // 隲ｦ繧√◆繧ｹ繝ｭ繝・ヨ縺ｯ繧ｹ繧ｭ繝・・

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

            if (deficitSlot === -1) break; // 蜈ｨ蜈・ｶｳ (縺ｾ縺溘・蜈ｨ縺ｦ隲ｦ繧√◆)

            let shiftAddedOrExtended = false;
            
            const targetEnd = Math.min(deficitSlot + 480, effectiveEndMins); // 蝓ｺ譛ｬ縺ｯ+8譎る俣
            const reqTimeRange = { start: fromMins(deficitSlot), end: fromMins(targetEnd) };
            const roleFilter = missingType === 'manager' ? (s) => (s.role === 'manager' || s.role === 'leader') : null;

            // =========================================================
            // 謌ｦ逡･1: 譌｢蟄倥す繝輔ヨ縺ｮ蟒ｶ髟ｷ (騾壼ｸｸ譎る俣蜀・
            // =========================================================
            for (const s of currentDayNewShifts) {
                const sEnd = toMins(s.end_time) + (s.end_time < s.start_time ? 24*60 : 0);
                
                // 繧ｮ繝｣繝・・縺・0蛻・ｻ･蜀・↑繧臥ｵ仙粋蟇ｾ雎｡
                if (sEnd <= deficitSlot && (deficitSlot - sEnd) <= 60) {
                    const staff = this.getStaff(s.staff_id);
                    if (roleFilter && !roleFilter(staff)) continue;

                    const maxMins = (Number(staff.max_hours_day) || 8) * 60;
                    // 蟒ｶ髟ｷ蠕後・邨ゆｺ・凾髢・(譛菴弱〒繧Ｅeficit繧貞沂繧√ｋ縺溘ａ縺ｫ+3h)
                    const newEndMins = Math.min(deficitSlot + 180, effectiveEndMins);
                    const sStart = toMins(s.start_time);
                    const newDurMins = newEndMins - sStart;

                    // 騾壼ｸｸ荳企剞蜀・〒縺ゅｌ縺ｰ蟒ｶ髟ｷ
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
            // 謌ｦ逡･2: 譁ｰ隕上す繝輔ヨ霑ｽ蜉 (騾壼ｸｸ譎る俣蜀・
            // =========================================================
            let candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { timeRange: reqTimeRange });
            
            if (candidate) {
                const maxH = Number(candidate.max_hours_day) || 8;
                const dur = Math.min(480, maxH * 60);
                const endT = Math.min(deficitSlot + dur, effectiveEndMins);
                // 繧ｪ繝ｼ繝舌・繧ｿ繧､繝險ｱ蜿ｯ縺ｪ縺・隨ｬ4蠑墓焚逵∫払)縺ｧ菴懈・
                const newShift = this.createShiftObject(candidate.id, dateStr, fromMins(deficitSlot), fromMins(endT));
                currentDayNewShifts.push(newShift);
                shiftAddedOrExtended = true;
                continue;
            }

            // =========================================================
            // 謌ｦ逡･3: 譌｢蟄倥す繝輔ヨ縺ｮ蟒ｶ髟ｷ (谿区･ｭ +3h險ｱ螳ｹ)
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
            // 謌ｦ逡･4: 譁ｰ隕上す繝輔ヨ霑ｽ蜉 (邱頑･繝｢繝ｼ繝・ 騾ｱ蛻ｶ髯千┌隕・& 谿区･ｭ險ｱ螳ｹ)
            // =========================================================
            // 縺ｾ縺夐ｱ蛻ｶ髯舌□縺醍┌隕悶＠縺ｦ謗｢縺・
            candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { timeRange: reqTimeRange, ignoreWeekLimit: true });
            
            // 縺昴ｌ縺ｧ繧ゅ＞縺ｪ縺代ｌ縺ｰ縲・㍾隍・ｻ･螟悶↑繧薙〒繧ゅ≠繧・(Manager谺蜩｡縺ｪ縺ｩ豺ｱ蛻ｻ縺ｪ蝣ｴ蜷・
            if (!candidate) {
                 candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { 
                     timeRange: reqTimeRange, ignoreWeekLimit: true, ignoreOverlap: false 
                 });
            }

            if (candidate) {
                const maxH = Number(candidate.max_hours_day) || 8;
                // 邱頑･譎ゅ・+3h縺ｾ縺ｧ險ｱ螳ｹ
                const limitMins = Math.min((maxH + 3) * 60, 660);
                const dur = Math.min(480, limitMins);
                const endT = Math.min(deficitSlot + dur, effectiveEndMins);
                
                // createShiftObject縺ｫ繧ｪ繝ｼ繝舌・繧ｿ繧､繝險ｱ蜿ｯ繝輔Λ繧ｰ(true)繧呈ｸ｡縺・
                const newShift = this.createShiftObject(candidate.id, dateStr, fromMins(deficitSlot), fromMins(endT), true);
                currentDayNewShifts.push(newShift);
                shiftAddedOrExtended = true;
                continue;
            }

            // 謇玖ｩｰ縺ｾ繧・
            if (!shiftAddedOrExtended) {
                ignoredSlots.add(deficitSlot);
            }
        }

        return currentDayNewShifts;
    },

    findAvailableStaff(staffList, dateStr, allShiftsContext, filterFn = null, options = {}) {
        const { ignoreWeekLimit = false, timeRange = null } = options;
        
        // 譌･莉倡ｯ・峇險育ｮ・
        const dateObj = new Date(dateStr.replace(/-/g, '/'));
        const day = dateObj.getDay();
        const startOfWeek = new Date(dateObj);
        startOfWeek.setDate(dateObj.getDate() - day);
        const formatYMD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const startStr = formatYMD(startOfWeek);
        const endStr = formatYMD(new Date(startOfWeek.getTime() + 6*24*60*60*1000));

        // 譎る俣螟画鋤
        const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

        for (const staff of staffList) {
            // 蝓ｺ譛ｬ繝輔ぅ繝ｫ繧ｿ繝ｼ
            if (filterFn && !filterFn(staff)) continue;

            // 1. 莨代∩蟶梧悍繝√ぉ繝・け
            const isOff = this.state.requests.some(r => 
                r.staff_id === staff.id && r.dates === dateStr && (r.type === 'off' || r.type === 'holiday') && r.status === 'approved'
            );
            if (isOff && !ignoreWeekLimit) continue; 

            // 2. 驥崎､・メ繧ｧ繝・け & 蜍､蜍呎凾髢・
            const dailyShifts = allShiftsContext.filter(s => s.staff_id === staff.id && s.date === dateStr);
            
            if (timeRange) {
                const newStart = toMins(timeRange.start);
                let newEnd = toMins(timeRange.end);
                if (newEnd < newStart) newEnd += 24*60;

                // 譎る俣陲ｫ繧・
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

            // 3. 蜍､蜍呎凾髢謎ｸ企剞 (譌･) - 譌｢蟄倥す繝輔ヨ + 譁ｰ隕・
            const maxMins = (Number(staff.max_hours_day) || 8) * 60;
            const limitMins = ignoreWeekLimit ? Math.min(maxMins + 180, 660) : maxMins; 
            
            const currentMins = dailyShifts.reduce((acc, s) => {
                 const sStart = toMins(s.start_time);
                 let sEnd = toMins(s.end_time);
                 if (sEnd < sStart) sEnd += 24*60;
                 return acc + (sEnd - sStart);
            }, 0);
            
            let newDur = 180; // 莉ｮ
            if (timeRange) {
                const ns = toMins(timeRange.start);
                let ne = toMins(timeRange.end);
                if (ne < ns) ne += 24*60;
                newDur = ne - ns;
            }
            
            if (currentMins + newDur > limitMins) continue;

            // 4. 騾ｱ蜍､蜍呎律謨ｰ繝√ぉ繝・け
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
            // 繝繝溘・繧定ｿ斐＠縺ｦ繧ｨ繝ｩ繝ｼ繧帝亟縺舌′縲∽ｿ晏ｭ俶凾縺ｫ髯､螟悶＆繧後ｋ繧医≧縺ｫ縺吶ｋ・医≠繧九＞縺ｯ繝舌Μ繝・・繧ｷ繝ｧ繝ｳ縺ｧ蠑ｾ縺擾ｼ・
            return { staff_id: staffId, date, start_time: start || '00:00', end_time: end || '00:00', break_minutes: 0, _invalid: true };
        }

        // --- 繧ｹ繧ｿ繝・ヵ縺ｮ蜍､蜍呎凾髢薙ｒ蜴ｳ譬ｼ縺ｫ螳医ｋ縺溘ａ縺ｮ繝輔ぃ繧､繝､繝ｼ繧ｦ繧ｩ繝ｼ繝ｫ ---
        const staff = this.getStaff(staffId);
        let maxHours = (staff && staff.max_hours_day) ? Number(staff.max_hours_day) : 8;
        
        // 繧ｪ繝ｼ繝舌・繧ｿ繧､繝險ｱ蜿ｯ譎ゅ・譛螟ｧ11譎る俣縺ｾ縺ｧ諡｡蠑ｵ
        if (allowOvertime) {
            maxHours = Math.min(maxHours + 3, 11);
        }

        let startDate = new Date(`2000-01-01T${start}`);
        let endDate = new Date(`2000-01-01T${end}`);
        // 譌･莉倥∪縺溘℃蟇ｾ蠢・
        if (endDate < startDate) {
            endDate.setDate(endDate.getDate() + 1);
        }

        let duration = (endDate - startDate) / 3600000;

        // 譛螟ｧ蜍､蜍呎凾髢薙ｒ雜・∴縺ｦ縺・ｋ蝣ｴ蜷医∝ｼｷ蛻ｶ逧・↓遏ｭ邵ｮ縺吶ｋ
        if (duration > maxHours) {
            // 遏ｭ邵ｮ繝ｭ繧ｸ繝・け:
            // 蝓ｺ譛ｬ逧・↓縺ｯ縲檎ｵゆｺ・凾髢薙ｒ譌ｩ繧√ｋ縲阪％縺ｨ縺ｧ隱ｿ謨ｴ縺吶ｋ縲・
            // 縺溘□縺励∝・縺ｮ繧ｷ繝輔ヨ縺後碁≦逡ｪ・井ｾ・ 17-22・峨阪・繧医≧縺ｪ蝣ｴ蜷医・
            // 縲・7-20 (譌ｩ荳翫′繧・縲阪↓縺吶ｋ縺九・9-22 (驕・・繧・縲阪↓縺吶ｋ縺九・譁・ц縺ｫ繧医ｋ縲・
            // 縺薙％縺ｧ縺ｯ螳牙・遲悶→縺励※縲檎ｵゆｺ・凾髢薙ｒ蝓ｺ貅悶阪↓隱ｿ謨ｴ・磯≦蜈･繧奇ｼ峨☆繧九Ο繧ｸ繝・け繧呈治逕ｨ縺吶ｋ繧ｱ繝ｼ繧ｹ繧り・・縺励◆縺・′縲・
            // 譛繧よｱ守畑逧・↑縺ｮ縺ｯ縲碁幕蟋区凾髢薙ｒ邯ｭ謖√＠縺ｦ譌ｩ荳翫′繧翫阪＆縺帙ｋ縺薙→縺ｧ縺ゅｋ縲・
            // 縺励°縺励√Θ繝ｼ繧ｶ繝ｼ縺ｮ闍ｦ諠・・7-22繧ｷ繝輔ヨ縲阪↓蟇ｾ縺励・譎る俣蛻ｶ髯舌阪′縺ゅｋ蝣ｴ蜷医・
            // 17-20縺ｫ縺ｪ繧九・縺瑚・辟ｶ縲・
            
            // 萓句､門ｯｾ蠢・ 繧ゅ＠繧ｷ繝輔ヨ縺後悟ｺ苓・縺ｮ髢牙ｺ玲凾髢・config.closing_time)縲阪→荳閾ｴ縺励※邨ゅｏ繧句ｴ蜷医・
            // 縲後Λ繧ｹ繝医∪縺ｧ縲阪→縺・≧諢丞袖蜷医＞縺悟ｼｷ縺・◆繧√√碁幕蟋区凾髢薙ｒ驕・ｉ縺帙ｋ縲阪⊇縺・′驕ｩ蛻・°繧ゅ＠繧後↑縺・・
            // 縺後…onfig縺ｸ縺ｮ繧｢繧ｯ繧ｻ繧ｹ縺瑚､・尅縺ｫ縺ｪ繧九◆繧√√％縺薙〒縺ｯ繧ｷ繝ｳ繝励Ν縺ｫ
            // 縲碁幕蟋区凾髢薙ｒ邯ｭ謖√＠縲∫ｵゆｺ・凾髢薙ｒmaxHours蠕後↓險ｭ螳壹☆繧九肴婿蠑上〒邨ｱ荳縺励・
            // 邨ｶ蟇ｾ縺ｫmaxHours繧定ｶ・∴縺ｪ縺・％縺ｨ繧剃ｿ晁ｨｼ縺吶ｋ縲・
            
            // 繧ゅ＠蜻ｼ縺ｳ蜃ｺ縺怜・縺ｧ縲碁≦逡ｪ縺縺九ｉ驕・￥蟋九ａ縺ｦ縺ｻ縺励＞縲榊ｴ蜷医・縲・
            // 蜻ｼ縺ｳ蜃ｺ縺怜・縺ｧ譎る俣繧定ｨ育ｮ励＠縺ｦ貂｡縺吶∋縺阪〒縺ゅｋ縲・
            // 縺薙％縺ｯ縲梧怙邨る亟陦帙Λ繧､繝ｳ縲阪→縺励※讖溯・縺輔○繧九・

            const newEndMillis = startDate.getTime() + (maxHours * 3600000);
            endDate = new Date(newEndMillis);
            
            // end譁・ｭ怜・繧貞・逕滓・ (HH:mm)
            end = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`;
            
            // 蜀崎ｨ育ｮ・
            duration = maxHours;
        }

        let breakMins = 0;
        // 險ｭ螳壹＆繧後◆莨第・繝ｫ繝ｼ繝ｫ繧帝←逕ｨ
        const rules = this.state.config.break_rules || this.state.defaultConfig.break_rules;
        // 髯埼・↓繧ｽ繝ｼ繝医＠縺ｦ縲∵怙螟ｧ縺ｮ譚｡莉ｶ縺ｫ蜷郁・縺吶ｋ繧ゅ・繧帝←逕ｨ
        const sortedRules = [...rules].sort((a,b) => b.min_hours - a.min_hours);
        
        for(const rule of sortedRules) {
            if(duration >= rule.min_hours) {
                breakMins = rule.break_minutes;
                break;
            }
        }
        
        return { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins };
    },

    // --- 繝槭ル繝･繧｢繝ｫ ---
    renderManual(container) {
        if (!this.state.isAdmin) { this.changeView('dashboard'); return; }
        container.innerHTML = `
        <div class="max-w-4xl mx-auto space-y-6 pb-20">
            <h2 class="text-2xl font-bold text-gray-800"><i class="fa-solid fa-book mr-2 text-indigo-500"></i>繧ｷ繧ｹ繝・Β繝槭ル繝･繧｢繝ｫ</h2>

            <!-- 逶ｮ谺｡ -->
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="font-bold text-gray-800 mb-3">逶ｮ谺｡</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                    <a href="#m-important" class="text-red-600 hover:underline font-bold">笞 險ｭ螳壹・驥崎ｦ∵ｧ</a>
                    <a href="#m-roles" class="text-indigo-600 hover:underline">1. 蠖ｹ閨ｷ繝ｻ繝ｭ繝ｼ繝ｫ</a>
                    <a href="#m-eval" class="text-indigo-600 hover:underline">2. 繧ｹ繧ｿ繝・ヵ隧穂ｾ｡ (A縲廛)</a>
                    <a href="#m-shift" class="text-indigo-600 hover:underline">3. AI繧ｷ繝輔ヨ菴懈・</a>
                    <a href="#m-labor" class="text-indigo-600 hover:underline">4. 蜉ｴ蜒榊渕貅匁ｳ輔Ν繝ｼ繝ｫ</a>
                    <a href="#m-break" class="text-indigo-600 hover:underline">5. 莨第・繝ｫ繝ｼ繝ｫ</a>
                    <a href="#m-request" class="text-indigo-600 hover:underline">6. 莨代∩蟶梧悍</a>
                    <a href="#m-settings" class="text-indigo-600 hover:underline">7. 蠎苓・險ｭ螳・/a>
                    <a href="#m-plan" class="text-indigo-600 hover:underline">8. 繝励Λ繝ｳ繝ｻ隱ｲ驥・/a>
                    <a href="#m-auth" class="text-indigo-600 hover:underline">9. 讓ｩ髯・(邂｡逅・・繧ｹ繧ｿ繝・ヵ)</a>
                    <a href="#m-analytics" class="text-indigo-600 hover:underline">10. 蛻・梵繝ｻ繝ｬ繝昴・繝・/a>
                    <a href="#m-other" class="text-indigo-600 hover:underline">11. 縺昴・莉匁ｩ溯・</a>
                </div>
            </div>

            <!-- 險ｭ螳壹・驥崎ｦ∵ｧ -->
            <div id="m-important" class="bg-gradient-to-r from-red-50 to-orange-50 rounded-xl shadow-sm border-2 border-red-300 p-6">
                <h3 class="text-lg font-bold text-red-700 mb-3"><i class="fa-solid fa-triangle-exclamation mr-2"></i>險ｭ螳壹・驥崎ｦ∵ｧ 窶・AI繧ｷ繝輔ヨ邊ｾ蠎ｦ繧呈怙螟ｧ蛹悶☆繧九◆繧√↓</h3>
                <div class="bg-white/80 rounded-lg p-4 mb-4">
                    <p class="text-sm text-gray-800 font-bold mb-2">繝ｩ繧ｯ繧ｷ繝輔ヨAI縺ｮ繧ｷ繝輔ヨ邊ｾ蠎ｦ縺ｯ縲瑚ｨｭ螳壹・豁｣遒ｺ縺輔阪↓逶ｴ邨舌＠縺ｾ縺吶・/p>
                    <p class="text-sm text-gray-600">AI縺ｯ險ｭ螳壹＆繧後◆諠・ｱ縺縺代ｒ蜈・↓譛驕ｩ縺ｪ繧ｷ繝輔ヨ繧堤ｵ・∩縺ｾ縺吶りｨｭ螳壹′荳榊香蛻・□縺ｨ縲∝￥縺｣縺滄・鄂ｮ繧・ｩｴ謚懊￠縺ｮ蜴溷屏縺ｫ縺ｪ繧翫∪縺吶ゆｻ･荳九・險ｭ螳壹ｒ蠢・★遒ｺ隱阪＠縺ｦ縺上□縺輔＞縲・/p>
                </div>

                <div class="space-y-4">
                    <div class="bg-white rounded-lg p-4 border border-orange-200">
                        <h4 class="font-bold text-orange-700 mb-2"><i class="fa-solid fa-user-gear mr-1"></i>繧ｹ繧ｿ繝・ヵ險ｭ螳夲ｼ域怙驥崎ｦ・ｼ・/h4>
                        <table class="w-full text-sm border-collapse">
                            <thead><tr class="bg-orange-50"><th class="p-2 text-left border">險ｭ螳夐・岼</th><th class="p-2 text-left border">隱ｬ譏・/th><th class="p-2 text-left border">譛ｪ險ｭ螳壽凾縺ｮ蠖ｱ髻ｿ</th></tr></thead>
                            <tbody>
                                <tr><td class="p-2 border font-bold">騾ｱ譛螟ｧ蜃ｺ蜍､譌･謨ｰ</td><td class="p-2 border">1騾ｱ髢薙↓譛螟ｧ菴墓律蜒阪￠繧九°</td><td class="p-2 border text-red-600">繝・ヵ繧ｩ繝ｫ繝・譌･縺ｫ縺ｪ繧翫√ヰ繧､繝医↓驕主臆驟咲ｽｮ縺輔ｌ繧・/td></tr>
                                <tr><td class="p-2 border font-bold">騾ｱ譛菴主・蜍､譌･謨ｰ</td><td class="p-2 border">1騾ｱ髢薙↓譛菴惹ｽ墓律縺ｯ蜈･繧翫◆縺・°</td><td class="p-2 border text-red-600">0譌･謇ｱ縺・〒繧ｷ繝輔ヨ縺ｫ蜈･繧峨↑縺・ｴ蜷医′縺ゅｋ</td></tr>
                                <tr><td class="p-2 border font-bold">1譌･縺ｮ譛螟ｧ蜉ｴ蜒肴凾髢・/td><td class="p-2 border">1譌･縺ｫ譛螟ｧ菴墓凾髢灘ロ縺代ｋ縺・/td><td class="p-2 border text-red-600">8譎る俣謇ｱ縺・〒遏ｭ譎る俣繝舌う繝医′髟ｷ譎る俣繧ｷ繝輔ヨ縺ｫ蜈･繧・/td></tr>
                                <tr><td class="p-2 border font-bold">蠖ｹ閨ｷ</td><td class="p-2 border">蠎鈴聞/繝ｪ繝ｼ繝繝ｼ/繧ｹ繧ｿ繝・ヵ/譁ｰ莠ｺ</td><td class="p-2 border text-red-600">OJT蛻ｶ邏・ｄ繝｡繝ｳ繧ｿ繝ｼ驟咲ｽｮ縺梧ｩ溯・縺励↑縺・/td></tr>
                                <tr><td class="p-2 border font-bold">隧穂ｾ｡ (A縲廛)</td><td class="p-2 border">繧ｹ繧ｭ繝ｫ繝ｬ繝吶Ν</td><td class="p-2 border text-red-600">繝√・繝謌ｦ蜉帙ヰ繝ｩ繝ｳ繧ｹ縺悟￥繧・/td></tr>
                                <tr><td class="p-2 border font-bold">邨ｦ荳主ｽ｢諷・/td><td class="p-2 border">譛育ｵｦ蛻ｶ or 譎らｵｦ蛻ｶ</td><td class="p-2 border text-red-600">譛育ｵｦ繧ｹ繧ｿ繝・ヵ縺悟━蜈磯・鄂ｮ縺輔ｌ縺壻ｺｺ莉ｶ雋ｻ縺悟｢怜､ｧ</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="bg-white rounded-lg p-4 border border-blue-200">
                        <h4 class="font-bold text-blue-700 mb-2"><i class="fa-solid fa-store mr-1"></i>蠎苓・險ｭ螳夲ｼ磯㍾隕・ｼ・/h4>
                        <table class="w-full text-sm border-collapse">
                            <thead><tr class="bg-blue-50"><th class="p-2 text-left border">險ｭ螳夐・岼</th><th class="p-2 text-left border">隱ｬ譏・/th><th class="p-2 text-left border">譛ｪ險ｭ螳壽凾縺ｮ蠖ｱ髻ｿ</th></tr></thead>
                            <tbody>
                                <tr><td class="p-2 border font-bold">蝟ｶ讌ｭ譎る俣・域屆譌･蛻･・・/td><td class="p-2 border">蟷ｳ譌･/蝨滓律/逾晄律縺ｮ髢句ｺ励・髢牙ｺ玲凾髢・/td><td class="p-2 border text-red-600">髢牙ｺ怜ｾ後・譎る俣蟶ｯ縺ｫ繧ゆｺｺ蜩｡驟咲ｽｮ縺輔ｌ繧・/td></tr>
                                <tr><td class="p-2 border font-bold">蠢・ｦ∽ｺｺ蜩｡・域屆譌･蛻･・・/td><td class="p-2 border">蟷ｳ譌･/蝨滓律/逾晄律縺ｮ譛菴朱・鄂ｮ莠ｺ謨ｰ</td><td class="p-2 border text-red-600">莠ｺ謇倶ｸ崎ｶｳ繝ｻ驕主臆驟咲ｽｮ縺檎匱逕溘☆繧・/td></tr>
                                <tr><td class="p-2 border font-bold">繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ</td><td class="p-2 border">譌ｩ逡ｪ/驕・分遲峨・譎る俣繝・Φ繝励Ξ繝ｼ繝・/td><td class="p-2 border text-red-600">蜈ｨ蜩｡縺悟酔縺俶凾髢灘ｸｯ縺ｫ髮・ｸｭ縺吶ｋ</td></tr>
                                <tr><td class="p-2 border font-bold">螳壻ｼ第律</td><td class="p-2 border">譖懈律繝吶・繧ｹ縺ｮ莨第･ｭ譌･</td><td class="p-2 border text-red-600">莨第･ｭ譌･縺ｫ繧ｷ繝輔ヨ縺碁・鄂ｮ縺輔ｌ繧・/td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="bg-green-50 rounded-lg p-4 border border-green-300">
                        <h4 class="font-bold text-green-700 mb-2"><i class="fa-solid fa-lightbulb mr-1"></i>AI邊ｾ蠎ｦ繧呈怙螟ｧ蛹悶☆繧九さ繝・/h4>
                        <ul class="text-sm text-gray-700 space-y-1">
                            <li>笨・<strong>蜈ｨ繧ｹ繧ｿ繝・ヵ縺ｮ蜍､蜍吝宛邏・ｒ豁｣遒ｺ縺ｫ蜈･蜉・/strong>縺吶ｋ・磯ｱ譛螟ｧ/譛菴取律謨ｰ縲・譌･譛螟ｧ譎る俣・・/li>
                            <li>笨・<strong>譛育ｵｦ蛻ｶ/譎らｵｦ蛻ｶ繧呈ｭ｣縺励￥險ｭ螳・/strong>縺吶ｋ 竊・譛育ｵｦ繧ｹ繧ｿ繝・ヵ縺悟━蜈磯・鄂ｮ縺輔ｌ莠ｺ莉ｶ雋ｻ縺梧怙驕ｩ蛹悶＆繧後ｋ</li>
                            <li>笨・<strong>蝟ｶ讌ｭ譎る俣繧呈屆譌･蛻･縺ｫ險ｭ螳・/strong>縺吶ｋ 竊・蝨滓律縺ｮ遏ｭ邵ｮ蝟ｶ讌ｭ遲峨′豁｣遒ｺ縺ｫ蜿肴丐縺輔ｌ繧・/li>
                            <li>笨・<strong>繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ繧・縺､莉･荳顔匳骭ｲ</strong>縺吶ｋ 竊・AI縺瑚・蜍慕噪縺ｫ荳ｭ逡ｪ繧ら函謌・/li>
                            <li>笨・<strong>蠢・ｦ∽ｺｺ蜩｡繧呈屆譌･蛻･縺ｫ險ｭ螳・/strong>縺吶ｋ 竊・蟷ｳ譌･縺ｨ蝨滓律縺ｮ驟咲ｽｮ繝舌Λ繝ｳ繧ｹ縺梧怙驕ｩ蛹悶＆繧後ｋ</li>
                            <li>笨・<strong>蠖ｹ閨ｷ縺ｨ隧穂ｾ｡繧呈ｭ｣縺励￥險ｭ螳・/strong>縺吶ｋ 竊・繝√・繝邱ｨ謌舌・雉ｪ縺悟髄荳翫☆繧・/li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 1. 蠖ｹ閨ｷ -->
            <div id="m-roles" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">1.</span>蠖ｹ閨ｷ繝ｻ繝ｭ繝ｼ繝ｫ</h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">蠖ｹ閨ｷ</th><th class="p-2 text-left border">蠖ｹ蜑ｲ</th><th class="p-2 text-left border">繧ｷ繝輔ヨ逕滓・縺ｸ縺ｮ蠖ｱ髻ｿ</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border font-bold">蠎鈴聞 (Manager)</td><td class="p-2 border">譛鬮俶ｨｩ髯舌√Γ繝ｳ繧ｿ繝ｼ蠖ｹ</td><td class="p-2 border">豈主霧讌ｭ譌･縺ｫ譛菴・蜷埼・鄂ｮ蠢・・/td></tr>
                        <tr><td class="p-2 border font-bold">繝ｪ繝ｼ繝繝ｼ (Leader)</td><td class="p-2 border">蜑ｯ邂｡逅・・√Γ繝ｳ繧ｿ繝ｼ蠖ｹ</td><td class="p-2 border">蠎鈴聞縺ｨ蜷梧ｧ倥Γ繝ｳ繧ｿ繝ｼ譫縺ｫ繧ｫ繧ｦ繝ｳ繝・/td></tr>
                        <tr><td class="p-2 border font-bold">繧ｹ繧ｿ繝・ヵ (Staff)</td><td class="p-2 border">荳闊ｬ繧ｹ繧ｿ繝・ヵ</td><td class="p-2 border">騾壼ｸｸ驟咲ｽｮ</td></tr>
                        <tr><td class="p-2 border font-bold">譁ｰ莠ｺ (Rookie)</td><td class="p-2 border">遐比ｿｮ荳ｭ</td><td class="p-2 border">蠢・★繝｡繝ｳ繧ｿ繝ｼ・亥ｺ鈴聞/繝ｪ繝ｼ繝繝ｼ・峨→蜷梧律驟咲ｽｮ</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 2. 隧穂ｾ｡ -->
            <div id="m-eval" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">2.</span>繧ｹ繧ｿ繝・ヵ隧穂ｾ｡ (A縲廛)</h3>
                <p class="text-sm text-gray-600 mb-3">隧穂ｾ｡縺ｯAI繧ｷ繝輔ヨ逕滓・譎ゅ・繝√・繝邱ｨ謌舌・驟咲ｽｮ蜆ｪ蜈亥ｺｦ縺ｫ蠖ｱ髻ｿ縺励∪縺吶・/p>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">隧穂ｾ｡</th><th class="p-2 text-left border">諢丞袖</th><th class="p-2 text-left border">謌ｦ蜉帙せ繧ｳ繧｢</th><th class="p-2 text-left border">蠖ｱ髻ｿ</th></tr></thead>
                    <tbody>
                        <tr class="bg-yellow-50"><td class="p-2 border font-bold text-yellow-700">A</td><td class="p-2 border">蜆ｪ遘</td><td class="p-2 border">3.0</td><td class="p-2 border">蜆ｪ蜈育噪縺ｫ驟咲ｽｮ縲√・繝翫Ν繝・ぅ縺ｪ縺・/td></tr>
                        <tr class="bg-blue-50"><td class="p-2 border font-bold text-blue-700">B</td><td class="p-2 border">濶ｯ螂ｽ</td><td class="p-2 border">2.0</td><td class="p-2 border">騾壼ｸｸ驟咲ｽｮ</td></tr>
                        <tr><td class="p-2 border font-bold text-gray-500">C</td><td class="p-2 border">譎ｮ騾・/td><td class="p-2 border">1.0</td><td class="p-2 border">繧・ｄ謗ｧ縺医ａ縺ｫ驟咲ｽｮ</td></tr>
                        <tr class="bg-red-50"><td class="p-2 border font-bold text-red-600">D</td><td class="p-2 border">遐比ｿｮ荳ｭ繝ｻ隕∵欠蟆・/td><td class="p-2 border">0.5</td><td class="p-2 border">繝｡繝ｳ繧ｿ繝ｼ蠢・医∝腰迢ｬ驟咲ｽｮ荳榊庄</td></tr>
                    </tbody>
                </table>
                <p class="text-xs text-gray-400 mt-2">窶ｻ 繝√・繝蜈ｨ菴薙・謌ｦ蜉帙せ繧ｳ繧｢縺悟渕貅悶ｒ貅縺溘☆繧医≧AI縺瑚・蜍戊ｪｿ謨ｴ縺励∪縺・/p>
            </div>

            <!-- 3. AI繧ｷ繝輔ヨ菴懈・ -->
            <div id="m-shift" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">3.</span>AI繧ｷ繝輔ヨ菴懈・</h3>
                <div class="space-y-3 text-sm text-gray-700">
                    <p><strong>縲窟I繧ｷ繝輔ヨ菴懈・縲阪・繧ｿ繝ｳ1縺､</strong>縺ｧ莉･荳九′閾ｪ蜍募ｮ溯｡後＆繧後∪縺・</p>
                    <ol class="list-decimal list-inside space-y-1 ml-2">
                        <li>繧ｹ繧ｿ繝・ヵ縺ｮ譚｡莉ｶ繝ｻ蟶梧悍莨代・騾ｱ蜍､蜍呎律謨ｰ繧定ｪｭ縺ｿ霎ｼ縺ｿ</li>
                        <li>Python謨ｰ逅・怙驕ｩ蛹悶お繝ｳ繧ｸ繝ｳ(PuLP)縺ｧ繝吶・繧ｹ繧ｷ繝輔ヨ逕滓・</li>
                        <li>AI(Gemini)縺悟感蝓ｺ豕輔メ繧ｧ繝・け繝ｻ驕募渚菫ｮ豁｣繝ｻ譛驕ｩ蛹・/li>
                        <li>繧ｷ繝輔ヨ菫晏ｭ倪・AI險ｺ譁ｭ繝ｬ繝昴・繝郁｡ｨ遉ｺ</li>
                    </ol>
                    <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-2">
                        <p class="text-xs text-blue-700"><strong>菴懈・遽・峇縺ｮ驕ｸ謚櫁い:</strong></p>
                        <ul class="text-xs text-blue-600 mt-1 space-y-0.5">
                            <li>繝ｻ莉頑怦縺ｮ遨ｺ縺阪す繝輔ヨ縺ｮ縺ｿ蝓九ａ繧・/li>
                            <li>繝ｻ譚･騾ｱ蛻・ｒ菴懈・</li>
                            <li>繝ｻ迴ｾ蝨ｨ縺ｮ繧ｷ繝輔ヨ繧偵Μ繧ｻ繝・ヨ縺励※蜀肴ｧ狗ｯ・/li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 4. 蜉ｴ蝓ｺ豕・-->
            <div id="m-labor" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">4.</span>蜉ｴ蜒榊渕貅匁ｳ輔Ν繝ｼ繝ｫ・郁・蜍暮・螳茨ｼ・/h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">譚｡鬆・/th><th class="p-2 text-left border">蜀・ｮｹ</th><th class="p-2 text-left border">繧ｷ繧ｹ繝・Β縺ｮ蛻ｶ蠕｡</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border">蜉ｴ蝓ｺ豕・2譚｡</td><td class="p-2 border">1譌･8譎る俣莉･蜀・/td><td class="p-2 border">繧ｹ繧ｿ繝・ヵ蛟句挨險ｭ螳壹〒荳頑嶌縺榊庄</td></tr>
                        <tr><td class="p-2 border">蜉ｴ蝓ｺ豕・2譚｡</td><td class="p-2 border">騾ｱ40譎る俣莉･蜀・/td><td class="p-2 border">閾ｪ蜍戊ｨ育ｮ励〒蛻ｶ髯・/td></tr>
                        <tr><td class="p-2 border">蜉ｴ蝓ｺ豕・4譚｡</td><td class="p-2 border">6h雜・・45蛻・ｼ第・縲・h雜・・60蛻・ｼ第・</td><td class="p-2 border">閾ｪ蜍穂ｻ倅ｸ趣ｼ郁ｨｭ螳壼､画峩蜿ｯ・・/td></tr>
                        <tr><td class="p-2 border">蜉ｴ蝓ｺ豕・5譚｡</td><td class="p-2 border">騾ｱ1譌･莉･荳翫・莨第律・磯｣邯・譌･縺ｾ縺ｧ・・/td><td class="p-2 border">閾ｪ蜍暮・螳・/td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 5. 莨第・繝ｫ繝ｼ繝ｫ -->
            <div id="m-break" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">5.</span>莨第・繝ｫ繝ｼ繝ｫ</h3>
                <p class="text-sm text-gray-600 mb-2">繧ｷ繝輔ヨ菴懈・譎ゅ↓蜍､蜍呎凾髢薙°繧芽・蜍戊ｨ育ｮ励＆繧後∪縺吶ょｺ苓・險ｭ螳壹〒螟画峩蜿ｯ閭ｽ縺ｧ縺吶・/p>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">蜍､蜍呎凾髢・/th><th class="p-2 text-left border">莨第・譎る俣</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border">6譎る俣雜・/td><td class="p-2 border">45蛻・ｻ･荳・/td></tr>
                        <tr><td class="p-2 border">8譎る俣雜・/td><td class="p-2 border">60蛻・ｻ･荳・/td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 6. 莨代∩蟶梧悍 -->
            <div id="m-request" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">6.</span>莨代∩蟶梧悍</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>繧ｹ繧ｿ繝・ヵ蛛ｴ:</strong> 繧ｫ繝ｬ繝ｳ繝繝ｼ縺九ｉ隍・焚譌･繧偵ち繝・・驕ｸ謚樞・縲御ｼ代∩蟶梧悍繧呈署蜃ｺ縲・/p>
                    <p><strong>邂｡逅・・・:</strong> 逕ｳ隲九Μ繧ｹ繝医〒遒ｺ隱坂・謇ｿ隱・蜊ｴ荳・/p>
                    <p><strong>謇ｿ隱阪＆繧後◆莨代∩蟶梧悍</strong>縺ｯAI繧ｷ繝輔ヨ菴懈・譎ゅ↓閾ｪ蜍募渚譏縺輔ｌ縲√◎縺ｮ譌･縺ｫ縺ｯ繧ｷ繝輔ヨ縺碁・鄂ｮ縺輔ｌ縺ｾ縺帙ｓ縲・/p>
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <p class="text-xs text-amber-700"><strong>繝昴う繝ｳ繝・</strong> 蜍､蜍呎律謨ｰ縺ｯ繧ｹ繧ｿ繝・ヵ縺ｮ縲碁ｱ譛螟ｧ蜍､蜍呎律謨ｰ縲崎ｨｭ螳壹〒閾ｪ蜍慕ｮ｡逅・＆繧後∪縺吶ゆｼ代∩蟶梧悍縺ｯ霑ｽ蜉縺ｮ莨第律謖・ｮ壹〒縺吶・/p>
                    </div>
                </div>
            </div>

            <!-- 7. 蠎苓・險ｭ螳・-->
            <div id="m-settings" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">7.</span>蠎苓・險ｭ螳・/h3>
                <div class="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3">
                    <p class="text-sm text-amber-800 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>蠎苓・險ｭ螳壹・AI繧ｷ繝輔ヨ縺ｮ蜩∬ｳｪ縺ｫ逶ｴ邨舌＠縺ｾ縺吶ょｿ・★豁｣遒ｺ縺ｫ險ｭ螳壹＠縺ｦ縺上□縺輔＞縲・/p>
                </div>
                <div class="space-y-3 text-sm text-gray-700">
                    <div class="border-l-4 border-red-400 pl-3">
                        <p><strong>蝟ｶ讌ｭ譎る俣・域屆譌･蛻･・・</strong> 蟷ｳ譌･繝ｻ蝨滓律繝ｻ逾晄律縺斐→縺ｫ髢句ｺ・髢牙ｺ玲凾髢薙ｒ險ｭ螳壹よ悴險ｭ螳壹□縺ｨ蜈ｨ譌･蜷御ｸ蝟ｶ讌ｭ譎る俣縺ｧ險育ｮ励＆繧後∪縺吶・/p>
                    </div>
                    <div class="border-l-4 border-red-400 pl-3">
                        <p><strong>蠢・ｦ∽ｺｺ蜩｡・域屆譌･蛻･・・</strong> 蟷ｳ譌･/蝨滓律/逾晄律縺斐→縺ｮ譛菴朱・鄂ｮ莠ｺ謨ｰ縲ゅ％繧後′繧ｷ繝輔ヨ陦ｨ縺ｮ縲御ｺｺ蜩｡迥ｶ豕√阪い繝ｩ繝ｼ繝医・蝓ｺ貅門､縺ｫ縺ｪ繧翫∪縺吶・/p>
                    </div>
                    <div class="border-l-4 border-orange-400 pl-3">
                        <p><strong>繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ:</strong> 譌ｩ逡ｪ繝ｻ驕・分縺ｪ縺ｩ縺ｮ譎る俣繝・Φ繝励Ξ繝ｼ繝医・strong>2縺､莉･荳顔匳骭ｲ縺吶ｋ縺ｨAI縺瑚・蜍慕噪縺ｫ荳ｭ逡ｪ繝代ち繝ｼ繝ｳ繧ら函謌・/strong>縺励∵凾髢灘ｸｯ縺ｮ遨ｴ謚懊￠繧帝亟縺弱∪縺吶・/p>
                    </div>
                    <div class="border-l-4 border-blue-400 pl-3">
                        <p><strong>螳壻ｼ第律:</strong> 譖懈律繝吶・繧ｹ・域ｯ朱ｱ豌ｴ譖懊↑縺ｩ・峨り・譎ゆｼ第･ｭ縺ｯ譌･莉俶欠螳壹・/p>
                    </div>
                    <div class="border-l-4 border-gray-400 pl-3">
                        <p><strong>蠖ｹ閨ｷ險ｭ螳・</strong> 蠖ｹ閨ｷ蜷阪・繧ｫ繧ｹ繧ｿ繝槭う繧ｺ縲・/p>
                    </div>
                    <div class="border-l-4 border-gray-400 pl-3">
                        <p><strong>驕狗畑繝ｫ繝ｼ繝ｫ:</strong> 繧ｹ繧ｿ繝・ヵ蜷代￠縺ｫ陦ｨ遉ｺ縺輔ｌ繧九♀蠎励・繝ｫ繝ｼ繝ｫ繝・く繧ｹ繝医・/p>
                    </div>
                </div>
            </div>

            <!-- 8. 繝励Λ繝ｳ -->
            <div id="m-plan" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">8.</span>繝励Λ繝ｳ繝ｻ隱ｲ驥・/h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">繝励Λ繝ｳ</th><th class="p-2 text-left border">譛磯｡・/th><th class="p-2 text-left border">繧ｹ繧ｿ繝・ヵ荳企剞</th><th class="p-2 text-left border">讖溯・</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border font-bold text-blue-600">Standard</td><td class="p-2 border">2,980蜀・/td><td class="p-2 border">10蜷・/td><td class="p-2 border">蜈ｨAI讖溯・繝ｻ繧ｷ繝輔ヨ邂｡逅・・讖溯・</td></tr>
                        <tr class="bg-green-50"><td class="p-2 border font-bold text-green-600">Pro</td><td class="p-2 border">4,480蜀・/td><td class="p-2 border">50蜷・/td><td class="p-2 border">+ 蜆ｪ蜈医し繝昴・繝医・蛻・梵繝ｬ繝昴・繝・/td></tr>
                        <tr><td class="p-2 border font-bold text-purple-600">Premium</td><td class="p-2 border">9,980蜀・/td><td class="p-2 border">辟｡蛻ｶ髯・/td><td class="p-2 border">+ 隍・焚蠎苓・蟇ｾ蠢懊・蟆ょｱ槭し繝昴・繝・/td></tr>
                    </tbody>
                </table>
                <div class="mt-3 space-y-1 text-xs text-gray-500">
                    <p>繝ｻ荳企剞雜・℃譎ゅ・繧ｹ繧ｿ繝・ヵ霑ｽ蜉繝ｻ繧ｷ繝輔ヨ菴懈・縺後ヶ繝ｭ繝・け縺輔ｌ縺ｾ縺・/p>
                    <p>繝ｻ繝繧ｦ繝ｳ繧ｰ繝ｬ繝ｼ繝画凾縲∬ｶ・℃蛻・・繧ｹ繧ｿ繝・ヵ繧貞炎髯､縺吶ｋ縺ｾ縺ｧ繧ｷ繝輔ヨ菴懈・荳榊庄</p>
                    <p>繝ｻ隗｣邏・ｾ後ｂ繝・・繧ｿ縺ｯ6繝ｶ譛磯俣菫晄戟縺輔ｌ縺ｾ縺・/p>
                    <p>繝ｻ豎ｺ貂井ｸ榊ｙ縺九ｉ3騾ｱ髢捺悴蟇ｾ蠢懊〒繧ｵ繝ｼ繝薙せ荳譎ょ●豁｢</p>
                </div>
            </div>

            <!-- 9. 讓ｩ髯・-->
            <div id="m-auth" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">9.</span>讓ｩ髯・(邂｡逅・・/ 繧ｹ繧ｿ繝・ヵ)</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                        <h4 class="font-bold text-green-600 mb-2">邂｡逅・・′縺ｧ縺阪ｋ縺薙→</h4>
                        <ul class="space-y-1 text-gray-700">
                            <li>繝ｻAI繧ｷ繝輔ヨ菴懈・</li>
                            <li>繝ｻ繧ｷ繝輔ヨ縺ｮ謇句虚邱ｨ髮・・繝峨Λ繝・げ遘ｻ蜍・/li>
                            <li>繝ｻ繧ｹ繧ｿ繝・ヵ縺ｮ霑ｽ蜉繝ｻ邱ｨ髮・・蜑企勁</li>
                            <li>繝ｻ莨代∩蟶梧悍縺ｮ謇ｿ隱阪・蜊ｴ荳・/li>
                            <li>繝ｻ蠎苓・險ｭ螳壹・螟画峩</li>
                            <li>繝ｻ蛻・梵繝ｬ繝昴・繝医・髢ｲ隕ｧ</li>
                            <li>繝ｻ繝励Λ繝ｳ螟画峩</li>
                            <li>繝ｻ縺薙・繝槭ル繝･繧｢繝ｫ縺ｮ髢ｲ隕ｧ</li>
                        </ul>
                    </div>
                    <div>
                        <h4 class="font-bold text-blue-600 mb-2">繧ｹ繧ｿ繝・ヵ縺後〒縺阪ｋ縺薙→</h4>
                        <ul class="space-y-1 text-gray-700">
                            <li>繝ｻ閾ｪ蛻・・繧ｷ繝輔ヨ遒ｺ隱・/li>
                            <li>繝ｻ莨代∩蟶梧悍縺ｮ謠仙・</li>
                            <li>繝ｻ縺雁ｺ励・繝ｫ繝ｼ繝ｫ遒ｺ隱・/li>
                        </ul>
                        <p class="text-xs text-gray-400 mt-2">窶ｻ 繧ｹ繧ｿ繝・ヵ縺ｯ莉悶・繧ｹ繧ｿ繝・ヵ縺ｮ諠・ｱ繧・す繝輔ヨ邱ｨ髮・↓縺ｯ繧｢繧ｯ繧ｻ繧ｹ縺ｧ縺阪∪縺帙ｓ</p>
                    </div>
                </div>
            </div>

            <!-- 10. 蛻・梵 -->
            <div id="m-analytics" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">10.</span>蛻・梵繝ｻ繝ｬ繝昴・繝・/h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>譛磯俣謗ｨ螳壻ｺｺ莉ｶ雋ｻ:</strong> 譎らｵｦ繧ｹ繧ｿ繝・ヵ縺ｮ螳溽ｸｾ・区怦邨ｦ繧ｹ繧ｿ繝・ヵ縺ｮ蝗ｺ螳夐｡阪ら･晄律蜑ｲ蠅・1.25蛟・蜷ｫ繧縲・/p>
                    <p><strong>譌･谺｡繧ｳ繧ｹ繝域耳遘ｻ:</strong> 譌･縺斐→縺ｮ莠ｺ莉ｶ雋ｻ繧ｰ繝ｩ繝輔・/p>
                    <p><strong>繧ｹ繧ｿ繝・ヵ蛻･隧ｳ邏ｰ:</strong> 蜃ｺ蜍､譌･謨ｰ繝ｻ蜉ｴ蜒肴凾髢薙・豕募ｮ夂岼螳・176h)縺ｨ縺ｮ豈碑ｼ・・謗ｨ螳壽髪邨ｦ鬘阪・/p>
                    <p><strong>繧ｳ繧ｹ繝域ｧ区・豈・</strong> 繧ｹ繧ｿ繝・ヵ蛻･縺ｮ莠ｺ莉ｶ雋ｻ蜑ｲ蜷茨ｼ亥・繧ｰ繝ｩ繝包ｼ峨・/p>
                </div>
            </div>

            <!-- 11. 縺昴・莉・-->
            <div id="m-other" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">11.</span>縺昴・莉匁ｩ溯・</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>繧ｫ繝ｬ繝ｳ繝繝ｼ繝｡繝｢:</strong> 迚ｹ螳壹・譌･縺ｫ繝｡繝｢繧呈ｮ九○縺ｾ縺呻ｼ医う繝吶Φ繝医・蝗｣菴謎ｺ育ｴ・↑縺ｩ・峨・/p>
                    <p><strong>繝峨Λ繝・げ&繝峨Ο繝・・:</strong> 繧ｷ繝輔ヨ陦ｨ縺ｧ繧ｷ繝輔ヨ繧偵ラ繝ｩ繝・げ縺励※譎る俣螟画峩繝ｻ繧ｹ繧ｿ繝・ヵ螟画峩縺悟庄閭ｽ・育ｮ｡逅・・・縺ｿ・峨・/p>
                    <p><strong>蜊ｰ蛻ｷ:</strong> 繧ｷ繝輔ヨ陦ｨ繧単DF/蜊ｰ蛻ｷ縺ｧ縺阪∪縺吶・/p>
                    <p><strong>繝・・繧ｿ繝ｪ繧ｻ繝・ヨ:</strong> 險ｭ螳夂判髱｢縺ｮ譛荳矩Κ縺九ｉ蜈ｨ繝・・繧ｿ繧貞・譛溷喧縺ｧ縺阪∪縺呻ｼ域ｳｨ諢擾ｼ壼ｾｩ蜈・ｸ榊庄・峨・/p>
                </div>
            </div>
        </div>`;
    },

    // --- 縺昴・莉・---
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
        
        // 隕∫ｴ縺悟ｭ伜惠縺吶ｋ蝣ｴ蜷医・縺ｿ陦ｨ遉ｺ繧呈峩譁ｰ・医せ繧ｿ繝・ヵ逕ｻ髱｢縺ｧ縺ｯ隕∫ｴ縺後↑縺・◆繧√せ繧ｭ繝・・縺輔ｌ繧具ｼ・
        const costEl = document.getElementById('headerTotalCost');
        const hoursEl = document.getElementById('headerTotalHours');
        
        if(costEl) costEl.textContent = `ﾂ･${Math.floor(totalCost).toLocaleString()}`;
        if(hoursEl) hoursEl.textContent = `${Math.floor(totalHours)}h`;
    },

    // --- AI險ｺ譁ｭ (繧ｵ繝ｼ繝舌・繧ｵ繧､繝臥ｵ檎罰) ---
    async runAIDiagnosis() {
        this.openModal('aiAdviceModal');
        const content = document.getElementById('aiAnalysisContent');
        content.innerHTML = `<div class="flex justify-center py-8"><div class="loading-spinner"></div><p class="ml-3 text-gray-500">AI縺後す繝輔ヨ繧貞・譫蝉ｸｭ...</p></div>`;

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

            if (!result || !Array.isArray(result)) throw new Error("AI縺九ｉ縺ｮ蠢懃ｭ斐′縺ゅｊ縺ｾ縺帙ｓ");

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
                        <h4 class="font-bold text-gray-800 mb-1">${s.title}</h4>
                        <p class="text-sm text-gray-600 mb-3">${s.desc}</p>
                        <p class="text-xs font-bold text-gray-500">${s.action}</p>
                    </div>
                </div>`;
            }).join('');

        } catch (e) {
            console.error(e);
            content.innerHTML = `<div class="text-red-500 p-4"><i class="fa-solid fa-circle-exclamation mr-2"></i>險ｺ譁ｭ繧ｨ繝ｩ繝ｼ: ${e.message}</div>`;
        }
    },
    
    applyAiFixes() { this.closeModal('aiAdviceModal'); this.showToast('菫ｮ豁｣譯医ｒ驕ｩ逕ｨ縺励∪縺励◆', 'success'); },

    // --- Stripe豎ｺ貂・---
    async startCheckout(plan) {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('繝ｭ繧ｰ繧､繝ｳ縺悟ｿ・ｦ√〒縺・, 'error');
            return;
        }
        this.showLoading(true);
        try {
            const result = await API.createCheckout(contractId, plan);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('繝√ぉ繝・け繧｢繧ｦ繝・RL縺ｮ蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆', 'error');
            }
        } catch (e) {
            console.error('Checkout Error:', e);
            this.showToast('豎ｺ貂医お繝ｩ繝ｼ: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async openStripePortal() {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('繝ｭ繧ｰ繧､繝ｳ縺悟ｿ・ｦ√〒縺・, 'error');
            return;
        }
        this.showLoading(true);
        try {
            const result = await API.createPortal(contractId);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('繝昴・繧ｿ繝ｫURL縺ｮ蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆', 'error');
            }
        } catch (e) {
            console.error('Portal Error:', e);
            this.showToast('繧ｨ繝ｩ繝ｼ: ' + e.message, 'error');
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

    // 縲後↑縺励咲嶌蠖薙・蜈･蜉帙°縺ｩ縺・°蛻､螳・
    _isReferrerNone(code) {
        const normalized = (code || '').trim().toLowerCase();
        return ['縺ｪ縺・, '辟｡縺・, '辟｡', 'none', 'nashi', 'no', 'n/a', 'na'].includes(normalized);
    },

    copyCompanyPhoneToContact() {
        const company = document.getElementById('newSubPhone')?.value.trim();
        if (!company) {
            this.showToast('莉｣陦ｨ髮ｻ隧ｱ逡ｪ蜿ｷ繧貞・縺ｫ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error');
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
            status.innerHTML = '<span class="text-gray-400">繧ｳ繝ｼ繝峨ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞・育ｴｹ莉玖・′縺・↑縺・ｴ蜷医・縲後↑縺励搾ｼ・/span>';
            return;
        }
        // 縲後↑縺励咲ｳｻ縺ｮ蜈･蜉・
        if (this._isReferrerNone(raw)) {
            status.innerHTML = '<span class="text-blue-600"><i class="fa-solid fa-circle-info mr-1"></i>邏ｹ莉玖・↑縺励〒逋ｻ骭ｲ縺励∪縺・/span>';
            this._markFieldError('newSubReferrerCode', false);
            return;
        }
        const code = raw.toUpperCase();
        try {
            const SUPA_URL = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_URL) || '';
            const SUPA_KEY = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_ANON_KEY) || '';
            const res = await fetch(`${SUPA_URL}/rest/v1/rpc/validate_referrer_code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPA_KEY,
                    'Authorization': 'Bearer ' + SUPA_KEY,
                },
                body: JSON.stringify({ p_code: code })
            });
            const result = await res.json();
            if (result.valid) {
                status.innerHTML = `<span class="text-green-600"><i class="fa-solid fa-circle-check mr-1"></i>譛牙柑: ${result.name}</span>`;
                this._markFieldError('newSubReferrerCode', false);
            } else {
                status.innerHTML = `<span class="text-red-500"><i class="fa-solid fa-circle-xmark mr-1"></i>${result.message || '辟｡蜉ｹ縺ｪ繧ｳ繝ｼ繝峨〒縺・}・育ｴｹ莉玖・′縺・↑縺・ｴ蜷医・縲後↑縺励阪→蜈･蜉幢ｼ・/span>`;
                this._markFieldError('newSubReferrerCode', true);
            }
        } catch (e) {
            status.innerHTML = '<span class="text-red-500">遒ｺ隱阪↓螟ｱ謨励＠縺ｾ縺励◆</span>';
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

        // 蜈ｨ繝輔ぅ繝ｼ繝ｫ繝峨Μ繧ｻ繝・ヨ
        ['newSubOrgName','newSubContact','newSubEmail','newSubPhone','newSubContactPhone','newSubAddress','newSubReferrerCode'].forEach(id => this._markFieldError(id, false));

        const errors = [];
        if (!orgName) { errors.push('莠区･ｭ閠・錐'); this._markFieldError('newSubOrgName', true); }
        if (!contact) { errors.push('諡・ｽ楢・錐'); this._markFieldError('newSubContact', true); }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) { errors.push('繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ'); this._markFieldError('newSubEmail', true); }
        const phoneRegex = /^[0-9\-\+]{10,15}$/;
        if (!phone || !phoneRegex.test(phone.replace(/[\s\(\)]/g, ''))) { errors.push('莉｣陦ｨ髮ｻ隧ｱ逡ｪ蜿ｷ'); this._markFieldError('newSubPhone', true); }
        if (!contactPhone || !phoneRegex.test(contactPhone.replace(/[\s\(\)]/g, ''))) { errors.push('諡・ｽ楢・崕隧ｱ逡ｪ蜿ｷ'); this._markFieldError('newSubContactPhone', true); }
        if (!address || address.length < 5) { errors.push('菴乗園'); this._markFieldError('newSubAddress', true); }
        if (!referrerInput) { errors.push('邏ｹ莉玖・さ繝ｼ繝会ｼ井ｸ肴・縺ｪ蝣ｴ蜷医・縲後↑縺励阪→蜈･蜉幢ｼ・); this._markFieldError('newSubReferrerCode', true); }
        if (!plan) { errors.push('繝励Λ繝ｳ'); }

        if (errors.length > 0) {
            this.showToast(`莉･荳九・鬆・岼繧呈ｭ｣縺励￥蜈･蜉帙＠縺ｦ縺上□縺輔＞: ${errors.join('縲・)}`, 'error');
            return;
        }

        // 邏ｹ莉玖・さ繝ｼ繝牙・逅・
        let referrerCode = '';  // 縲後↑縺励阪・蝣ｴ蜷医・遨ｺ譁・ｭ励ｒDB縺ｫ菫晏ｭ・
        if (!this._isReferrerNone(referrerInput)) {
            referrerCode = referrerInput.toUpperCase();
            try {
                const SUPA_URL = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_URL) || '';
                const SUPA_KEY = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_ANON_KEY) || '';
                const vres = await fetch(`${SUPA_URL}/rest/v1/rpc/validate_referrer_code`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': SUPA_KEY,
                        'Authorization': 'Bearer ' + SUPA_KEY,
                    },
                    body: JSON.stringify({ p_code: referrerCode })
                });
                const vresult = await vres.json();
                if (!vresult.valid) {
                    this._markFieldError('newSubReferrerCode', true);
                    this.showToast(`邏ｹ莉玖・さ繝ｼ繝・ ${vresult.message || '辟｡蜉ｹ'}・育ｴｹ莉玖・′縺・↑縺・ｴ蜷医・縲後↑縺励阪→蜈･蜉幢ｼ荏, 'error');
                    return;
                }
            } catch (e) {
                this.showToast('邏ｹ莉玖・さ繝ｼ繝峨・讀懆ｨｼ縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
                return;
            }
        }

        this.showLoading(true);
        try {
            const result = await API.createNewSubscription(email, orgName, plan, contact, phone, address, referrerCode, contactPhone);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('豎ｺ貂医・繝ｼ繧ｸ縺ｮ菴懈・縺ｫ螟ｱ謨励＠縺ｾ縺励◆', 'error');
            }
        } catch (e) {
            console.error('New Subscription Error:', e);
            this.showToast('繧ｨ繝ｩ繝ｼ: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async updateEmail() {
        const email = document.getElementById('settingEmail')?.value.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) {
            this.showToast('譛牙柑縺ｪ繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧貞・蜉帙＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }
        const contractId = this.state.config.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('繝ｭ繧ｰ繧､繝ｳ縺悟ｿ・ｦ√〒縺・, 'error');
            return;
        }
        try {
            await API._request(`config?contract_id=eq.${contractId}`, {
                method: 'PATCH',
                body: JSON.stringify({ customer_email: email })
            });
            this.state.config.customer_email = email;
            this.showToast('繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧呈峩譁ｰ縺励∪縺励◆', 'success');
        } catch (e) {
            this.showToast('譖ｴ譁ｰ縺ｫ螟ｱ謨励＠縺ｾ縺励◆: ' + e.message, 'error');
        }
    },

    openPricingModal() {
        // 險ｭ螳夂判髱｢縺ｮ繧ｵ繝悶せ繧ｯ繝ｪ繝励す繝ｧ繝ｳ繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ縺ｾ縺ｧ繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ
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
        // 謾ｹ陦後ｒ繝ｪ繧ｹ繝医い繧､繝・Β縺ｫ螟画鋤
        const rulesList = rulesText.split('\n').filter(line => line.trim() !== '').map(line => `<li>${line}</li>`).join('');
        
        // 驥鷹姦諠・ｱ繧貞ｮ悟・縺ｫ蜑企勁縺励∵･ｭ蜍吶Ν繝ｼ繝ｫ縺ｮ縺ｿ繧定｡ｨ遉ｺ
        content.innerHTML = `
            <div class="space-y-4">
                <div class="bg-blue-50 p-4 rounded-xl border border-blue-100">
                    <h4 class="font-bold text-blue-800 text-sm mb-2"><i class="fa-regular fa-clock mr-2"></i>蝟ｶ讌ｭ譎る俣</h4>
                    <p class="text-2xl font-bold text-gray-800 text-center">${config.opening_time || '09:00'} <span class="text-sm text-gray-400 mx-2">縲・/span> ${config.closing_time || '22:00'}</p>
                </div>
                
                <div class="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <h4 class="font-bold text-gray-600 text-xs mb-1">譛菴主共蜍吩ｺｺ謨ｰ</h4>
                    <p class="text-lg font-bold text-gray-800">${config.staff_req?.min_weekday || 2}蜷・/p>
                </div>

                <div class="border-t border-gray-100 pt-4">
                    <h4 class="font-bold text-gray-800 text-sm mb-2">繧ｷ繝輔ヨ逕ｳ隲九↓縺､縺・※繝ｻ縺顔衍繧峨○</h4>
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
    showUpgradeModal() {
        const currentPlan = this.state.config.stripe_plan || 'standard';
        const limit = this.getStaffLimit();
        const currentCount = this.state.staff.length;
        const planNames = {standard: 'Standard', pro: 'Pro', premium: 'Premium'};

        // 迴ｾ蝨ｨ繝励Λ繝ｳ諠・ｱ
        const infoEl = document.getElementById('upgradeCurrentInfo');
        if (infoEl) {
            infoEl.textContent = `迴ｾ蝨ｨ: ${planNames[currentPlan] || 'Standard'}繝励Λ繝ｳ・・{currentCount}/${limit}蜷搾ｼ荏;
        }

        // 繧｢繝・・繧ｰ繝ｬ繝ｼ繝牙・繝励Λ繝ｳ繧ｫ繝ｼ繝峨ｒ蜍慕噪逕滓・
        const plansEl = document.getElementById('upgradePlans');
        if (!plansEl) return;

        const plans = [
            { key: 'standard', name: 'Standard', price: '2,980', limit: 10, color: 'blue', features: ['繧ｹ繧ｿ繝・ヵ10蜷阪∪縺ｧ', 'AI閾ｪ蜍輔す繝輔ヨ逕滓・', 'AI蜉ｴ蝓ｺ豕輔メ繧ｧ繝・け', '繧ｷ繝輔ヨ邂｡逅・・讖溯・'] },
            { key: 'pro', name: 'Pro', price: '4,480', limit: 50, badge: '莠ｺ豌・, color: 'green', features: ['繧ｹ繧ｿ繝・ヵ50蜷阪∪縺ｧ', '蜈ｨAI讖溯・', '蜆ｪ蜈医し繝昴・繝・, '蛻・梵繝ｬ繝昴・繝・] },
            { key: 'premium', name: 'Premium', price: '9,980', limit: 9999, color: 'purple', features: ['繧ｹ繧ｿ繝・ヵ辟｡蛻ｶ髯・, '蜈ｨAI讖溯・', '隍・焚蠎苓・蟇ｾ蠢・, '蟆ょｱ槭し繝昴・繝・] },
        ];

        // 迴ｾ蝨ｨ繧医ｊ荳翫・繝励Λ繝ｳ縺ｮ縺ｿ陦ｨ遉ｺ
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
            const recommendHtml = isRecommended ? '<span class="absolute -top-2 left-3 bg-orange-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow flex items-center gap-1"><i class="fa-solid fa-star text-[8px]"></i>縺翫☆縺吶ａ</span>' : '';

            return `
                <div class="relative border-2 ${ringClass} rounded-xl p-5 hover:shadow-lg transition-all cursor-pointer group" onclick="app.upgradeFromModal('${p.key}')">
                    ${recommendHtml}${badgeHtml}
                    <div class="text-center mb-3">
                        <p class="font-bold ${c.text} text-lg">${p.name}</p>
                        <p class="text-3xl font-extrabold text-gray-900 mt-1">${p.price}<span class="text-sm font-normal text-gray-400">蜀・譛・/span></p>
                    </div>
                    <ul class="text-xs text-gray-600 space-y-1.5 mb-4">
                        ${p.features.map(f => `<li class="flex items-center gap-1.5"><i class="fa-solid fa-check ${c.check} text-[10px]"></i>${f}</li>`).join('')}
                    </ul>
                    <button class="w-full py-2.5 ${c.btn} text-white rounded-lg text-sm font-bold transition group-hover:shadow-md">
                        <i class="fa-solid fa-rocket mr-1"></i>縺薙・繝励Λ繝ｳ縺ｫ螟画峩
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

    openModal(id) {
        const el = document.getElementById(id);
        if(el) el.classList.add('active');
    },
    closeModal(id) {
        const el = document.getElementById(id);
        if(el) el.classList.remove('active');
    },

    // =========================================================
    // 縺顔衍繧峨○繝舌ャ繧ｸ譖ｴ譁ｰ
    // =========================================================
    // 縺顔衍繧峨○譌｢隱ｭ邂｡逅・
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
            const circledNums = ['笂ｪ','竭','竭｡','竭｢','竭｣','竭､','竭･','竭ｦ','竭ｧ','竭ｨ','竭ｩ'];
            badge.textContent = count <= 10 ? circledNums[count] : count.toString();
            badge.classList.remove('hidden');
        } catch (e) {
            badge.classList.add('hidden');
        }
    },

    // =========================================================
    // 縺顔衍繧峨○邂｡逅・ン繝･繝ｼ (邂｡逅・・畑)
    // =========================================================
    renderAnnouncementsAdmin(container) {
        if (!this.state.isAdmin) { this.changeView('dashboard'); return; }

        container.innerHTML = `
            <div class="max-w-4xl mx-auto space-y-6 pb-20">
                <div class="flex items-center justify-between">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-800">縺顔衍繧峨○邂｡逅・/h2>
                        <p class="text-sm text-gray-500 mt-1">驕句霧縺九ｉ縺ｮ縺顔衍繧峨○繧堤｢ｺ隱阪〒縺阪∪縺・/p>
                    </div>
                    <button onclick="app.refreshAnnouncementsAdmin()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 px-4 rounded-lg transition flex items-center gap-2">
                        <i class="fa-solid fa-arrows-rotate"></i> 譖ｴ譁ｰ
                    </button>
                </div>
                <div id="announcementsAdminList">
                    <div class="text-center py-12 text-gray-400">
                        <div class="loading-spinner mb-4 mx-auto"></div>
                        <p>隱ｭ縺ｿ霎ｼ縺ｿ荳ｭ...</p>
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
                        <p class="text-gray-500 font-bold">縺顔衍繧峨○縺ｯ縺ゅｊ縺ｾ縺帙ｓ</p>
                        <p class="text-xs text-gray-400 mt-2">迴ｾ蝨ｨ縲・・菫｡縺輔ｌ縺ｦ縺・ｋ縺顔衍繧峨○縺ｯ縺ゅｊ縺ｾ縺帙ｓ</p>
                    </div>
                `;
                return;
            }

            const typeIcons = { info: 'fa-circle-info', warning: 'fa-triangle-exclamation', promotion: 'fa-gift', update: 'fa-rocket' };
            const typeColors = { info: 'text-blue-500 bg-blue-50', warning: 'text-amber-500 bg-amber-50', promotion: 'text-emerald-500 bg-emerald-50', update: 'text-purple-500 bg-purple-50' };
            const typeLabels = { info: '縺顔衍繧峨○', warning: '豕ｨ諢・, promotion: '繧ｭ繝｣繝ｳ繝壹・繝ｳ', update: '繧｢繝・・繝・・繝・ };

            const unreadCount = announcements.filter(a => !readIds.includes(a.id)).length;

            listEl.innerHTML = `
                ${unreadCount > 0 ? `
                <div class="flex justify-end mb-3">
                    <button onclick="app.markAllAnnouncementsRead()" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-bold transition flex items-center gap-2">
                        <i class="fa-solid fa-check-double"></i> 蜈ｨ縺ｦ譌｢隱ｭ縺ｫ縺吶ｋ
                    </button>
                </div>` : ''}
                <div class="space-y-4">
                    ${announcements.map((item, idx) => {
                        const isRead = readIds.includes(item.id);
                        return `
                        <div class="bg-white rounded-xl shadow-sm border ${isRead ? 'border-gray-100 opacity-60' : 'border-gray-200'} overflow-hidden hover:shadow-md transition-shadow ${isRead ? 'relative' : ''}">
                            ${isRead ? '<div class="absolute top-3 right-3"><span class="text-[10px] font-bold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">譌｢隱ｭ</span></div>' : ''}
                            <div class="p-5">
                                <div class="flex items-start gap-4">
                                    <div class="w-10 h-10 rounded-xl ${typeColors[item.type] || typeColors.info} flex items-center justify-center shrink-0">
                                        <i class="fa-solid ${typeIcons[item.type] || typeIcons.info} text-lg"></i>
                                    </div>
                                    <div class="flex-1 min-w-0">
                                        <div class="flex items-center gap-2 mb-1">
                                            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${typeColors[item.type] || typeColors.info}">
                                                ${typeLabels[item.type] || '縺顔衍繧峨○'}
                                            </span>
                                            ${item.created_at ? `<span class="text-xs text-gray-400">${new Date(item.created_at).toLocaleDateString('ja-JP')}</span>` : ''}
                                        </div>
                                        <h3 class="font-bold text-gray-800 text-lg">${this._sanitize(item.title)}</h3>
                                        <p class="text-sm text-gray-600 mt-2 whitespace-pre-line leading-relaxed">${this._sanitize(item.content)}</p>
                                        <div class="flex items-center gap-3 mt-3">
                                            ${item.target_url ? `
                                                <a href="${item.target_url}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-sm font-bold text-blue-600 hover:text-blue-700 transition">
                                                    <i class="fa-solid fa-arrow-up-right-from-square text-xs"></i>
                                                    ${this._sanitize(item.button_text || '隧ｳ縺励￥隕九ｋ')}
                                                </a>
                                            ` : ''}
                                            ${!isRead ? `
                                                <button onclick="app.dismissAnnouncement('${item.id}')" class="inline-flex items-center gap-1 text-sm font-bold text-gray-500 hover:text-gray-700 transition">
                                                    <i class="fa-solid fa-eye-slash text-xs"></i> 譌｢隱ｭ縺ｫ縺吶ｋ
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
                    <p class="text-gray-600 font-bold">縺顔衍繧峨○縺ｮ蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆</p>
                    <p class="text-xs text-gray-400 mt-2">${e.message}</p>
                    <button onclick="app._loadAnnouncementsAdmin()" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition">蜀崎ｩｦ陦・/button>
                </div>
            `;
        }
    },

    async refreshAnnouncementsAdmin() {
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('縺顔衍繧峨○繧呈峩譁ｰ縺励∪縺励◆', 'success');
    },

    // 蛟句挨縺ｮ縺顔衍繧峨○繧呈里隱ｭ縺ｫ縺吶ｋ
    dismissAnnouncement(id) {
        this._markAnnouncementRead(id);
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('譌｢隱ｭ縺ｫ縺励∪縺励◆', 'info');
    },

    // 蜈ｨ縺ｦ縺ｮ縺顔衍繧峨○繧呈里隱ｭ縺ｫ縺吶ｋ
    markAllAnnouncementsRead() {
        this._markAllAnnouncementsRead();
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('蜈ｨ縺ｦ縺ｮ縺顔衍繧峨○繧呈里隱ｭ縺ｫ縺励∪縺励◆', 'success');
    },

    // =========================================================
    // 縺顔衍繧峨○繝昴ャ繝励い繝・・讖溯・
    // =========================================================
    _announcements: [],
    _announcementIndex: 0,

    /**
     * 繝ｭ繧ｰ繧､繝ｳ謌仙粥蠕後↓縺顔衍繧峨○繧貞叙蠕励＠縺ｦ繝昴ャ繝励い繝・・陦ｨ遉ｺ
     */
    async showAnnouncementsAfterLogin() {
        try {
            const announcements = await API.rpc('list_active_announcements');
            if (!announcements || !Array.isArray(announcements) || announcements.length === 0) {
                return; // 縺顔衍繧峨○縺ｪ縺・
            }
            this._announcements = announcements;
            this._announcementIndex = 0;
            // 蟆代＠驕・ｻｶ縺輔○縺ｦ縺九ｉ繝昴ャ繝励い繝・・陦ｨ遉ｺ・医Ο繧ｰ繧､繝ｳ繝医・繧ｹ繝医→陲ｫ繧峨↑縺・ｈ縺・↓・・
            setTimeout(() => this._renderAnnouncement(), 1500);
        } catch (e) {
            console.warn('[Announcements] Load failed:', e.message);
        }
    },

    /**
     * 迴ｾ蝨ｨ縺ｮ縺顔衍繧峨○繧偵Δ繝ｼ繝繝ｫ縺ｫ謠冗判
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

        // 繝倥ャ繝繝ｼ濶ｲ螟画峩
        const headerEl = document.querySelector('#announcementModal .modal-content > div:first-child');
        if (headerEl) {
            headerEl.className = `relative bg-gradient-to-r ${typeColors[item.type] || typeColors.info} text-white p-6`;
        }

        // 繧ｿ繧､繝医Ν
        document.getElementById('announcementTitle').textContent = item.title;

        // 譛ｬ譁・(謾ｹ陦後ｒbr縺ｫ螟画鋤)
        const bodyEl = document.getElementById('announcementBody');
        bodyEl.innerHTML = item.content.split('\n').map(line => `<p>${line}</p>`).join('');

        // 繧｢繧ｯ繧ｷ繝ｧ繝ｳ繝懊ち繝ｳ
        const actionEl = document.getElementById('announcementAction');
        if (item.target_url) {
            actionEl.classList.remove('hidden');
            document.getElementById('announcementLink').href = item.target_url;
            document.getElementById('announcementBtnText').textContent = item.button_text || '隧ｳ縺励￥隕九ｋ';
        } else {
            actionEl.classList.add('hidden');
        }

        // 繧ｫ繧ｦ繝ｳ繧ｿ繝ｼ
        document.getElementById('announcementCounter').textContent = `${idx + 1} / ${list.length}`;

        // 繝翫ン繧ｲ繝ｼ繧ｷ繝ｧ繝ｳ繝懊ち繝ｳ
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
        // 陦ｨ遉ｺ縺励◆縺顔衍繧峨○繧貞・縺ｦ譌｢隱ｭ縺ｫ縺吶ｋ
        if (this._announcements && this._announcements.length > 0) {
            for (const item of this._announcements) {
                if (item.id) this._markAnnouncementRead(item.id);
            }
            this.updateAnnouncementBadge();
        }
        this.closeModal('announcementModal');
        // 繝壹・繧ｸ險ｪ蝠乗凾縺ｮ縺顔衍繧峨○縺ｮ蝣ｴ蜷医・哩縺倥◆蠕後↓繝ｭ繧ｰ繧､繝ｳ繝｢繝ｼ繝繝ｫ繧定｡ｨ遉ｺ
        if (this._showLoginAfterAnnouncement) {
            this._showLoginAfterAnnouncement = false;
            setTimeout(() => this.openModal('loginModal'), 300);
        }
    },

    /**
     * 繝壹・繧ｸ險ｪ蝠乗凾・医Ο繧ｰ繧､繝ｳ蜑搾ｼ峨↓縺顔衍繧峨○繧定｡ｨ遉ｺ
     * @returns {boolean} 縺顔衍繧峨○縺後≠縺｣縺溷ｴ蜷・rue
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
    // 繧ｷ繝輔ヨ逕滓・繝励Ξ繝薙Η繝ｼ讖溯・
    // ===========================================================

    // 繝励Ξ繝薙Η繝ｼ逕ｨ縺ｮ荳譎ゅョ繝ｼ繧ｿ
    _previewShifts: null,
    _previewTargetType: null,
    _previewDates: null,

    /**
     * 繝励Ξ繝薙Η繝ｼ繝｢繝ｼ繝繝ｫ繧定｡ｨ遉ｺ
     * @param {Array} shifts - 逕滓・縺輔ｌ縺溘す繝輔ヨ驟榊・
     * @param {string} targetType - 'reset_all' | 'empty_only'
     * @param {Array} dates - 蟇ｾ雎｡譌･莉倬・蛻・
     */
    showShiftPreview(shifts, targetType, dates) {
        this._previewShifts = shifts;
        this._previewTargetType = targetType;
        this._previewDates = dates;

        // 繧ｵ繝槭Μ繝ｼ邨ｱ險・
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

        const summaryEl = document.getElementById('previewSummary');
        if (summaryEl) {
            summaryEl.innerHTML = `
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-emerald-600">${totalShifts}</p>
                    <p class="text-xs text-gray-500 mt-1">逕滓・繧ｷ繝輔ヨ謨ｰ</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-blue-600">${uniqueDates.length}</p>
                    <p class="text-xs text-gray-500 mt-1">蟇ｾ雎｡譌･謨ｰ</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-purple-600">${uniqueStaff.length}</p>
                    <p class="text-xs text-gray-500 mt-1">驟咲ｽｮ繧ｹ繧ｿ繝・ヵ謨ｰ</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-orange-600">${totalHours.toFixed(1)}</p>
                    <p class="text-xs text-gray-500 mt-1">蜷郁ｨ亥感蜒肴凾髢・/p>
                </div>
            `;
        }

        // 譌･莉倥＃縺ｨ縺ｮ繝・・繝悶Ν逕滓・
        const contentEl = document.getElementById('previewContent');
        if (contentEl) {
            let html = '';
            const staffMap = {};
            (this.state.staff || []).forEach(s => { staffMap[s.id] = s; });

            for (const dateStr of uniqueDates) {
                const dayShifts = shifts.filter(s => s.date === dateStr);
                const dt = new Date(dateStr + 'T00:00:00');
                const dayNames = ['譌･', '譛・, '轣ｫ', '豌ｴ', '譛ｨ', '驥・, '蝨・];
                const dow = dayNames[dt.getDay()];
                const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;

                html += `
                    <div class="mb-4">
                        <h4 class="text-sm font-bold ${isWeekend ? 'text-red-600' : 'text-gray-700'} mb-2 flex items-center gap-2">
                            <span class="w-6 h-6 rounded-full ${isWeekend ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600'} flex items-center justify-center text-xs font-bold">${dow}</span>
                            ${dateStr}
                            <span class="text-xs text-gray-400 font-normal">(${dayShifts.length}蜷埼・鄂ｮ)</span>
                        </h4>
                        <div class="overflow-x-auto">
                            <table class="w-full text-sm">
                                <thead class="bg-gray-50 text-xs text-gray-500">
                                    <tr>
                                        <th class="px-3 py-2 text-left rounded-l-lg">繧ｹ繧ｿ繝・ヵ</th>
                                        <th class="px-3 py-2 text-left">蠖ｹ閨ｷ</th>
                                        <th class="px-3 py-2 text-center">蜃ｺ蜍､</th>
                                        <th class="px-3 py-2 text-center">騾蜍､</th>
                                        <th class="px-3 py-2 text-center">莨第・</th>
                                        <th class="px-3 py-2 text-center rounded-r-lg">螳溷ロ</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100">
                `;

                for (const shift of dayShifts) {
                    const staff = staffMap[shift.staff_id] || { name: shift.staff_id, role: '' };
                    const roleList = this.state.config.roles || this.state.defaultConfig.roles || [];
                    const roleObj = roleList.find(r => r.id === staff.role) || { name: '繧ｹ繧ｿ繝・ヵ', color: 'gray' };
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

                    html += `
                        <tr class="hover:bg-gray-50">
                            <td class="px-3 py-2 font-bold text-gray-800">${staff.name || '荳肴・'}</td>
                            <td class="px-3 py-2">${roleBadge}</td>
                            <td class="px-3 py-2 text-center font-mono text-emerald-600 font-bold">${shift.start_time}</td>
                            <td class="px-3 py-2 text-center font-mono text-red-500 font-bold">${shift.end_time}</td>
                            <td class="px-3 py-2 text-center text-gray-500">${breakMin}蛻・/td>
                            <td class="px-3 py-2 text-center font-bold">${workHours.toFixed(1)}h</td>
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
     * 繝励Ξ繝薙Η繝ｼ繧呈価隱阪＠縺ｦDB菫晏ｭ倥ｒ螳溯｡・
     */
    async confirmShiftPreview() {
        if (!this._previewShifts || this._previewShifts.length === 0) {
            this.showToast('菫晏ｭ倥☆繧九す繝輔ヨ縺後≠繧翫∪縺帙ｓ', 'error');
            return;
        }

        this.closeModal('shiftPreviewModal');

        // 繝ｭ繝ｼ繝・ぅ繝ｳ繧ｰ陦ｨ遉ｺ
        const loadingEl = document.getElementById('globalLoading');
        const loadingDefault = document.getElementById('loadingDefault');
        if (loadingDefault) loadingDefault.style.display = 'flex';
        if (loadingEl) loadingEl.classList.remove('hidden');

        try {
            const dates = this._previewDates;
            const targetType = this._previewTargetType;

            // reset_all縺ｮ蝣ｴ蜷医・譌｢蟄伜炎髯､
            if (targetType === 'reset_all') {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
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

            // DB菫晏ｭ・
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

            // 繝舌ャ繧ｯ繧ｰ繝ｩ繧ｦ繝ｳ繝陰I險ｺ譁ｭ
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

            this.showToast(`${finalShifts.length}莉ｶ縺ｮ繧ｷ繝輔ヨ繧剃ｿ晏ｭ倥＠縺ｾ縺励◆`, 'success');
        } catch (e) {
            console.error('Preview Save Error:', e);
            this.showToast('繧ｷ繝輔ヨ縺ｮ菫晏ｭ倥↓螟ｱ謨励＠縺ｾ縺励◆: ' + e.message, 'error');
        } finally {
            if (loadingEl) loadingEl.classList.add('hidden');
            this._previewShifts = null;
            this._previewTargetType = null;
            this._previewDates = null;
        }
    },

    /**
     * 繝励Ξ繝薙Η繝ｼ繧偵く繝｣繝ｳ繧ｻ繝ｫ・育ｴ譽・ｼ・
     */
    cancelShiftPreview() {
        this._previewShifts = null;
        this._previewTargetType = null;
        this._previewDates = null;
        this.closeModal('shiftPreviewModal');
        this.showToast('繧ｷ繝輔ヨ逕滓・繧偵く繝｣繝ｳ繧ｻ繝ｫ縺励∪縺励◆', 'info');
    },

    // ===========================================================
    // 繝代せ繝ｯ繝ｼ繝牙､画峩讖溯・
    // ===========================================================

    /**
     * 蠎苓・繝代せ繝ｯ繝ｼ繝峨ｒ螟画峩
     */
    async changeShopPassword() {
        const currentPass = document.getElementById('currentPassword')?.value || '';
        const newPass = document.getElementById('newPassword')?.value || '';
        const confirmPass = document.getElementById('confirmPassword')?.value || '';

        if (!currentPass) {
            this.showToast('迴ｾ蝨ｨ縺ｮ繝代せ繝ｯ繝ｼ繝峨ｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }
        if (!newPass || newPass.length < 6) {
            this.showToast('譁ｰ縺励＞繝代せ繝ｯ繝ｼ繝峨・6譁・ｭ嶺ｻ･荳翫〒蜈･蜉帙＠縺ｦ縺上□縺輔＞', 'error');
            return;
        }
        if (newPass !== confirmPass) {
            this.showToast('譁ｰ縺励＞繝代せ繝ｯ繝ｼ繝峨′荳閾ｴ縺励∪縺帙ｓ', 'error');
            return;
        }

        try {
            const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
            if (!contractId) {
                this.showToast('繧ｻ繝・す繝ｧ繝ｳ繧ｨ繝ｩ繝ｼ: 蜀阪Ο繧ｰ繧､繝ｳ縺励※縺上□縺輔＞', 'error');
                return;
            }

            // 迴ｾ蝨ｨ縺ｮ繝代せ繝ｯ繝ｼ繝臥｢ｺ隱・(verify_shop_login RPC)
            const verifyResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: currentPass
            });

            // verify_shop_login縺ｯJSONB繧定ｿ斐☆縺溘ａ縲∫峩謗･繧ｪ繝悶ず繧ｧ繧ｯ繝医→縺励※謇ｱ縺・
            // ・医Ο繧ｰ繧､繝ｳ譎ゅ→蜷後§蠖｢蠑擾ｼ・
            if (!verifyResult || !verifyResult.success) {
                this.showToast('迴ｾ蝨ｨ縺ｮ繝代せ繝ｯ繝ｼ繝峨′豁｣縺励￥縺ゅｊ縺ｾ縺帙ｓ', 'error');
                return;
            }

            // 譁ｰ縺励＞繝代せ繝ｯ繝ｼ繝峨↓譖ｴ譁ｰ (update_shop_password RPC)
            await API.rpc('update_shop_password', {
                p_contract_id: contractId,
                p_new_password: newPass
            });

            this.closeModal('changePasswordModal');
            // 繝輔か繝ｼ繝繧ｯ繝ｪ繧｢
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';

            this.showToast('繝代せ繝ｯ繝ｼ繝峨′豁｣蟶ｸ縺ｫ螟画峩縺輔ｌ縺ｾ縺励◆', 'success');
        } catch (e) {
            console.error('Password change error:', e);
            this.showToast('繝代せ繝ｯ繝ｼ繝牙､画峩縺ｫ螟ｱ謨励＠縺ｾ縺励◆: ' + e.message, 'error');
        }
    },

    // ===========================================================
    // 繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ繝励Μ繧ｻ繝・ヨ讖溯・
    // ===========================================================

    SHIFT_PRESETS: {
        restaurant: {
            name: '鬟ｲ鬟溷ｺ怜髄縺・,
            patterns: [
                { name: '譌ｩ逡ｪ', start: '09:00', end: '15:00' },
                { name: '荳ｭ逡ｪ', start: '12:00', end: '18:00' },
                { name: '驕・分', start: '16:00', end: '22:00' },
                { name: '騾壹＠', start: '09:00', end: '22:00' },
                { name: '繝ｩ繝ｳ繝・, start: '10:00', end: '14:00' },
                { name: '繝・ぅ繝翫・', start: '17:00', end: '22:00' },
            ]
        },
        office: {
            name: '繧ｪ繝輔ぅ繧ｹ蜷代￠',
            patterns: [
                { name: '譌･蜍､', start: '09:00', end: '18:00' },
                { name: '譌ｩ逡ｪ', start: '08:00', end: '17:00' },
                { name: '驕・分', start: '10:00', end: '19:00' },
                { name: '蜊頑律AM', start: '09:00', end: '13:00' },
                { name: '蜊頑律PM', start: '13:00', end: '18:00' },
            ]
        },
        retail: {
            name: '蟆丞｣ｲ蠎怜髄縺・,
            patterns: [
                { name: '譌ｩ逡ｪ', start: '09:00', end: '15:00' },
                { name: '驕・分', start: '14:00', end: '21:00' },
                { name: '騾壹＠', start: '09:00', end: '21:00' },
                { name: '蜊亥燕', start: '09:00', end: '13:00' },
                { name: '蜊亥ｾ・, start: '13:00', end: '17:00' },
                { name: '螟墓婿', start: '17:00', end: '21:00' },
            ]
        },
        medical: {
            name: '蛹ｻ逋ゅ・莉玖ｭｷ蜷代￠',
            patterns: [
                { name: '譌･蜍､', start: '08:30', end: '17:30' },
                { name: '譌ｩ逡ｪ', start: '07:00', end: '16:00' },
                { name: '驕・分', start: '10:00', end: '19:00' },
                { name: '螟懷共', start: '16:30', end: '09:00' },
                { name: '貅門､懷共', start: '16:30', end: '01:00' },
                { name: '蜊頑律', start: '08:30', end: '12:30' },
            ]
        }
    },

    /**
     * 繝励Μ繧ｻ繝・ヨ縺ｮ繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ繧剃ｸ諡ｬ驕ｩ逕ｨ
     * @param {string} presetKey - 'restaurant' | 'office' | 'retail' | 'medical'
     */
    applyShiftPreset(presetKey) {
        const preset = this.SHIFT_PRESETS[presetKey];
        if (!preset) return;

        const existing = this.state.config.custom_shifts || [];
        if (existing.length > 0) {
            if (!confirm(`迴ｾ蝨ｨ縺ｮ繧ｷ繝輔ヨ繝代ち繝ｼ繝ｳ(${existing.length}莉ｶ)繧剃ｸ頑嶌縺阪＠縺ｾ縺吶°・歃n縲・{preset.name}縲・${preset.patterns.length}繝代ち繝ｼ繝ｳ)縺ｫ鄂ｮ縺肴鋤縺医∪縺吶Ａ)) {
                return;
            }
        }

        this.state.config.custom_shifts = preset.patterns.map(p => ({ ...p }));
        this.renderCurrentView();
        this.showToast(`縲・{preset.name}縲阪・繝ｪ繧ｻ繝・ヨ(${preset.patterns.length}繝代ち繝ｼ繝ｳ)繧帝←逕ｨ縺励∪縺励◆`, 'success');
    }
};

document.addEventListener('DOMContentLoaded', () => { app.init(); });














