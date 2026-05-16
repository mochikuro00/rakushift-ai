import os
import json
import hmac
import hashlib
import httpx
import stripe
from fastapi import FastAPI, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from scheduler import ShiftScheduler

# レート制限設定
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="Rakushift AI Engine", version="3.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS設定: 本番ドメインのみ許可
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "").split(",")
if not ALLOWED_ORIGINS or ALLOWED_ORIGINS == [""]:
    ALLOWED_ORIGINS = [
        "https://rakushift-ai.pages.dev",
        "https://*.rakushift-ai.pages.dev",
        "http://localhost:3000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === 環境変数 (フォールバック用。DB設定が優先) ===
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# DBから読み込んだプラットフォーム設定キャッシュ
_platform_settings = {}
_settings_loaded_at = 0

FRONTEND_URL = os.environ.get("FRONTEND_URL", "")


def _get_setting(key: str, env_fallback: str = "") -> str:
    """DB設定 → 環境変数 の優先順で値を取得"""
    val = _platform_settings.get(key, "")
    if val:
        return val
    return os.environ.get(key.upper(), env_fallback)


def _load_platform_settings():
    """SupabaseのRPCからプラットフォーム設定を読み込み (5分キャッシュ)"""
    global _platform_settings, _settings_loaded_at
    import time
    now = time.time()
    if now - _settings_loaded_at < 300 and _platform_settings:
        return  # 5分以内はキャッシュ利用
    if not SUPABASE_SERVICE_KEY:
        return
    try:
        url = "{}/rest/v1/rpc/get_platform_settings".format(SUPABASE_URL)
        resp = httpx.post(url, json={}, headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
            "Content-Type": "application/json",
        }, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict):
                _platform_settings = data
                _settings_loaded_at = now
                print("[Settings] Loaded {} keys from DB".format(len(data)))
                # Stripeキーが設定されていれば適用
                sk = data.get("stripe_secret_key", "")
                if sk:
                    stripe.api_key = sk
    except Exception as e:
        print("[Settings] Load failed: {}".format(e))


# 起動時に設定読み込み
_load_platform_settings()


# === リクエストモデル ===

class ShiftRequest(BaseModel):
    staff_list: List[Dict[str, Any]]
    config: Dict[str, Any]
    dates: List[str]
    requests: List[Dict[str, Any]] = []
    mode: str = "auto"
    contract_id: Optional[str] = None


class DiagnoseRequest(BaseModel):
    contract_id: Optional[str] = None
    config: Dict[str, Any] = {}
    staff_count: int = 0
    shift_count: int = 0
    shifts: List[Dict[str, Any]] = []
    staff_list: List[Dict[str, Any]] = []


class InquiryRequest(BaseModel):
    """法人お問い合わせフォーム"""
    company_name: str
    company_address: str = ""
    phone: str
    contact_name: str
    plan_summary: str = ""
    light_plan_count: str = "0"
    standard_plan_count: str = "0"
    premium_plan_count: str = "0"
    preferred_days: str = ""
    preferred_time: str = ""
    schedule_summary: str = ""
    message: str = ""


class CheckoutRequest(BaseModel):
    contract_id: str
    plan: str = "standard"  # "standard", "pro", or "premium"
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class NewSubscriptionRequest(BaseModel):
    email: str
    org_name: str
    plan: str = "pro"
    contact_name: str = ""
    phone: str = ""
    contact_phone: str = ""
    address: str = ""
    referrer_code: str = ""
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


class PortalRequest(BaseModel):
    contract_id: str
    return_url: Optional[str] = None


# === ヘルパー関数 ===

def get_gemini_key() -> tuple:
    """DB設定優先でGeminiキーを取得"""
    _load_platform_settings()
    key = _get_setting("gemini_api_key")
    model = _get_setting("gemini_model", "gemini-2.0-flash")
    return key, model


async def supabase_rpc(function_name: str, params: dict) -> dict:
    """Supabase RPCをサービスキーで呼び出し"""
    if not SUPABASE_SERVICE_KEY:
        return {"status": "error", "message": "SUPABASE_SERVICE_KEY not configured"}
    url = "{}/rest/v1/rpc/{}".format(SUPABASE_URL, function_name)
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=params, headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
            "Content-Type": "application/json",
        }, timeout=30)
        if resp.status_code != 200:
            return {"status": "error", "message": resp.text}
        return resp.json()


async def supabase_query(table: str, params: str = "", method: str = "GET",
                         body: dict = None) -> Any:
    """Supabase REST APIをサービスキーで呼び出し"""
    if not SUPABASE_SERVICE_KEY:
        return None
    url = "{}/rest/v1/{}?{}".format(SUPABASE_URL, table, params)
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    async with httpx.AsyncClient() as client:
        if method == "GET":
            resp = await client.get(url, headers=headers, timeout=30)
        elif method == "PATCH":
            resp = await client.patch(url, headers=headers, json=body, timeout=30)
        elif method == "POST":
            resp = await client.post(url, headers=headers, json=body, timeout=30)
        else:
            return None
        if resp.status_code >= 400:
            print("Supabase {} error: {}".format(method, resp.text))
            return None
        return resp.json()


# === ヘルスチェック ===

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Rakushift Engine v3.0 Ready"}


@app.get("/keepalive")
async def keepalive():
    """Supabase無料プランの自動停止を防ぐためのヘルスチェック。
    Railwayのヘルスチェックと兼用。Supabaseへクエリを発行して
    プロジェクトをアクティブに保つ。"""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return {"status": "ok", "db": "skipped", "reason": "no credentials"}
    try:
        result = await supabase_query(
            "organizations", "select=id&limit=1", method="GET")
        row_count = len(result) if isinstance(result, list) else 0
        print("[Keepalive] Supabase ping OK - {} rows".format(row_count))
        return {"status": "ok", "db": "alive", "rows": row_count}
    except Exception as e:
        msg = repr(e)
        print("[Keepalive] Supabase ping FAILED: {}".format(msg))
        return {"status": "ok", "db": "error", "message": msg}


@app.post("/run-migration")
async def run_migration(request: Request):
    """HQ管理者テーブル・RPC関数のマイグレーションを実行。
    service_keyを使ってSupabase PostgreSQL RPCでSQLを直接実行する。
    セキュリティ: 環境変数MIGRATION_TOKENで保護。"""
    import httpx

    body = await request.json()
    token = body.get("token", "")
    migration_token = os.environ.get("MIGRATION_TOKEN", "rakushift_migrate_2026")

    if token != migration_token:
        return {"status": "error", "message": "Invalid migration token"}

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return {"status": "error", "message": "Supabase credentials not configured"}

    # HQ管理者マイグレーションSQL群を順番に実行
    sqls = [
        # 1. hq_adminsテーブル作成
        """CREATE TABLE IF NOT EXISTS hq_admins (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            login_id TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )""",
        # 2. 初期アカウント
        """INSERT INTO hq_admins (login_id, password) 
           VALUES ('hq_master', crypt('rakushift_hq', gen_salt('bf')))
           ON CONFLICT (login_id) DO NOTHING""",
        # 3. hq_login RPC
        """CREATE OR REPLACE FUNCTION hq_login(p_login_id TEXT, p_password TEXT) 
           RETURNS JSONB AS $fn$
           DECLARE v_admin RECORD;
           BEGIN
               SELECT * INTO v_admin FROM hq_admins WHERE login_id = p_login_id;
               IF NOT FOUND THEN 
                   RETURN jsonb_build_object('status', 'error', 'message', '本部IDが存在しません'); 
               END IF;
               IF v_admin.password = crypt(p_password, v_admin.password) THEN
                   RETURN jsonb_build_object('status', 'success', 'role', 'hq_admin', 'login_id', v_admin.login_id);
               ELSE
                   RETURN jsonb_build_object('status', 'error', 'message', 'パスワードが違います');
               END IF;
           END;
           $fn$ LANGUAGE plpgsql SECURITY DEFINER""",
        # 4. hq_get_all_shops RPC
        """CREATE OR REPLACE FUNCTION hq_get_all_shops() 
           RETURNS JSONB AS $fn$
           DECLARE res JSONB;
           BEGIN
               SELECT jsonb_agg(jsonb_build_object(
                   'organization_id', o.id, 'name', o.name,
                   'contract_id', c.contract_id, 'plan', c.stripe_plan,
                   'created_at', o.created_at
               ) ORDER BY o.created_at DESC) INTO res
               FROM organizations o JOIN config c ON o.id = c.organization_id;
               RETURN COALESCE(res, '[]'::jsonb);
           END;
           $fn$ LANGUAGE plpgsql SECURITY DEFINER""",
    ]

    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    results = []
    async with httpx.AsyncClient(timeout=30) as client:
        for i, sql in enumerate(sqls):
            try:
                # Supabase の pg_query RPC または直接 SQL 実行
                resp = await client.post(
                    "{}/rest/v1/rpc/exec_sql".format(SUPABASE_URL),
                    headers=headers,
                    json={"query": sql}
                )
                if resp.status_code == 404:
                    # exec_sql RPC が無い場合、Supabase Management API を試す
                    # 代替: supabase-py の admin機能を使う
                    results.append({"step": i+1, "status": "skipped", "reason": "exec_sql RPC not found"})
                elif resp.status_code < 300:
                    results.append({"step": i+1, "status": "ok"})
                else:
                    results.append({"step": i+1, "status": "error", "detail": resp.text[:200]})
            except Exception as e:
                results.append({"step": i+1, "status": "error", "detail": str(e)[:200]})

    return {"status": "completed", "results": results}



# =============================================================
# シフト生成 API
# =============================================================

@app.post("/check")
@limiter.limit("20/minute")
def check_feasibility(request: Request, req: ShiftRequest):
    try:
        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests)
        result = scheduler.pre_check()
        return {"status": "success", "check": result}
    except Exception as e:
        print("Check Error: {}".format(e))
        return {"status": "error", "message": str(e)}


@app.post("/generate")
@limiter.limit("10/minute")
def generate_shifts(request: Request, req: ShiftRequest):
    print("Received request: {} staff, {} dates, mode={}".format(
        len(req.staff_list), len(req.dates), req.mode))

    try:
        # Validate plan limits from DB to prevent bypass and DoS
        plan = req.config.get("stripe_plan", "standard")
        org_id = req.config.get("organization_id")
        if org_id and SUPABASE_SERVICE_KEY:
            try:
                import httpx
                url = "{}/rest/v1/config_safe?organization_id=eq.{}&select=stripe_plan&limit=1".format(SUPABASE_URL, org_id)
                headers = {"apikey": SUPABASE_SERVICE_KEY, "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY)}
                resp = httpx.get(url, headers=headers, timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    if data and isinstance(data, list) and len(data) > 0:
                        plan = data[0].get("stripe_plan", "standard")
            except Exception as e:
                print("Plan verification error: {}".format(e))

        limit = 10
        if plan == "pro": limit = 50
        if plan == "premium": limit = 9999
        if len(req.staff_list) > limit:
            return {"status": "error", "message": "スタッフ数がプラン上限({}名)を超過しています。".format(limit)}

        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests)


        force = (req.mode == "force")
        result = scheduler.solve(force=force)

        if not result:
            return {"status": "success", "mode": "math_failed", "shifts": []}

        # 生成結果のスタッフカバレッジをログ出力
        result_staff_ids = set(s["staff_id"] for s in result)
        print("[Generate] Result: {} shifts covering {}/{} staff".format(
            len(result), len(result_staff_ids), len(req.staff_list)))

        # Gemini監査 (環境変数のAPIキーを使用)
        gemini_key, gemini_model = get_gemini_key()
        if gemini_key:
            print("Running Gemini audit (server-side)...")
            audited = run_gemini_audit(gemini_key, gemini_model, req, result)
            if audited:
                # 監査結果の品質チェック: シフト数やスタッフカバレッジが大幅に減少していないか
                original_staff_ids = set(s["staff_id"] for s in result)
                audited_staff_ids = set(s["staff_id"] for s in audited)
                original_count = len(result)
                audited_count = len(audited)

                # シフト数が50%以下に減少、またはスタッフカバレッジが50%以下に減少した場合は監査結果を破棄
                if audited_count < original_count * 0.5:
                    print("[Gemini Audit] REJECTED: shift count dropped too much ({} -> {})".format(
                        original_count, audited_count))
                elif len(audited_staff_ids) < len(original_staff_ids) * 0.5:
                    print("[Gemini Audit] REJECTED: staff coverage dropped too much ({} -> {} staff)".format(
                        len(original_staff_ids), len(audited_staff_ids)))
                else:
                    result = audited
                    return {
                        "status": "success",
                        "mode": "math_plus_gemini_audit" if not force else "math_force_plus_gemini",
                        "shifts": result
                    }

        return {
            "status": "success",
            "mode": "math_force" if force else "math",
            "shifts": result
        }

    except Exception as e:
        print("Error: {}".format(e))
        import traceback
        traceback.print_exc()
        return {"status": "error", "message": str(e)}


# =============================================================
# AI診断 API
# =============================================================

@app.post("/diagnose")
@limiter.limit("10/minute")
def diagnose_shifts(request: Request, req: DiagnoseRequest):
    try:
        gemini_key, gemini_model = get_gemini_key()
        if not gemini_key:
            return {"status": "error", "message": "AI機能は現在利用できません", "suggestions": []}

        config = req.config
        staff_req = config.get("staff_req", {})
        break_rules = config.get("break_rules", [
            {"min_hours": 6, "break_minutes": 45},
            {"min_hours": 8, "break_minutes": 60}
        ])

        prompt = """あなたはプロの店舗マネージャーであり、日本の労働基準法に精通しています。
以下のシフトデータを分析し、改善点やリスクを指摘してください。

【店舗ルール】
- 営業時間: {} - {}
- 最低人数: 平日{}名, 土日{}名, 祝日{}名
- 最低管理者数: {}名
- 休憩ルール: {}

【日本の労働基準法チェック項目】
1. 1日8時間超の勤務がないか (労基法32条)
2. 週40時間超の勤務がないか (労基法32条)
3. 6時間超勤務で45分以上、8時間超勤務で60分以上の休憩があるか (労基法34条)
4. 週1日以上の休日があるか / 連続7日以上勤務がないか (労基法35条)

【スタッフ情報】
{}

【シフトデータ】
- スタッフ数: {}名
- シフト数: {}コマ
- 詳細: {}

【分析してほしいこと】
1. 労基法違反リスク（上記4項目）
2. 人員不足のリスク（特に土日やピークタイム）
3. 特定スタッフへの負荷偏り（連勤、長時間労働）
4. 管理者不在の時間帯
5. 新人が一人で入っている時間帯

回答は以下のJSON配列形式のみで出力してください。Markdownは不要です。
[
  {{"type": "danger", "title": "...", "desc": "...", "action": "..."}},
  {{"type": "warning", "title": "...", "desc": "...", "action": "..."}},
  {{"type": "info", "title": "...", "desc": "...", "action": "..."}}
]

typeは重要度順: danger(労基法違反) > warning(リスク) > info(改善提案)""".format(
            config.get("opening_time", "09:00"),
            config.get("closing_time", "22:00"),
            staff_req.get("min_weekday", 2),
            staff_req.get("min_weekend", 3),
            staff_req.get("min_holiday", 3),
            staff_req.get("min_manager", 1),
            json.dumps(break_rules, ensure_ascii=False),
            json.dumps([{
                "id": s.get("id", ""),
                "name": s.get("name", ""),
                "role": s.get("role", "staff"),
                "max_hours": s.get("max_hours_day", 8),
                "max_days": s.get("max_days_week", 5),
                "evaluation": s.get("evaluation", "B"),
                "salary_type": s.get("salary_type", "hourly"),
            } for s in req.staff_list], ensure_ascii=False),
            req.staff_count,
            req.shift_count,
            json.dumps(req.shifts[:500], ensure_ascii=False),  # 最大500件に拡張（月間シフト対応）
        )

        url = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}".format(
            gemini_model, gemini_key)
        resp = httpx.post(url, json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json"
            }
        }, timeout=60)

        if resp.status_code != 200:
            return {"status": "error",
                    "message": "AI応答エラー ({})".format(resp.status_code),
                    "suggestions": []}

        data = resp.json()
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
        if not text:
            return {"status": "error", "message": "AIからの応答がありません", "suggestions": []}

        suggestions = json.loads(text)
        return {"status": "success", "suggestions": suggestions}

    except Exception as e:
        print("Diagnose Error: {}".format(e))
        return {"status": "error", "message": str(e), "suggestions": []}


# =============================================================
# Gemini監査
# =============================================================

def run_gemini_audit(api_key: str, model: str, req: ShiftRequest, shifts: list) -> list:
    """Gemini APIでシフトを監査・修正 (サーバーサイド)"""
    try:
        url = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}".format(
            model, api_key)

        config = req.config
        staff_req = config.get("staff_req", {})
        break_rules = config.get("break_rules", [
            {"min_hours": 6, "break_minutes": 45},
            {"min_hours": 8, "break_minutes": 60}
        ])
        closed_days_names = []
        day_names = ["日", "月", "火", "水", "木", "金", "土"]
        for cd in config.get("closed_days", []):
            if 0 <= cd < 7:
                closed_days_names.append(day_names[cd])

        staff_info = []
        for s in req.staff_list:
            staff_info.append({
                "id": s["id"],
                "name": s.get("name", ""),
                "role": s.get("role", "staff"),
                "max_days": s.get("max_days_week", 5),
                "max_hours": s.get("max_hours_day", 8),
                "evaluation": s.get("evaluation", "B"),
                "salary_type": s.get("salary_type", "hourly"),
                "ng_dates": s.get("unavailable_dates", ""),
            })

        shift_summary = []
        for s in shifts:
            shift_summary.append({
                "staff_id": s["staff_id"],
                "date": s["date"],
                "start": s["start_time"],
                "end": s["end_time"],
            })

        prompt = """あなたは日本の労働基準法に精通した熟練シフト管理者AIです。
Pythonシステムが生成した「一次シフト案」を監査し、以下の全ルールに違反がないか検証してください。
違反があれば修正し、なければそのまま出力してください。

=== 絶対遵守ルール (違反は許されない) ===
1. スタッフの希望休(unavailable_dates/承認済みoff)には絶対に配置しない
2. 1日の最大労働時間(max_hours_day)を超えない
3. 週の最大勤務日数(max_days_week)を超えない
4. 連続7日以上の勤務を禁止 (労基法35条: 週1日以上の休日)
5. 週40時間を超える勤務を禁止 (労基法32条)
6. 定休日({})には配置しない
7. 臨時休業日({})には配置しない

=== 休憩ルール (労基法34条) ===
{}

=== 推奨ルール (可能な限り遵守) ===
- 管理者(manager/leader)が各シフトに最低{}名
- 平日最低{}名、土日最低{}名、祝日最低{}名
- 月給スタッフは週5日程度配置
- 新人(evaluation=D)がいる場合はメンター(manager/leader)も配置

=== 入力データ ===
【スタッフ】
{}

【対象日付】
{}

【一次シフト案】
{}

=== 出力形式 ===
修正後の完全なシフト表をJSON配列で出力してください。
**重要**: 純粋なJSON配列のみ出力。マークダウンや解説は不要。
[
  {{"staff_id": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "break_minutes": 60}},
  ...
]""".format(
            "、".join(closed_days_names) if closed_days_names else "なし",
            ", ".join(config.get("special_holidays", [])) if config.get("special_holidays") else "なし",
            json.dumps(break_rules, ensure_ascii=False),
            staff_req.get("min_manager", 1),
            staff_req.get("min_weekday", 2),
            staff_req.get("min_weekend", 3),
            staff_req.get("min_holiday", 3),
            json.dumps(staff_info, ensure_ascii=False),
            json.dumps(req.dates),
            json.dumps(shift_summary, ensure_ascii=False),
        )

        resp = httpx.post(url, json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "responseMimeType": "application/json"
            }
        }, timeout=90)

        if resp.status_code != 200:
            print("Gemini API error: {}".format(resp.status_code))
            return None

        data = resp.json()
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
        if not text:
            return None

        fixed = json.loads(text)

        # 配列でない場合の対応
        if isinstance(fixed, dict):
            fixed = fixed.get("shifts", fixed.get("data", []))
        if not isinstance(fixed, list):
            return None

        # データ整合性チェック・補完
        valid_staff_ids = {s["id"] for s in req.staff_list}
        valid_dates = set(req.dates)
        cleaned = []
        for s in fixed:
            if not all(k in s for k in ("staff_id", "date", "start_time", "end_time")):
                continue
            if s["staff_id"] not in valid_staff_ids:
                continue
            if s["date"] not in valid_dates:
                continue
            s.setdefault("break_minutes", 60)
            # 休憩時間の再計算（日またぎ対応）
            start_min = int(s["start_time"].split(":")[0]) * 60 + int(s["start_time"].split(":")[1])
            end_min = int(s["end_time"].split(":")[0]) * 60 + int(s["end_time"].split(":")[1])
            if end_min <= start_min:
                end_min += 1440  # 日またぎ: 24時間加算
            hours = (end_min - start_min) / 60.0
            if hours >= 8:
                s["break_minutes"] = max(s["break_minutes"], 60)
            elif hours >= 6:
                s["break_minutes"] = max(s["break_minutes"], 45)
            cleaned.append(s)

        if not cleaned:
            return None

        print("[Gemini Audit] {} -> {} shifts".format(len(shifts), len(cleaned)))
        return cleaned

    except Exception as e:
        print("Gemini audit error: {}".format(e))
        import traceback
        traceback.print_exc()
        return None


# =============================================================
# Stripe決済 API
# =============================================================

async def send_welcome_email(to_email: str, org_name: str, contract_id: str,
                             password: str, login_url: str, plan: str):
    """新規テナントへのウェルカムメール送信 (SMTP)"""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    smtp_host = _get_setting("smtp_host")
    smtp_port = int(_get_setting("smtp_port") or "587")
    smtp_user = _get_setting("smtp_user")
    smtp_pass = _get_setting("smtp_pass")
    smtp_from = _get_setting("smtp_from") or smtp_user

    if not smtp_host or not smtp_user or not smtp_pass:
        print("[Email] SMTP not configured. Skipping email to {}".format(to_email))
        print("[Email] Contract ID: {} (SMTP not configured, credentials not logged)".format(contract_id))
        return

    plan_name = {"standard": "Standard", "pro": "Pro", "premium": "Premium"}.get(plan, plan)

    subject = "【ラクシフトAI】ご契約ありがとうございます - ログイン情報のご案内"
    html_body = """
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #3b82f6, #6366f1); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">ラクシフトAI</h1>
        <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">AIシフト管理システム</p>
    </div>
    <div style="background: #fff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
        <h2 style="color: #1f2937; margin-top: 0;">ご契約ありがとうございます</h2>
        <p style="color: #4b5563;"><strong>{org_name}</strong> 様</p>
        <p style="color: #4b5563;">{plan_name}プランのご契約が完了しました。以下の情報でログインできます。</p>

        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 8px 0; color: #6b7280; width: 120px;">ログインURL</td><td style="padding: 8px 0;"><a href="{login_url}" style="color: #3b82f6; font-weight: bold;">{login_url}</a></td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">契約ID</td><td style="padding: 8px 0; font-family: monospace; font-size: 18px; font-weight: bold; color: #1f2937;">{contract_id}</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">店舗パスワード</td><td style="padding: 8px 0; font-family: monospace; font-weight: bold; color: #1f2937;">{password}</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">管理者ID</td><td style="padding: 8px 0; font-family: monospace; font-weight: bold; color: #1f2937;">admin</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">管理者パスワード</td><td style="padding: 8px 0; font-family: monospace; font-weight: bold; color: #1f2937;">{password}</td></tr>
                <tr><td style="padding: 8px 0; color: #6b7280;">プラン</td><td style="padding: 8px 0; font-weight: bold; color: #3b82f6;">{plan_name}</td></tr>
            </table>
        </div>

        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="color: #92400e; margin: 0; font-size: 13px;"><strong>セキュリティのお願い:</strong> ログイン後、設定画面からパスワードを変更してください。</p>
        </div>

        <h3 style="color: #1f2937; margin-top: 24px;">ご利用の流れ</h3>
        <ol style="color: #4b5563; line-height: 2;">
            <li>上記URLからログイン</li>
            <li>管理者ログインで管理画面に入る</li>
            <li>スタッフを登録</li>
            <li>シフト表を自動作成</li>
        </ol>

        <p style="color: #9ca3af; font-size: 12px; margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 15px;">
            このメールはラクシフトAIから自動送信されています。<br>
            ご不明な点がございましたら、運営までお問い合わせください。
        </p>
    </div>
</div>
""".format(
        org_name=org_name, plan_name=plan_name, login_url=login_url,
        contract_id=contract_id, password=password,
    )

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = smtp_from
        msg["To"] = to_email
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_from, to_email, msg.as_string())

        print("[Email] Sent to {}".format(to_email))
    except Exception as e:
        print("[Email] FAILED to {}: {}".format(to_email, e))


@app.post("/stripe/new-subscription")
@limiter.limit("5/minute")
async def new_subscription(request: Request, req: NewSubscriptionRequest):
    """新規お申し込み: 決済完了後にテナント自動作成+メール送信"""
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return JSONResponse(status_code=500, content={"error": "Stripe is not configured"})
    stripe.api_key = sk

    try:
        plan_key = {
            "standard": "stripe_price_standard",
            "pro": "stripe_price_pro",
            "premium": "stripe_price_premium",
        }.get(req.plan, "stripe_price_pro")
        price_id = _get_setting(plan_key)

        if not price_id:
            return JSONResponse(status_code=500,
                                content={"error": "Price ID not configured for plan: {}".format(req.plan)})

        if not req.success_url or not req.cancel_url:
            return JSONResponse(status_code=400,
                                content={"error": "success_url and cancel_url are required"})

        referrer_code = (req.referrer_code or "").strip().upper()

        # Stripeカスタマー作成
        customer = stripe.Customer.create(
            email=req.email,
            name=req.org_name,
            phone=req.phone,
            address={"line1": req.address} if req.address else None,
            metadata={
                "org_name": req.org_name,
                "plan": req.plan,
                "contact_name": req.contact_name,
                "phone": req.phone,
                "contact_phone": req.contact_phone,
                "address": req.address,
                "referrer_code": referrer_code,
            }
        )

        # チェックアウトセッション (テナント未作成のため contract_id なし)
        session = stripe.checkout.Session.create(
            customer=customer.id,
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="subscription",
            success_url=req.success_url,
            cancel_url=req.cancel_url,
            metadata={
                "type": "new_subscription",
                "org_name": req.org_name,
                "email": req.email,
                "plan": req.plan,
                "contact_name": req.contact_name,
                "phone": req.phone,
                "contact_phone": req.contact_phone,
                "address": req.address,
                "referrer_code": referrer_code,
            },
            subscription_data={
                "metadata": {
                    "type": "new_subscription",
                    "org_name": req.org_name,
                    "email": req.email,
                    "plan": req.plan,
                    "contact_name": req.contact_name,
                    "phone": req.phone,
                    "contact_phone": req.contact_phone,
                    "address": req.address,
                    "referrer_code": referrer_code,
                }
            },
            allow_promotion_codes=True,
        )

        return {"url": session.url, "session_id": session.id}

    except stripe.error.StripeError as e:
        print("Stripe Error: {}".format(e))
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        print("New Subscription Error: {}".format(e))
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/stripe/create-checkout")
@limiter.limit("5/minute")
async def create_checkout_session(request: Request, req: CheckoutRequest):
    """Stripeチェックアウトセッション作成"""
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return JSONResponse(status_code=500,
                            content={"error": "Stripe is not configured"})
    stripe.api_key = sk

    try:
        # contract_idからconfigを取得してstripe_customer_idを確認
        configs = await supabase_query(
            "config",
            "contract_id=eq.{}&select=id,organization_id,stripe_customer_id,contract_id".format(
                req.contract_id))

        if not configs or len(configs) == 0:
            return JSONResponse(status_code=404,
                                content={"error": "Contract not found"})

        config = configs[0]
        customer_id = config.get("stripe_customer_id")

        # Stripeカスタマーが未作成なら作成
        if not customer_id:
            customer = stripe.Customer.create(
                metadata={
                    "contract_id": req.contract_id,
                    "organization_id": config.get("organization_id", ""),
                }
            )
            customer_id = customer.id
            # DBに保存
            await supabase_query(
                "config",
                "id=eq.{}".format(config["id"]),
                method="PATCH",
                body={"stripe_customer_id": customer_id}
            )

        # プランに応じた価格ID (DB設定優先)
        plan_key = {
            "standard": "stripe_price_standard",
            "pro": "stripe_price_pro",
            "premium": "stripe_price_premium",
        }.get(req.plan, "stripe_price_standard")
        price_id = _get_setting(plan_key)

        if not price_id:
            return JSONResponse(status_code=500,
                                content={"error": "Price ID not configured for plan: {}".format(req.plan)})

        # チェックアウトセッション作成
        # フロントエンドから送信されたURLを優先使用
        if not req.success_url or not req.cancel_url:
            if not FRONTEND_URL:
                return JSONResponse(status_code=400,
                                    content={"error": "success_url and cancel_url are required"})
        success_url = req.success_url or "{}/index.html?payment=success".format(FRONTEND_URL)
        cancel_url = req.cancel_url or "{}/index.html?payment=cancelled".format(FRONTEND_URL)

        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=["card"],
            line_items=[{
                "price": price_id,
                "quantity": 1,
            }],
            mode="subscription",
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                "contract_id": req.contract_id,
            },
            subscription_data={
                "metadata": {
                    "contract_id": req.contract_id,
                }
            },
            allow_promotion_codes=True,
        )

        return {"url": session.url, "session_id": session.id}

    except stripe.error.StripeError as e:
        print("Stripe Error: {}".format(e))
        return JSONResponse(status_code=400,
                            content={"error": str(e)})
    except Exception as e:
        print("Checkout Error: {}".format(e))
        return JSONResponse(status_code=500,
                            content={"error": str(e)})


@app.post("/stripe/create-portal")
async def create_portal_session(req: PortalRequest):
    """Stripeカスタマーポータルセッション作成 (プラン変更・解約用)"""
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return JSONResponse(status_code=500,
                            content={"error": "Stripe is not configured"})
    stripe.api_key = sk

    try:
        configs = await supabase_query(
            "config",
            "contract_id=eq.{}&select=stripe_customer_id".format(req.contract_id))

        if not configs or len(configs) == 0:
            return JSONResponse(status_code=404,
                                content={"error": "Contract not found"})

        customer_id = configs[0].get("stripe_customer_id")
        if not customer_id:
            return JSONResponse(status_code=400,
                                content={"error": "No Stripe subscription found"})

        if not req.return_url and not FRONTEND_URL:
            return JSONResponse(status_code=400,
                                content={"error": "return_url is required"})
        return_url = req.return_url or "{}/index.html".format(FRONTEND_URL)

        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
        )

        return {"url": session.url}

    except Exception as e:
        print("Portal Error: {}".format(e))
        return JSONResponse(status_code=500,
                            content={"error": str(e)})


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    """Stripeウェブフック - サブスクリプション状態の自動同期"""
    _load_platform_settings()
    webhook_secret = _get_setting("stripe_webhook_secret")
    if not webhook_secret:
        return JSONResponse(status_code=500,
                            content={"error": "Webhook secret not configured"})

    # Stripe APIキーも設定
    sk = _get_setting("stripe_secret_key")
    if sk:
        stripe.api_key = sk

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, webhook_secret
        )
    except ValueError:
        return JSONResponse(status_code=400,
                            content={"error": "Invalid payload"})
    except stripe.error.SignatureVerificationError:
        return JSONResponse(status_code=400,
                            content={"error": "Invalid signature"})

    event_type = event["type"]
    data = event["data"]["object"]
    print("[Stripe Webhook] Event: {}".format(event_type))

    try:
        if event_type == "checkout.session.completed":
            metadata = data.get("metadata", {})
            subscription_id = data.get("subscription")
            customer_id = data.get("customer")
            customer_email = data.get("customer_details", {}).get("email") or metadata.get("email", "")

            if metadata.get("type") == "new_subscription":
                # === 新規申し込み: テナント自動作成 + メール送信 ===
                org_name = metadata.get("org_name", "新規店舗")
                plan = metadata.get("plan", "pro")
                contact_name = metadata.get("contact_name", "")
                phone = metadata.get("phone", "")
                contact_phone = metadata.get("contact_phone", "")
                address = metadata.get("address", "")
                referrer_code = (metadata.get("referrer_code", "") or "").strip().upper()

                # 1. テナント作成
                tenant_result = await supabase_rpc("create_tenant", {"p_org_name": org_name})
                if isinstance(tenant_result, dict) and tenant_result.get("status") == "success":
                    new_contract_id = tenant_result["contract_id"]

                    # 2. Stripe情報+顧客情報をconfigに紐付け
                    config_update = {
                        "stripe_customer_id": customer_id,
                        "stripe_subscription_id": subscription_id,
                        "subscription_status": "active",
                        "stripe_plan": plan,
                        "customer_email": customer_email,
                        "contact_name": contact_name,
                        "phone": phone,
                        "contact_phone": contact_phone,
                        "address": address,
                    }
                    if referrer_code:
                        config_update["referrer_code"] = referrer_code

                    await supabase_query(
                        "config",
                        "contract_id=eq.{}".format(new_contract_id),
                        method="PATCH",
                        body=config_update
                    )

                    # 3. メール自動送信（決済完了→即座にログイン情報を送信）
                    login_url = FRONTEND_URL or "https://rakushift-ai.pages.dev"
                    if customer_email:
                        await send_welcome_email(
                            to_email=customer_email,
                            org_name=org_name,
                            contract_id=new_contract_id,
                            password="rakushift1234",
                            login_url=login_url,
                            plan=plan,
                        )
                    else:
                        print("[Webhook] WARNING: No email for tenant {}".format(new_contract_id))
                    print("[Webhook] NEW TENANT created: {} email={} plan={}".format(
                        new_contract_id, customer_email, plan))
                else:
                    print("[Webhook] Tenant creation FAILED: {}".format(tenant_result))

            elif metadata.get("contract_id"):
                # === 既存テナントのプラン変更 ===
                contract_id = metadata["contract_id"]
                await supabase_query(
                    "config",
                    "contract_id=eq.{}".format(contract_id),
                    method="PATCH",
                    body={
                        "stripe_customer_id": customer_id,
                        "stripe_subscription_id": subscription_id,
                        "subscription_status": "active",
                        "payment_failed_at": None,
                    }
                )
                print("[Webhook] Subscription activated for: {}".format(contract_id))

        elif event_type in (
            "customer.subscription.updated",
            "customer.subscription.deleted",
        ):
            # サブスクリプション更新・解約
            subscription_id = data.get("id")
            status = data.get("status")  # active, past_due, canceled, unpaid, etc.
            contract_id = data.get("metadata", {}).get("contract_id")

            # contract_idがmetadataにない場合、subscription_idで検索
            if not contract_id and subscription_id:
                configs = await supabase_query(
                    "config",
                    "stripe_subscription_id=eq.{}&select=contract_id".format(subscription_id))
                if configs and len(configs) > 0:
                    contract_id = configs[0].get("contract_id")

            if contract_id:
                update_data = {"subscription_status": status}

                # プラン変更の検出 (subscription.updated時)
                if event_type == "customer.subscription.updated" and status == "active":
                    items = data.get("items", {}).get("data", [])
                    if items:
                        price_id = items[0].get("price", {}).get("id", "")
                        # 価格IDからプランを逆引き
                        _load_platform_settings()
                        for plan_key in ("standard", "pro", "premium"):
                            setting_key = "stripe_price_{}".format(plan_key)
                            if _get_setting(setting_key) == price_id:
                                update_data["stripe_plan"] = plan_key
                                print("[Webhook] Plan changed to: {}".format(plan_key))
                                break

                # 解約された場合はライセンスも停止
                if status == "canceled":
                    update_data["subscription_status"] = "canceled"
                    # ライセンス停止RPCを呼ぶ
                    configs = await supabase_query(
                        "config",
                        "contract_id=eq.{}&select=organization_id".format(contract_id))
                    if configs and len(configs) > 0:
                        org_id = configs[0].get("organization_id")
                        if org_id:
                            await supabase_rpc("suspend_license", {
                                "p_organization_id": org_id,
                                "p_note": "Stripe subscription canceled"
                            })

                await supabase_query(
                    "config",
                    "contract_id=eq.{}".format(contract_id),
                    method="PATCH",
                    body=update_data
                )
                print("[Webhook] Subscription {} -> {} for: {}".format(
                    event_type, status, contract_id))

        elif event_type == "invoice.payment_failed":
            # 支払い失敗
            customer_id = data.get("customer")
            if customer_id:
                configs = await supabase_query(
                    "config",
                    "stripe_customer_id=eq.{}&select=contract_id,organization_id,payment_failed_at".format(customer_id))
                if configs and len(configs) > 0:
                    contract_id = configs[0].get("contract_id")
                    org_id = configs[0].get("organization_id")
                    existing_failed_at = configs[0].get("payment_failed_at")
                    if contract_id:
                        update_body = {"subscription_status": "past_due"}
                        # 初回の支払い失敗時のみタイムスタンプを記録
                        if not existing_failed_at:
                            import datetime
                            update_body["payment_failed_at"] = datetime.datetime.utcnow().isoformat()

                        await supabase_query(
                            "config",
                            "contract_id=eq.{}".format(contract_id),
                            method="PATCH",
                            body=update_body
                        )

                        # 3週間(21日)経過チェック → 自動ライセンス停止
                        if existing_failed_at and org_id:
                            import datetime
                            try:
                                failed_date = datetime.datetime.fromisoformat(existing_failed_at.replace("Z", "+00:00"))
                                days_since = (datetime.datetime.now(datetime.timezone.utc) - failed_date).days
                                if days_since >= 21:
                                    await supabase_rpc("suspend_license", {
                                        "p_organization_id": org_id,
                                        "p_note": "決済未対応21日超過のため自動停止"
                                    })
                                    print("[Webhook] Auto-suspended after 21 days: {}".format(contract_id))
                            except Exception as date_err:
                                print("[Webhook] Date parse error: {}".format(date_err))

                        print("[Webhook] Payment failed for: {}".format(contract_id))

    except Exception as e:
        print("[Webhook Error] {}".format(e))
        import traceback
        traceback.print_exc()

    return {"received": True}


class SendWelcomeEmailRequest(BaseModel):
    contract_id: str
    email: str
    org_name: str
    plan: str = "standard"


@app.post("/admin/send-welcome-email")
async def admin_send_welcome_email(req: SendWelcomeEmailRequest):
    """管理画面から手動で案内メールを送信"""
    _load_platform_settings()

    # configからcustomer_emailも更新
    await supabase_query(
        "config",
        "contract_id=eq.{}".format(req.contract_id),
        method="PATCH",
        body={"customer_email": req.email}
    )

    login_url = FRONTEND_URL or "https://rakushift-ai.pages.dev"
    password = "rakushift1234"

    try:
        await send_welcome_email(
            to_email=req.email,
            org_name=req.org_name,
            contract_id=req.contract_id,
            password=password,
            login_url=login_url,
            plan=req.plan,
        )
        return {"success": True, "message": "メールを送信しました: {}".format(req.email)}
    except Exception as e:
        return JSONResponse(status_code=500,
                            content={"error": "メール送信に失敗しました: {}".format(str(e))})


@app.get("/stripe/subscription-status/{contract_id}")
async def get_subscription_status(contract_id: str):
    """現在のサブスクリプション状態を取得"""
    try:
        configs = await supabase_query(
            "config",
            "contract_id=eq.{}&select=subscription_status,stripe_subscription_id,stripe_customer_id".format(
                contract_id))

        if not configs or len(configs) == 0:
            return {"status": "not_found"}

        config = configs[0]
        result = {
            "status": config.get("subscription_status", "active"),
            "has_subscription": bool(config.get("stripe_subscription_id")),
        }

        # Stripeから最新情報を取得
        _load_platform_settings()
        sub_id = config.get("stripe_subscription_id")
        sk = _get_setting("stripe_secret_key")
        if sub_id and sk:
            stripe.api_key = sk
            try:
                sub = stripe.Subscription.retrieve(sub_id)
                result["status"] = sub.status
                result["current_period_end"] = sub.current_period_end
                result["cancel_at_period_end"] = sub.cancel_at_period_end

                # DBの状態と同期
                if sub.status != config.get("subscription_status"):
                    await supabase_query(
                        "config",
                        "contract_id=eq.{}".format(contract_id),
                        method="PATCH",
                        body={"subscription_status": sub.status}
                    )
            except stripe.error.StripeError as e:
                print(f"[Warning] Stripe API Error: {e}")

        return result

    except Exception as e:
        print("Status Error: {}".format(e))
        return {"status": "error", "message": str(e)}


# =========================================================
# お問い合わせフォーム → メール送信
# =========================================================
@app.post("/api/inquiry")
@limiter.limit("5/minute")
async def submit_inquiry(req: InquiryRequest, request: Request):
    """法人お問い合わせを受信してメール送信"""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    from datetime import datetime

    # メール送信先（環境変数で設定）
    to_email = os.environ.get("INQUIRY_EMAIL_TO", "")
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")

    # メール本文を構築
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━
  ラクシフト AI - 法人お問い合わせ
  受信日時: {now}
━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 会社情報
  会社名:     {req.company_name}
  会社住所:   {req.company_address}
  連絡先:     {req.phone}
  担当者名:   {req.contact_name}

■ 契約予定プラン
  {req.plan_summary or '未選択'}
  ├ ライトプラン:       {req.light_plan_count}件
  ├ スタンダードプラン:  {req.standard_plan_count}件
  └ プレミアムプラン:    {req.premium_plan_count}件

■ ご連絡希望日程
  希望曜日:   {req.preferred_days or '指定なし'}
  希望時間帯: {req.preferred_time or '指定なし'}

■ その他ご要望
  {req.message or 'なし'}

━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

    print(f"[Inquiry] Received from {req.company_name} ({req.contact_name})")
    print(body)

    # Supabaseにも保存を試行
    try:
        inquiry_data = {
            "company_name": req.company_name,
            "company_address": req.company_address,
            "phone": req.phone,
            "contact_name": req.contact_name,
            "plan_summary": req.plan_summary,
            "preferred_days": req.preferred_days,
            "preferred_time": req.preferred_time,
            "message": req.message,
            "status": "new"
        }
        await supabase_query("inquiries", method="POST", body=inquiry_data)
        print("[Inquiry] Saved to DB")
    except Exception as db_err:
        print(f"[Inquiry] DB save skipped: {db_err}")

    # メール送信
    if to_email and smtp_user and smtp_pass:
        try:
            msg = MIMEMultipart()
            msg["From"] = smtp_user
            msg["To"] = to_email
            msg["Subject"] = f"【ラクシフト】法人お問い合わせ - {req.company_name}"
            msg.attach(MIMEText(body, "plain", "utf-8"))

            with smtplib.SMTP(smtp_host, smtp_port) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)

            print(f"[Inquiry] Email sent to {to_email}")
            return {"success": True, "message": "お問い合わせを受け付けました。メール送信完了。"}
        except Exception as mail_err:
            print(f"[Inquiry] Email failed: {mail_err}")
            return {"success": True, "message": "お問い合わせを受け付けました。（メール送信に一時的な問題が発生しましたが、データは保存済みです）"}
    else:
        print("[Inquiry] Email not configured. Set INQUIRY_EMAIL_TO, SMTP_USER, SMTP_PASS env vars.")
        return {"success": True, "message": "お問い合わせを受け付けました。"}


# deploy: 20260516-0508
