// =================================================================
// API Client for Rakushift (Supabase Version)
// Backend: Supabase (Data) + Railway (Calculation)
// 險ｭ螳壼､縺ｯ js/config.js 縺九ｉ隱ｭ縺ｿ霎ｼ縺ｿ
// =================================================================

const SUPABASE_URL = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_URL) || "";
const SUPABASE_KEY = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_ANON_KEY) || "";
const CALC_BASE_URL = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.CALC_SERVER_URL) || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("[FATAL] js/config.js 縺梧悴險ｭ螳壹〒縺吶４UPABASE_URL 縺ｨ SUPABASE_ANON_KEY 繧定ｨｭ螳壹＠縺ｦ縺上□縺輔＞縲・);
}

const CALC_API_URL = CALC_BASE_URL + "/generate";
const CHECK_API_URL = CALC_BASE_URL + "/check";
const DIAGNOSE_API_URL = CALC_BASE_URL + "/diagnose";

const API = {
    session: null,

    // --- 蛻晄悄蛹・& 隱崎ｨｼ ---
    async init() {

        try {
            // 繧ｻ繝・す繝ｧ繝ｳ蠕ｩ蜈・(Rakushift迢ｬ閾ｪ縺ｮ繧ｻ繝・す繝ｧ繝ｳ繧ｭ繝ｼ繧貞━蜈・
            const savedSession = localStorage.getItem('rakushift_user'); // 迢ｬ閾ｪ隱崎ｨｼ逕ｨ
            
            if (savedSession) {
                // 迢ｬ閾ｪ隱崎ｨｼ繝｢繝ｼ繝峨・蠕ｩ蜈・
                const user = JSON.parse(savedSession);
                this.session = {
                    access_token: 'dummy_token_for_static_auth',
                    user: user
                };
                // 繧ｻ繝・す繝ｧ繝ｳ蠕ｩ蜈・ｮ御ｺ・
            } else {
                // (譌ｧ莠呈鋤) Supabase Auth 縺ｮ蠕ｩ蜈・
                const savedSbSession = localStorage.getItem('supabase.auth.token');
                if (savedSbSession) {
                    this.session = JSON.parse(savedSbSession);
                    // 繧ｻ繝・す繝ｧ繝ｳ蠕ｩ蜈・Ο繧ｰ縺ｯ譛ｬ逡ｪ縺ｧ縺ｯ髱櫁｡ｨ遉ｺ
                } else {
                    // 繧ｻ繝・す繝ｧ繝ｳ縺ｪ縺・
                }
            }
        } catch(e) {
            console.error("API init failed:", e);
        }
    },

    async login(email, password) {
        try {
            const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY
                },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error_description || data.msg || "Login failed");
            
            this.session = data;
            localStorage.setItem('supabase.auth.token', JSON.stringify(data));
            return data;
        } catch (e) {
            console.error("Login failed:", e);
            throw e;
        }
    },

    async signUp(email, password, shopName) {
        try {
            const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY
                },
                body: JSON.stringify({ 
                    email, 
                    password,
                    data: { full_name: shopName } 
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error_description || data.msg || "Signup failed");
            return data;
        } catch (e) {
            console.error("Signup failed:", e);
            throw e;
        }
    },

    // 隱崎ｨｼ縺ｯ app.js 蛛ｴ縺ｧ staff 繝・・繝悶Ν繧堤峩謗･讀懃ｴ｢縺励※陦後≧縺溘ａ (SaaS蟇ｾ蠢・ StaticMode莠呈鋤)
    // 縺薙％縺ｧ縺ｯ繧ｻ繝・す繝ｧ繝ｳ迥ｶ諷九・邂｡逅・・縺ｿ陦後≧
    setSession(user) {
        // Supabase繝｢繝ｼ繝峨〒繧ゅ√い繝励Μ蜀・・迢ｬ閾ｪ隱崎ｨｼ・亥･醍ｴИD・峨ｒ菴ｿ縺・ｴ蜷医・
        // user繧ｪ繝悶ず繧ｧ繧ｯ繝医ｒ繝ｩ繝・・縺励※session縺ｫ蜈･繧後ｋ驕狗畑縺ｫ縺吶ｋ
        this.session = {
            access_token: 'dummy_token_for_static_auth', // 迢ｬ閾ｪ隱崎ｨｼ縺ｪ縺ｮ縺ｧ繝繝溘・
            user: user
        };
        // 繝ｭ繝ｼ繧ｫ繝ｫ繧ｹ繝医Ξ繝ｼ繧ｸ縺ｫ繧ら峡閾ｪ繧ｭ繝ｼ縺ｧ菫晏ｭ假ｼ・upabase讓呎ｺ悶→縺ｯ蛻･邂｡逅・ｼ・
        // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 繧ｿ繧､繝繧ｹ繧ｿ繝ｳ繝励ｒ莉倅ｸ弱＠縺ｦ繧ｻ繝・す繝ｧ繝ｳ譛牙柑譛滄剞繧堤ｮ｡逅・
        user._session_created = Date.now();
        localStorage.setItem('rakushift_user', JSON.stringify(user));
    },

    // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ: 繧ｻ繝・す繝ｧ繝ｳ譛牙柑譛滄剞繝√ぉ繝・け・医ヵ繝ｭ繝ｳ繝医お繝ｳ繝牙・縺ｮ陬懷勧蛻ｶ蠕｡・・
    isSessionValid() {
        const saved = localStorage.getItem('rakushift_user');
        if (!saved) return false;
        try {
            const user = JSON.parse(saved);
            const created = user._session_created || 0;
            const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7譌･髢・
            if (Date.now() - created > MAX_SESSION_MS) {

                this.logout();
                return false;
            }
            return true;
        } catch(e) { return false; }
    },

    async logout() {
        try {
            // 繧ｵ繝ｼ繝舌・蛛ｴ縺ｮ繧ｻ繝・す繝ｧ繝ｳ繧ら｢ｺ螳溘↓遐ｴ譽・☆繧具ｼ亥ｮ檎挑縺ｪ繧ｻ繧ｭ繝･繝ｪ繝・ぅ諡・ｿ晢ｼ・
            await this.rpc('destroy_session', {});
        } catch(e) {
            console.warn("Session destroy failed on server, proceeding with local logout");
        }
        this.session = null;
        localStorage.removeItem('supabase.auth.token');
        localStorage.removeItem('rakushift_user');
        location.reload();
    },

    // --- 豎守畑繝・・繧ｿ謫堺ｽ・(Supabase REST) ---
    async _request(endpoint, options = {}) {
        // SaaS繝｢繝ｼ繝・ 繝ｭ繧ｰ繧､繝ｳ縺励※縺・↑縺上※繧・PI縺ｯ蜿ｩ縺代ｋ繧医≧縺ｫ縺吶ｋ・亥･醍ｴИD隱崎ｨｼ蜑阪〒繧Ｄonfig遲峨・隱ｭ縺ｿ縺溘＞蝣ｴ蜷医′縺ゅｋ縺溘ａ・・
        // 縺溘□縺由LS縺後°縺九▲縺ｦ縺・ｋ繝・・繝悶Ν縺ｯSupabase蛛ｴ縺ｧ蠑ｾ縺九ｌ繧・
        
        const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            // 'Authorization': `Bearer ${this.session?.access_token}`, // 迢ｬ閾ｪ隱崎ｨｼ縺ｮ蝣ｴ蜷医・Bearer荳崎ｦ√√≠繧九＞縺ｯAnon繧ｭ繝ｼ縺ｧ繧｢繧ｯ繧ｻ繧ｹ
            'Authorization': `Bearer ${SUPABASE_KEY}`, // 蝓ｺ譛ｬ縺ｯAnon繧ｭ繝ｼ縺ｧ繧｢繧ｯ繧ｻ繧ｹ縺励ヽLS縺ｯ繝輔ぅ繝ｫ繧ｿ縺ｧ蛻ｶ蠕｡
            'Prefer': 'return=representation',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...options.headers
        };

        const savedSession = localStorage.getItem('rakushift_user');
        if (savedSession) {
            try {
                const user = JSON.parse(savedSession);
                if (user.session_id) {
                    headers['x-session-id'] = user.session_id;
                }
            } catch(e) {}
        }

        const MAX_RETRIES = 2;
        let attempt = 0;

        while (attempt <= MAX_RETRIES) {
            try {
                const res = await fetch(url, { ...options, headers });
                if (!res.ok) {
                    // 500邉ｻ繧ｨ繝ｩ繝ｼ縺ｾ縺溘・Too Many Requests (429) 縺ｮ蝣ｴ蜷医・繝ｪ繝医Λ繧､蟇ｾ雎｡
                    if ((res.status >= 500 && res.status < 600) || res.status === 429) {
                        throw new Error(`Server Error ${res.status}`);
                    }
                    // 400邉ｻ繧ｨ繝ｩ繝ｼ縺ｪ縺ｩ縺ｯ繝ｪ繝医Λ繧､縺帙★縺ｫ蜊ｳ譎ゅお繝ｩ繝ｼ縺ｫ縺吶ｋ
                    const errText = await res.text();
                    let errMsg = res.statusText;
                    try {
                        const json = JSON.parse(errText);
                        errMsg = json.message || json.error || res.statusText;
                    } catch(e) {}
                    
                    console.error(`API Error [${res.status}] ${url}`, errMsg);
                    throw new Error(`繝・・繧ｿ蜿門ｾ励お繝ｩ繝ｼ (${res.status}): ${errMsg}`);
                }
                return await res.json();
            } catch (e) {
                // 繧ｯ繝ｩ繧､繧｢繝ｳ繝郁ｵｷ蝗縺ｮ繧ｨ繝ｩ繝ｼ・・00邉ｻ・峨・蝣ｴ蜷医・縺昴・縺ｾ縺ｾ繧ｹ繝ｭ繝ｼ
                if (e.message.includes("繝・・繧ｿ蜿門ｾ励お繝ｩ繝ｼ")) {
                    throw e;
                }
                
                attempt++;
                if (attempt > MAX_RETRIES) {
                    console.error("Fetch failed after retries:", e);
                    throw new Error("繧ｵ繝ｼ繝舌・騾壻ｿ｡縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲ゅロ繝・ヨ繝ｯ繝ｼ繧ｯ繧堤｢ｺ隱阪＠縺ｦ縺上□縺輔＞縲・);
                }
                // 謖・焚繝舌ャ繧ｯ繧ｪ繝・(1蝗樒岼: 500ms, 2蝗樒岼: 1000ms)
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
            }
        }
    },

    async list(table, params = {}) {
        const qs = new URLSearchParams(params).toString();
        // Supabase蠖｢蠑上・繝ｬ繧ｹ繝昴Φ繧ｹ {data: [], error: null} 繧呈ｨ｡蛟｣縺吶ｋ縺九∫峩謗･驟榊・繧定ｿ斐☆縺・
        // Static Table API莠呈鋤縺ｫ縺吶ｋ縺溘ａ {data: [...]} 蠖｢蠑上〒霑斐☆
        const data = await this._request(`${table}?${qs}`);
        return { data: data };
    },

    async get(table, id) {
        const data = await this._request(`${table}?id=eq.${id}`);
        return data[0];
    },

    async create(table, data) {
        const res = await this._request(table, {
            method: 'POST',
            body: JSON.stringify(data)
        });
        return res[0];
    },

    async update(table, id, data) {
        const res = await this._request(`${table}?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });
        return res[0];
    },

    async delete(table, id) {
        // 繝・リ繝ｳ繝井ｿ晁ｭｷ: 驥崎ｦ√ユ繝ｼ繝悶Ν縺ｮ逶ｴ謗･蜑企勁繧堤ｦ∵ｭ｢
        const protectedTables = ['organizations', 'config', 'hq_admins'];
        if (protectedTables.includes(table)) {
            console.error(`[BLOCKED] 繝・・繝悶Ν "${table}" 縺ｮ蜑企勁縺ｯ繧ｷ繧ｹ繝・Β縺ｫ繧医ｊ遖∵ｭ｢縺輔ｌ縺ｦ縺・∪縺兪);
            throw new Error(`${table} 縺ｮ蜑企勁縺ｯ險ｱ蜿ｯ縺輔ｌ縺ｦ縺・∪縺帙ｓ`);
        }
        console.warn(`[DELETE] ${table} id=${id} - 螳溯｡形);
        await this._request(`${table}?id=eq.${id}`, {
            method: 'DELETE'
        });
        return true;
    },
    async upsert(table, dataArray) {
        const res = await this._request(table, {
            method: 'POST',
            body: JSON.stringify(dataArray),
            headers: {
                'Prefer': 'return=representation,resolution=merge-duplicates'
            }
        });
        return res;
    },


    // --- RPC (繧ｵ繝ｼ繝舌・繧ｵ繧､繝蛾未謨ｰ) ---
    async rpc(functionName, params = {}) {
        const url = `${SUPABASE_URL}/rest/v1/rpc/${functionName}`;
        const headers = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        };

        const savedSession = localStorage.getItem('rakushift_user');
        if (savedSession) {
            try {
                const user = JSON.parse(savedSession);
                if (user.session_id) {
                    headers['x-session-id'] = user.session_id;
                }
            } catch(e) {}
        }

        const res = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(params)
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error(`RPC Error [${res.status}] ${functionName}:`, errText);
            throw new Error(`RPC螟ｱ謨・ ${functionName}`);
        }
        return await res.json();
    },
    // --- 莠句燕繝√ぉ繝・け (莠ｺ蜩｡荳崎ｶｳ縺ｮ讀懷・) ---
    async checkFeasibility(payload) {
        try {
            const res = await fetch(CHECK_API_URL, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.check || null;
        } catch (e) {
            console.error("Check failed:", e);
            return null;
        }
    },


    // --- 險育ｮ励お繝ｳ繧ｸ繝ｳ騾｣謳ｺ (Python Railway) ---
    // Gemini逶｣譟ｻ縺ｯ繧ｵ繝ｼ繝舌・繧ｵ繧､繝峨〒螳溯｡・(API繧ｭ繝ｼ繧偵ヵ繝ｭ繝ｳ繝医↓髴ｲ蜃ｺ縺励↑縺・
    async generateShifts(payload) {


        try {
            // contract_id繧偵・繧､繝ｭ繝ｼ繝峨↓霑ｽ蜉 (繧ｵ繝ｼ繝舌・縺窟PI繧ｭ繝ｼ繧貞叙蠕励☆繧九◆繧・
            const contractId = payload.config?.contract_id || null;

            const serverPayload = {
                staff_list: payload.staff_list,
                config: payload.config,
                dates: payload.dates,
                requests: payload.requests || [],
                mode: payload.mode || 'auto',
                contract_id: contractId
            };

            const res = await fetch(CALC_API_URL, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(serverPayload)
            });

            if (!res.ok) {
                throw new Error(`Python Server Error: ${res.statusText}`);
            }

            const result = await res.json();


            if (result.status === 'success' && Array.isArray(result.shifts)) {
                return {
                    status: "success",
                    shifts: result.shifts,
                    mode: result.mode || "python_optimized"
                };
            } else if (result.status === 'success' && result.mode === 'math_failed') {
                return { status: "success", shifts: [], mode: "math_failed" };
            } else {
                throw new Error(result.message || "Invalid response from server");
            }

        } catch (e) {
            console.error("Shift Generation Error:", e);
            return { status: "error", message: e.message };
        }
    },

    async diagnose(payload) {
        try {
            const res = await fetch(DIAGNOSE_API_URL, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error(`Server Error: ${res.status}`);
            const data = await res.json();
            return data.suggestions || [];
        } catch (e) {
            console.error("Diagnose Error:", e);
            throw e;
        }
    },

    // --- Stripe豎ｺ貂・API ---
    async createCheckout(contractId, plan = 'standard') {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/create-checkout', {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contract_id: contractId,
                    plan: plan,
                    success_url: window.location.origin + '/index.html?payment=success',
                    cancel_url: window.location.origin + '/index.html?payment=cancelled'
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Checkout creation failed');
            }
            return await res.json();
        } catch (e) {
            console.error("Checkout Error:", e);
            throw e;
        }
    },

    // 譁ｰ隕冗筏縺苓ｾｼ縺ｿ逕ｨ (螂醍ｴИD荳崎ｦ√√Γ繝ｼ繝ｫ+繝励Λ繝ｳ縺ｮ縺ｿ)
    async createNewSubscription(email, orgName, plan = 'pro', contact = '', phone = '', address = '', referrerCode = '', contactPhone = '') {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/new-subscription', {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: email,
                    org_name: orgName,
                    plan: plan,
                    contact_name: contact,
                    phone: phone,
                    contact_phone: contactPhone,
                    address: address,
                    referrer_code: referrerCode,
                    success_url: window.location.origin + '/index.html?payment=success&new=1',
                    cancel_url: window.location.origin + '/index.html?payment=cancelled'
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Subscription creation failed');
            }
            return await res.json();
        } catch (e) {
            console.error("New Subscription Error:", e);
            throw e;
        }
    },

    async createPortal(contractId) {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/create-portal', {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contract_id: contractId,
                    return_url: window.location.href
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Portal creation failed');
            }
            return await res.json();
        } catch (e) {
            console.error("Portal Error:", e);
            throw e;
        }
    },

    async getSubscriptionStatus(contractId) {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/subscription-status/' + contractId, {
                credentials: 'omit'
            });
            if (!res.ok) return { status: 'unknown' };
            return await res.json();
        } catch (e) {
            console.error("Subscription Status Error:", e);
            return { status: 'unknown' };
        }
    }
};

window.API = API;

