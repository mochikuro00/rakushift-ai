// =================================================================
// API Client for Rakushift (Supabase Version)
// Backend: Supabase (Data) + Cloud Run (Calculation)
// 設定値は js/config.js から読み込み
// =================================================================

// config.js の内容をハードコード、もしくは環境変数から取得する方針に変更
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://xxx.supabase.co"; // TODO: 環境変数
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "xxx"; // TODO: 環境変数
const CALC_BASE_URL = import.meta.env.VITE_CALC_SERVER_URL || "https://xxx.run.app"; // TODO: 環境変数

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[API] Environment variables not set. Using fallback.");
}

const CALC_API_URL = CALC_BASE_URL + "/generate";
const CHECK_API_URL = CALC_BASE_URL + "/check";
const DIAGNOSE_API_URL = CALC_BASE_URL + "/diagnose";

const API = {
    session: null,

    // --- 初期化 & 認証 ---
    async init() {
        console.log("API init start (Supabase Mode)");
        try {
            // セッション復元 (Rakushift独自のセッションキーを優先)
            const savedSession = localStorage.getItem('rakushift_user'); // 独自認証用
            
            if (savedSession) {
                // 独自認証モードの復元
                const user = JSON.parse(savedSession);
                this.session = {
                    access_token: 'dummy_token_for_static_auth',
                    user: user
                };
                console.log("Session restored (Rakushift User):", user.name);
            } else {
                // (旧互換) Supabase Auth の復元
                const savedSbSession = localStorage.getItem('supabase.auth.token');
                if (savedSbSession) {
                    this.session = JSON.parse(savedSbSession);
                    console.log("Session restored (Supabase Auth)");
                } else {
                    console.log("No saved session");
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

    // 認証は app.js 側で staff テーブルを直接検索して行うため (SaaS対応: StaticMode互換)
    // ここではセッション状態の管理のみ行う
    setSession(user) {
        // Supabaseモードでも、アプリ内の独自認証（契約ID）を使う場合は
        // userオブジェクトをラップしてsessionに入れる運用にする
        this.session = {
            access_token: 'dummy_token_for_static_auth', // 独自認証なのでダミー
            user: user
        };
        // ローカルストレージにも独自キーで保存（Supabase標準とは別管理）
        localStorage.setItem('rakushift_user', JSON.stringify(user));
    },

    async logout() {
        this.session = null;
        localStorage.removeItem('supabase.auth.token');
        localStorage.removeItem('rakushift_user');
        location.reload();
    },

    // --- 汎用データ操作 (Supabase REST) ---
    async _request(endpoint, options = {}) {
        // SaaSモード: ログインしていなくてもAPIは叩けるようにする（契約ID認証前でもconfig等は読みたい場合があるため）
        // ただしRLSがかかっているテーブルはSupabase側で弾かれる
        
        const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            // 'Authorization': `Bearer ${this.session?.access_token}`, // 独自認証の場合はBearer不要、あるいはAnonキーでアクセス
            'Authorization': `Bearer ${SUPABASE_KEY}`, // 基本はAnonキーでアクセスし、RLSはフィルタで制御
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

        try {
            const res = await fetch(url, { ...options, headers });
            if (!res.ok) {
                const errText = await res.text();
                let errMsg = res.statusText;
                try {
                    const json = JSON.parse(errText);
                    errMsg = json.message || json.error || res.statusText;
                } catch(e) {}
                
                console.error(`API Error [${res.status}] ${url}`, errMsg);
                throw new Error(`データ取得エラー (${res.status}): ${errMsg}`);
            }
            return await res.json();
        } catch (e) {
            console.error("Fetch failed:", e);
            throw new Error("サーバー通信に失敗しました。ネットワークを確認してください。");
        }
    },

    async list(table, params = {}) {
        const qs = new URLSearchParams(params).toString();
        // Supabase形式のレスポンス {data: [], error: null} を模倣するか、直接配列を返すか
        // Static Table API互換にするため {data: [...]} 形式で返す
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


    // --- RPC (サーバーサイド関数) ---
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
            throw new Error(`RPC失敗: ${functionName}`);
        }
        return await res.json();
    },
    // --- 事前チェック (人員不足の検出) ---
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


    // --- 計算エンジン連携 (Python Cloud Run) ---
    // Gemini監査はサーバーサイドで実行 (APIキーをフロントに露出しない)
    async generateShifts(payload) {
        console.log("Starting shift generation process...");

        try {
            // contract_idをペイロードに追加 (サーバーがAPIキーを取得するため)
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
            console.log("Server Result:", result);

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

    // --- Stripe決済 API ---
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

    // 新規申し込み用 (契約ID不要、メール+プランのみ)
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

export default API;
