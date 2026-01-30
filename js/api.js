// =================================================================
// API Client for Rakushift (Supabase Version)
// Backend: Supabase (Data) + Cloud Run (Calculation)
// =================================================================

const SUPABASE_URL = "https://guuocjilvtmppbqvsxtl.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1dW9jamlsdnRtcHBicXZzeHRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY4NTI5MzUsImV4cCI6MjA4MjQyODkzNX0.Myxf-cuIeQ9nzRRJ_Ti1rRlaZ53tmHb0eosEUMFwsHY";

// 外部計算サーバー (Python)
// ★重要: あなたの最新のCloud Run URLに更新済み
const CALC_API_URL = "https://rakushift-calc-874112922898.asia-northeast1.run.app/generate";

// Gemini API Endpoint
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

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

    // --- 計算エンジン連携 (Python Cloud Run + Gemini Review) ---
    async generateShifts(payload) {
        console.log("Starting shift generation process...");
        const result = { status: "success", shifts: [], mode: "unknown" };

        try {
            // =========================================================
            // STEP 1: Python計算サーバーへのリクエスト (数理最適化)
            // =========================================================
            console.log("Step 1: Requesting Python Optimization Engine...");
            let pythonResult = null;
            
            try {
                // FastAPIとの通信のため、Content-Typeは application/json が必須
                const res = await fetch(CALC_API_URL, {
                    method: 'POST',
                    credentials: 'omit', 
                    headers: { 'Content-Type': 'application/json' }, // ★ここを修正しました
                    body: JSON.stringify(payload)
                });
                
                if (!res.ok) {
                    throw new Error(`Python Server Error: ${res.statusText}`);
                }
                
                pythonResult = await res.json();
                console.log("Python Engine Result:", pythonResult);
                
                if (pythonResult.status === 'success' && Array.isArray(pythonResult.shifts)) {
                    result.shifts = pythonResult.shifts;
                    result.mode = "python_optimized";
                } else {
                    // 解なしの場合でもエラーにせず空リストを許容
                    if(pythonResult.status === 'success' && pythonResult.mode === 'math_failed'){
                         result.shifts = [];
                         console.warn("Math solver returned no solution (relaxed constraints recommended).");
                    } else {
                        throw new Error("Invalid response from Python engine");
                    }
                }

            } catch (pythonError) {
                console.error("Step 1 Failed:", pythonError);
                return { status: "error", message: "Python計算サーバーへの接続に失敗しました。" };
            }

            // =========================================================
            // STEP 2: Gemini APIによる監査と修正 (Gemini 2.5 Flash Preview相当)
            // =========================================================
            // APIキー設定がある場合のみ実行
            const geminiKey = payload.config.gemini_api_key || payload.config.openai_api_key;
            
            if (geminiKey) {
                console.log("Step 2: Requesting Gemini AI Audit & Fix...");
                
                const auditResult = await this.checkShiftsWithGemini(geminiKey, payload, result.shifts);
                
                if (auditResult && Array.isArray(auditResult)) {
                    console.log("Gemini Audit Completed. Fixed Shifts:", auditResult.length);
                    result.shifts = auditResult;
                    result.mode = "python_optimized_plus_gemini_audit";
                } else {
                    console.warn("Gemini Audit failed or returned invalid format. Using Python result.");
                }
            } else {
                console.log("Skipping Step 2 (No API Key provided)");
            }

            return result;

        } catch (e) {
            console.error("Shift Generation Critical Error:", e);
            return { status: "error", message: e.message };
        }
    },

    // Gemini API 呼び出し (監査・修正用)
    async checkShiftsWithGemini(apiKey, payload, originalShifts) {
        const modelName = payload.config.gemini_model || "gemini-1.5-flash"; 
        const url = `${GEMINI_API_URL}/${modelName}:generateContent?key=${apiKey}`;
        
        const prompt = `
あなたは熟練したシフト管理者AIです。
以下の条件（スタッフ情報、店舗設定、希望休）に基づき、
Pythonシステムによって生成された「一次シフト案」を監査し、
条件違反や不合理な点があれば修正して、最終的な「完全なシフト表」を出力してください。

### 制約条件
1. スタッフの希望休 (unavailable_dates) には絶対に入れてはいけない。
2. 契約上の週最大日数 (max_days_week) を超えてはいけない。
3. 1日の最大時間 (max_hours_day) を超えてはいけない。
4. 店舗の必要人数 (staff_req) を可能な限り満たすこと。
5. 固定給（月給）スタッフは優先的に週5日程度配置すること。
6. **重要**: 出力は純粋なJSON配列形式のみ。マークダウン記法や解説は不要。

### 入力データ
【スタッフリスト】
${JSON.stringify(payload.staff_list.map(s => ({
    id: s.id, name: s.name, role: s.role, 
    type: s.salary_type, max_days: s.max_days_week, max_hours: s.max_hours_day,
    ng: s.unavailable_dates
})))}

【必要人数設定】
${JSON.stringify(payload.config.staff_req)}

【対象日付リスト】
${JSON.stringify(payload.dates)}

【一次シフト案 (Python生成)】
${JSON.stringify(originalShifts.map(s => ({
    staff_id: s.staff_id, date: s.date, start: s.start_time, end: s.end_time
})))}

### 出力形式
[
  {"staff_id": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "break_minutes": 60},
  ...
]
`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.2,
                        responseMimeType: "application/json"
                    }
                })
            });

            if (!res.ok) throw new Error(`Gemini API Error: ${res.statusText}`);
            
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (!text) return null;
            
            const fixedShifts = JSON.parse(text);
            
            return fixedShifts.map(s => ({
                ...s,
                break_minutes: s.break_minutes || 60,
                organization_id: payload.config.organization_id 
            }));

        } catch (e) {
            console.error("Gemini Check Error:", e);
            return null; 
        }
    }
};

window.API = API;
console.log("API Loaded (Supabase Mode)");
