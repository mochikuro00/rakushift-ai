import os
import json
import hmac
import hashlib
import html as _html
import asyncio
import logging
import datetime as _datetime_module
import httpx
import stripe
from fastapi import FastAPI, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from scheduler import ShiftScheduler

# 構造化ログ。本番では INFO 以上、DEBUG/PII は出さない
logging.basicConfig(
    level=logging.INFO if os.environ.get("RAILWAY_ENVIRONMENT", "") == "production" else logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rakushift")

# 本番環境フラグ（ログの個人情報マスク等に使用）
# v3.7.14 failsafe: 環境変数が未設定の場合は **本番扱い** (詳細エラー非露出)。
# 明示的に "development" を設定したときだけ詳細露出を許可する。
_env = os.environ.get("RAILWAY_ENVIRONMENT", "").strip().lower()
_is_prod_flag = os.environ.get("IS_PRODUCTION", "").strip().lower()
IS_PRODUCTION = not (_env == "development" or _is_prod_flag in ("0", "false", "dev"))

# レート制限設定
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="Rakushift AI Engine", version="3.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# v3.7.132 / v3.7.137: エラー通知 webhook (Slack/Discord 互換)
# ERROR_WEBHOOK_URL 環境変数があれば、未捕捉例外を webhook で通知
_ERROR_WEBHOOK_URL = os.environ.get("ERROR_WEBHOOK_URL", "")
_WEBHOOK_DEDUPE_CACHE = {}  # {error_signature: last_sent_ts} で重複通知抑制
_WEBHOOK_REENTRY_GUARD = False  # v3.7.137: 無限ループ防止フラグ

def _notify_error_webhook(label: str, detail: str, traceback_str: str = ""):
    """Slack/Discord webhook にエラーを通知 (同じ signature は 5分間 抑制)

    v3.7.137: webhook 通知自体が例外を起こした場合、global_exception_handler が
    再度この関数を呼ぶことで無限ループになるのを防ぐ。
    """
    global _WEBHOOK_REENTRY_GUARD
    if not _ERROR_WEBHOOK_URL or _WEBHOOK_REENTRY_GUARD:
        return
    _WEBHOOK_REENTRY_GUARD = True
    try:
        import time as _t
        # sig は abs() で正規化して負数の hash 衝突を避ける
        sig = (label + detail[:100]).encode("utf-8", errors="ignore")[:200]
        sig_key = abs(hash(sig))
        now = _t.time()
        last = _WEBHOOK_DEDUPE_CACHE.get(sig_key, 0)
        if now - last < 300:  # 5分以内は同じエラーをスキップ
            return
        _WEBHOOK_DEDUPE_CACHE[sig_key] = now
        # 古いエントリを掃除 (10分超のものは削除)
        for k in list(_WEBHOOK_DEDUPE_CACHE.keys()):
            if now - _WEBHOOK_DEDUPE_CACHE[k] > 600:
                _WEBHOOK_DEDUPE_CACHE.pop(k, None)
        body = (f":rotating_light: *Rakushift Backend Error*\n"
                f"*Label:* {label}\n"
                f"*Detail:* {detail[:500]}\n")
        if traceback_str:
            body += f"```\n{traceback_str[:1500]}\n```"
        payload = {"text": body, "content": body}  # Slack/Discord 両対応
        try:
            with httpx.Client(timeout=5.0) as client:
                client.post(_ERROR_WEBHOOK_URL, json=payload)
        except Exception as e:
            # webhook 失敗は logger だけ、絶対に例外を上げない
            try:
                logger.warning("error webhook delivery failed: %s", e)
            except Exception:
                pass
    except Exception:
        # 万が一の例外もここで握りつぶす (絶対に再エントリさせない)
        pass
    finally:
        _WEBHOOK_REENTRY_GUARD = False

# CORS設定: 本番ドメインのみ許可
# 環境変数で固定オリジン (CSV) を上書き可。それと別に Cloudflare Pages の preview
# (xxx.rakushift-ai.pages.dev) 等のワイルドカードドメインは allow_origin_regex で対応
# (CORSMiddleware の allow_origins は完全一致のみ。glob は機能しない)
_env_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
ALLOWED_ORIGINS = _env_origins or [
    "https://rakushift-ai.pages.dev",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
]
# Cloudflare Pages のプレビュー / 本番、Railway デプロイ URL を regex で許可
ALLOWED_ORIGIN_REGEX = r"^https://([a-z0-9-]+\.)*rakushift-ai\.pages\.dev$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
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

# グローバルhttpxクライアント（接続プール再利用でレイテンシ削減）
_http_client = None


def _get_http_client():
    """httpxクライアントのシングルトン取得"""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=30)
    return _http_client


@app.on_event("shutdown")
async def shutdown_event():
    """アプリ終了時にhttpxクライアントをクローズ"""
    global _http_client
    if _http_client:
        await _http_client.aclose()
        _http_client = None


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
                logger.info("Platform settings loaded: %d keys", len(data))
                # Stripeキーが設定されていれば適用
                sk = data.get("stripe_secret_key", "")
                if sk:
                    stripe.api_key = sk
    except Exception as e:
        # v3.7.137: 例外メッセージにレスポンス本文が含まれる可能性があるため
        # 型名のみログ出力 (SERVICE_KEY 等のヘッダー漏洩防止)
        logger.info("[Settings] Load failed: %s", type(e).__name__)


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
    # empty_only モードで既存シフトを固定するため、フロントから既存シフトを渡せるように
    existing_shifts: List[Dict[str, Any]] = []


class DiagnoseRequest(BaseModel):
    contract_id: Optional[str] = None
    config: Dict[str, Any] = {}
    staff_count: int = 0
    shift_count: int = 0
    shifts: List[Dict[str, Any]] = []
    staff_list: List[Dict[str, Any]] = []


class InquiryRequest(BaseModel):
    """法人お問い合わせフォーム

    v3.7.137: max_length / 範囲制限を追加 (DoS / 異常入力対策)
    """
    company_name: str = Field(min_length=1, max_length=200)
    business_name: str = Field(default="", max_length=200)  # v3.7.267: 事業者名
    email: str = Field(default="", max_length=200)          # v3.7.267: メールアドレス
    company_address: str = Field(default="", max_length=300)
    phone: str = Field(min_length=1, max_length=40)
    contact_name: str = Field(min_length=1, max_length=100)
    contact_phone: str = Field(default="", max_length=40)
    plan_summary: str = Field(default="", max_length=200)
    # フロントは <input type="number"> の文字列値を送信するため str で受け、
    # DB INSERT 時に int に変換する。Pydantic v2 では Union/Strict が複雑なので str のまま保持。
    light_plan_count: str = Field(default="0", max_length=4)
    standard_plan_count: str = Field(default="0", max_length=4)
    premium_plan_count: str = Field(default="0", max_length=4)
    preferred_days: str = Field(default="", max_length=200)
    preferred_time: str = Field(default="", max_length=100)
    schedule_summary: str = Field(default="", max_length=300)
    message: str = Field(default="", max_length=2000)
    referrer_code: str = Field(default="", max_length=20)  # v3.7.268


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
    client = _get_http_client()
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
    client = _get_http_client()
    if method == "GET":
        resp = await client.get(url, headers=headers, timeout=30)
    elif method == "PATCH":
        resp = await client.patch(url, headers=headers, json=body, timeout=30)
    elif method == "POST":
        resp = await client.post(url, headers=headers, json=body, timeout=30)
    else:
        return None
    if resp.status_code >= 400:
        logger.info("Supabase {} error: {}".format(method, resp.text))
        return None
    return resp.json()


def _validate_redirect_url(url: str) -> bool:
    """リダイレクトURLが許可ドメインか検証（オープンリダイレクト防止）"""
    if not url:
        return False
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        allowed = [
            "rakushift-ai.pages.dev",
            "localhost",
            "127.0.0.1",
        ]
        # FRONTEND_URLのホストも許可
        if FRONTEND_URL:
            fe_host = urlparse(FRONTEND_URL).hostname
            if fe_host:
                allowed.append(fe_host)
        return any(host == a or host.endswith("." + a) for a in allowed)
    except Exception:
        return False


async def verify_session_org_id(session_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """セッションID (x-session-id ヘッダー) から organization_id と role を取得。
    返り値: {"organization_id": "...", "role": "shop|admin|hq_admin"} or None
    SERVICE_KEY で auth_sessions を直接参照 (RLS バイパス)。期限切れ・不存在は None。
    """
    if not session_id or not SUPABASE_SERVICE_KEY or not SUPABASE_URL:
        return None
    try:
        # v3.7.185: session_id は外部ヘッダー由来。生補間だと PostgREST クエリに
        # `&` 等で別フィルタを注入できてしまうため、値を URL エンコードして渡す。
        from urllib.parse import quote
        url = "{}/rest/v1/auth_sessions?id=eq.{}&select=organization_id,role,expires_at".format(
            SUPABASE_URL, quote(str(session_id), safe=""))
        client = _get_http_client()
        resp = await client.get(url, headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
        }, timeout=5)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not data:
            return None
        row = data[0]
        # 期限切れチェック
        from datetime import datetime, timezone
        try:
            expires_at = datetime.fromisoformat(str(row.get("expires_at", "")).replace("Z", "+00:00"))
            if expires_at < datetime.now(timezone.utc):
                return None
        except Exception:
            return None
        return {
            "organization_id": row.get("organization_id"),
            "role": row.get("role"),
        }
    except Exception:
        return None


# v3.7.132: グローバル例外ハンドラ - 未捕捉例外を webhook で通知
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    import traceback as _tb
    tb_str = _tb.format_exc()
    path = str(request.url.path) if request and request.url else "?"
    logger.error("[Unhandled] %s at %s\n%s", type(exc).__name__, path, tb_str)
    _notify_error_webhook(
        label=f"{type(exc).__name__} at {path}",
        detail=str(exc),
        traceback_str=tb_str,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error. Administrators have been notified."},
    )


# === ヘルスチェック ===

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Rakushift Engine v3.7.13 Ready",
            "build": "2026.06.01-v3.7.13-standing-pref-bonus"}


@app.get("/health")
async def health_check():
    """Railway/Cloudflare 用の本物のヘルスチェック。
    DB 疎通が取れて初めて 200 を返す。NG なら 503 で restart を促す。"""
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        # シークレット未設定は構成エラー扱い
        return JSONResponse(status_code=503, content={"status": "error", "db": "not_configured"})
    try:
        client = _get_http_client()
        resp = await client.get(
            "{}/rest/v1/organizations".format(SUPABASE_URL),
            params={"select": "id", "limit": "1"},
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY),
            },
            timeout=5,
        )
        if resp.status_code != 200:
            return JSONResponse(status_code=503, content={"status": "error", "db": "http_{}".format(resp.status_code)})
        return {"status": "ok", "db": "alive", "version": "3.7.285"}
    except Exception as e:
        logger.warning("health check failed: %s", e)
        return JSONResponse(status_code=503, content={"status": "error", "db": "unreachable"})


# === 管理者ログイン認証 (v3.7.233) ===
# DB の verify_admin_login RPC が config.admin_password を照合しない環境
# (migration 73 未適用) でも、変更後の管理者パスワードで確実にログイン
# できるよう、サーバ側で bcrypt 照合する。マスターパスワードは常時有効。

class AdminLoginAuthRequest(BaseModel):
    contract_id: str = Field(..., max_length=32)
    password: str = Field(..., max_length=128)


MASTER_ADMIN_PASSWORD = "rakushift1234"  # migration 31/73 と同一 (運営者判断で残存)


@app.post("/auth/admin-login")
@limiter.limit("10/minute")
async def auth_admin_login(request: Request, req: AdminLoginAuthRequest):
    import re as _re
    cid = (req.contract_id or "").strip()
    pw = req.password or ""
    if not _re.match(r"^[A-Za-z0-9_\-]{1,32}$", cid) or not pw:
        return {"success": False, "definitive": False, "message": "入力が不正です"}

    from urllib.parse import quote as _q
    rows = await supabase_query(
        "config",
        "contract_id=eq.{}&select=organization_id,admin_password".format(_q(cid, safe="")))
    if rows is None:
        # DB 到達不能: フロントは RPC フォールバックへ
        return {"success": False, "definitive": False, "message": "認証サーバに接続できません"}
    if not rows:
        return {"success": False, "definitive": True, "message": "契約IDが見つかりません"}

    row = rows[0]
    stored = row.get("admin_password") or ""
    pw_b = pw.encode("utf-8")
    # compare_digest は str 同士だと非ASCII (日本語等) で TypeError → bytes で比較
    ok = hmac.compare_digest(pw_b, MASTER_ADMIN_PASSWORD.encode("utf-8"))
    if not ok and stored:
        if stored.startswith("$2"):
            try:
                import bcrypt as _bcrypt
                ok = _bcrypt.checkpw(pw_b[:72], stored.encode("utf-8"))
            except Exception as e:
                logger.warning("admin-login bcrypt error: %s", e)
                return {"success": False, "definitive": False, "message": "認証処理エラー"}
        else:
            # レガシー平文 (migration 31 と同一仕様)
            ok = hmac.compare_digest(stored.encode("utf-8"), pw_b)

    if not ok and not stored:
        # 管理者パスワード未設定テナント: ここで確定失敗にすると従来の
        # RPC フォールバック (店舗パスワードでの管理者ログイン) を塞いでしまうため、
        # definitive=false でフロント側のフォールバックに委ねる
        return {"success": False, "definitive": False,
                "message": "管理者パスワードが未設定です"}

    if not ok:
        try:
            await supabase_rpc("record_login_failure", {"p_identifier": "admin:" + cid})
        except Exception:
            pass
        return {"success": False, "definitive": True, "message": "パスワードが正しくありません"}

    # セッション発行 (24h) — python 側の generate 等が auth_sessions を参照するため
    session_id = None
    try:
        from datetime import datetime, timedelta, timezone
        exp = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        created = await supabase_query("auth_sessions", "", method="POST", body={
            "organization_id": row.get("organization_id"),
            "role": "admin",
            "expires_at": exp,
        })
        if isinstance(created, list) and created:
            session_id = created[0].get("id")
    except Exception as e:
        logger.warning("admin-login session create failed: %s", e)

    try:
        await supabase_rpc("clear_login_failures", {"p_identifier": "admin:" + cid})
    except Exception:
        pass

    return {"success": True, "organization_id": row.get("organization_id"),
            "session_id": session_id, "name": "管理者", "role": "admin"}


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
        logger.info("[Keepalive] Supabase ping OK - {} rows".format(row_count))
        return {"status": "ok", "db": "alive", "rows": row_count}
    except Exception as e:
        msg = repr(e)
        logger.info("[Keepalive] Supabase ping FAILED: {}".format(msg))
        return {"status": "ok", "db": "error", "message": "DB接続エラー" if IS_PRODUCTION else msg}


@app.post("/run-migration")
async def run_migration(request: Request):
    """HQ管理者テーブル・RPC関数のマイグレーションを実行。
    service_keyを使ってSupabase PostgreSQL RPCでSQLを直接実行する。
    セキュリティ: 環境変数MIGRATION_TOKENで保護。"""

    body = await request.json()
    token = body.get("token", "")
    migration_token = os.environ.get("MIGRATION_TOKEN", "")

    if not migration_token:
        return {"status": "error", "message": "MIGRATION_TOKEN not configured. Set it as an environment variable."}

    # v3.7.185: 定数時間比較 (タイミング攻撃対策)。SQL を直接実行する重要エンドポイント。
    if not hmac.compare_digest(str(token), str(migration_token)):
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
                    results.append({"step": i+1, "status": "error", "detail": "SQL実行エラー" if IS_PRODUCTION else resp.text[:200]})
            except Exception as e:
                results.append({"step": i+1, "status": "error", "detail": "SQL実行エラー" if IS_PRODUCTION else str(e)[:200]})

    return {"status": "completed", "results": results}



# =============================================================
# 本部管理 API
# =============================================================

@app.get("/hq/shops")
async def hq_get_shops(request: Request):
    """本部用: 全テナント店舗一覧を取得（サービスキーでRLSバイパス）"""
    # セッション認証（HQセッションのみ許可）
    # v3.7.185: 旧版は session_id の "hq_" プレフィックスのみ確認しており、
    # 任意の "hq_xxx" ヘッダーで全テナントの contract_id/メールが漏洩していた。
    # auth_sessions を DB 検証し role=hq_admin のみ許可する。
    session_id = request.headers.get("x-session-id", "")
    session_info = await verify_session_org_id(session_id)
    if not session_info or session_info.get("role") != "hq_admin":
        return JSONResponse(status_code=403, content={"error": "本部認証が必要です"})

    try:
        # organizationsテーブルから全店舗取得
        orgs = await supabase_query(
            "organizations",
            "select=id,name,created_at,license_status&order=created_at.desc"
        )
        if not orgs:
            orgs = []

        # configテーブルから契約情報取得
        # v3.7.285: staff_count / license_status を要求していたが、いずれも config には
        #   存在しない列 (license_status は organizations 側、staff_count は未定義)。
        #   PostgREST が 400 を返すため configs が空になり、本部の店舗一覧で
        #   契約ID・プラン・担当者・メールがすべて空欄になっていた。
        configs = await supabase_query(
            "config",
            "select=organization_id,contract_id,stripe_plan,customer_email,contact_name"
        )
        config_map = {}
        if configs:
            for c in configs:
                config_map[c.get("organization_id")] = c

        # v3.7.218: スタッフ人数は staff テーブルから実数を集計する。
        #   config.staff_count 列は更新されず NULL のことが多く、本部一覧で 0 表示になっていた。
        staff_counts = await _fetch_staff_counts()

        # 結合
        shops = []
        for o in orgs:
            cfg = config_map.get(o["id"], {})
            # 実スタッフ数を優先。取得できなければ config.staff_count → 0
            real_count = staff_counts.get(o["id"]) or 0
            shops.append({
                "organization_id": o["id"],
                "name": o.get("name", "未設定"),
                "contract_id": cfg.get("contract_id", ""),
                # NULL 対策: cfg.get(...,default) は値が None だと None を返すため or でフォールバック
                "plan": cfg.get("stripe_plan") or "free",
                "staff_count": real_count,
                "contact_name": cfg.get("contact_name", ""),
                "customer_email": cfg.get("customer_email", ""),
                "license_status": o.get("license_status") or "active",
                "created_at": o.get("created_at", ""),
            })

        return shops
    except Exception as e:
        logger.info("[HQ] Shop list error: {}".format(e))
        return JSONResponse(status_code=500, content={"error": "店舗一覧の取得に失敗しました"})


# =============================================================
# シフト生成 API
# =============================================================

@app.post("/check")
@limiter.limit("20/minute")
def check_feasibility(request: Request, req: ShiftRequest):
    try:
        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests,
            existing_shifts=req.existing_shifts)
        result = scheduler.pre_check()
        return {"status": "success", "check": result}
    except Exception as e:
        logger.info("Check Error: {}".format(e))
        err_msg = "チェック中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return {"status": "error", "message": err_msg}


@app.post("/generate")
@limiter.limit("10/minute")
async def generate_shifts(request: Request, req: ShiftRequest,
                          x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    logger.info("Received request: {} staff, {} dates, mode={}".format(
        len(req.staff_list), len(req.dates), req.mode))

    try:
        # === セッション検証 (優先): 信頼できる org_id をサーバ側で確定 ===
        org_id = None
        session_info = await verify_session_org_id(x_session_id)
        if session_info and session_info.get("organization_id"):
            org_id = session_info["organization_id"]

        # === Fallback: セッション無効でも contract_id ベースで認証 ===
        # フロントの payload.contract_id から org_id を解決。
        # 既存 update_config_safe / *_by_contract RPC と同じ認証モデル
        # (15桁ランダム contract_id を実質シークレットとして扱う)。
        if not org_id:
            payload_contract_id = req.contract_id or req.config.get("contract_id")
            if payload_contract_id and SUPABASE_SERVICE_KEY and SUPABASE_URL:
                try:
                    client = _get_http_client()
                    resp = await client.get(
                        "{}/rest/v1/config".format(SUPABASE_URL),
                        params={"contract_id": "eq.{}".format(payload_contract_id),
                                "select": "organization_id", "limit": "1"},
                        headers={"apikey": SUPABASE_SERVICE_KEY,
                                 "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY)},
                        timeout=5)
                    if resp.status_code == 200:
                        data = resp.json()
                        if data and isinstance(data, list) and len(data) > 0:
                            org_id = data[0].get("organization_id")
                            logger.info("Auth fallback: org_id resolved via contract_id")
                except Exception as e:
                    logger.info("contract_id fallback failed: {}".format(e))

        if not org_id:
            return JSONResponse(status_code=401, content={
                "status": "error",
                "message": "セッションが無効または期限切れです。再ログインしてください。"
            })

        front_org_id = req.config.get("organization_id")
        if front_org_id and str(front_org_id) != str(org_id):
            return JSONResponse(status_code=403, content={
                "status": "error",
                "message": "セッションとリクエストの組織が一致しません。"
            })

        # 検証済み org_id で plan を取得 (DB 値を信頼)
        plan = "standard"
        if SUPABASE_SERVICE_KEY:
            try:
                client = _get_http_client()
                resp = await client.get(
                    "{}/rest/v1/config_safe".format(SUPABASE_URL),
                    params={"organization_id": "eq.{}".format(org_id), "select": "stripe_plan", "limit": "1"},
                    headers={"apikey": SUPABASE_SERVICE_KEY, "Authorization": "Bearer {}".format(SUPABASE_SERVICE_KEY)},
                    timeout=5)
                if resp.status_code == 200:
                    data = resp.json()
                    if data and isinstance(data, list) and len(data) > 0:
                        plan = data[0].get("stripe_plan") or "standard"
            except Exception as e:
                logger.info("Plan verification error: {}".format(e))

        limit = 10
        if plan == "pro": limit = 50
        if plan == "premium": limit = 9999
        if len(req.staff_list) > limit:
            return {"status": "error", "message": "スタッフ数がプラン上限({}名)を超過しています。".format(limit)}

        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests,
            existing_shifts=req.existing_shifts)


        force = (req.mode == "force")
        logger.info("[Generate] mode={} existing_shifts={}".format(req.mode, len(req.existing_shifts)))
        # 重い MILP 計算は別スレッドへ逃してイベントループのブロックを防ぐ
        result = await asyncio.to_thread(scheduler.solve, force=force)

        if not result:
            return {"status": "success", "mode": "math_failed", "shifts": []}

        # 生成結果のスタッフカバレッジをログ出力
        result_staff_ids = set(s["staff_id"] for s in result)
        logger.info("[Generate] Result: {} shifts covering {}/{} staff".format(
            len(result), len(result_staff_ids), len(req.staff_list)))

        # Gemini監査 (環境変数のAPIキーを使用)
        gemini_key, gemini_model = get_gemini_key()
        if gemini_key:
            logger.info("Running Gemini audit (server-side)...")
            audited = run_gemini_audit(gemini_key, gemini_model, req, result)
            if audited:
                # 監査結果の品質チェック: シフト数やスタッフカバレッジが減少していないか
                original_staff_ids = set(s["staff_id"] for s in result)
                audited_staff_ids = set(s["staff_id"] for s in audited)
                original_count = len(result)
                audited_count = len(audited)
                missing_staff = original_staff_ids - audited_staff_ids

                # v3.7.72: シフトパターン構造の破壊チェック
                # Gemini が独自に時間を統合・延長して登録済みパターン外の時間帯を
                # 作り出していたら audit 結果を破棄して MILP 原案を採用
                allowed_pattern_times = set()
                for sp in req.config.get("custom_shifts", []):
                    st = (sp.get("start") or "").strip()[:5]
                    en = (sp.get("end") or "").strip()[:5]
                    if st and en:
                        allowed_pattern_times.add((st, en))
                pattern_violations = 0
                if allowed_pattern_times:
                    for c in audited:
                        st = (c.get("start_time") or "")[:5]
                        en = (c.get("end_time") or "")[:5]
                        if (st, en) not in allowed_pattern_times:
                            pattern_violations += 1

                # シフト数が50%以下に減少した場合は破棄
                if audited_count < original_count * 0.5:
                    logger.info("[Gemini Audit] REJECTED: shift count dropped too much ({} -> {})".format(
                        original_count, audited_count))
                # シフト数が30%以上増加した場合も破棄（過剰配置防止）
                elif audited_count > original_count * 1.3:
                    logger.info("[Gemini Audit] REJECTED: shift count increased too much ({} -> {})".format(
                        original_count, audited_count))
                # スタッフが1人でも消えた場合は破棄（全スタッフのシフトを保護）
                elif len(missing_staff) > 0:
                    logger.info("[Gemini Audit] REJECTED: {} staff lost shifts: {}".format(
                        len(missing_staff), missing_staff))
                # v3.7.72: パターン外時間帯違反 10% 超えで破棄
                elif allowed_pattern_times and pattern_violations > max(2, int(audited_count * 0.1)):
                    logger.info(
                        "[Gemini Audit] REJECTED: Gemini fabricated %d/%d shifts outside registered patterns (allowed=%s)",
                        pattern_violations, audited_count, sorted(allowed_pattern_times))
                else:
                    # Gemini audit が reason フィールドを返さないことが多いため、
                    # 元の result から (staff_id, date) キーで reason を引き戻す。
                    # これでフロントのプレビューに「配置理由」が確実に表示される。
                    original_reasons = {(s.get("staff_id"), s.get("date")): s.get("reason") for s in result}
                    for c in audited:
                        if not c.get("reason"):
                            c["reason"] = original_reasons.get((c.get("staff_id"), c.get("date")), "Geminiが微調整")
                    result = audited
                    return {
                        "status": "success",
                        "mode": "math_plus_gemini_audit" if not force else "math_force_plus_gemini",
                        "shifts": result,
                        "report": getattr(scheduler, "_last_report", None)
                    }

        return {
            "status": "success",
            "mode": "math_force" if force else "math",
            "shifts": result,
            "report": getattr(scheduler, "_last_report", None)
        }

    except Exception as e:
        logger.error("Error in /generate: {}".format(e))
        import traceback
        traceback.print_exc()
        # v3.7.10: 本番モードに復帰 — 詳細はサーバログに、ユーザーには汎用メッセージ。
        # デバッグ時は IS_PRODUCTION=0 を設定するか、Railway ログを参照。
        err_msg = "シフト生成中にエラーが発生しました" if IS_PRODUCTION else "{}: {}".format(type(e).__name__, str(e))
        return {"status": "error", "message": err_msg}


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

        time_staff_req = config.get("time_staff_req", [])
        
        prompt = """あなたはプロの店舗マネージャーであり、日本の労働基準法に精通しています。
以下のシフトデータを分析し、改善点やリスクを指摘してください。

【店舗ルール】
- 営業時間: {} - {}
- 最低人数（常に必要なベース人数）: 平日{}名, 土日{}名, 祝日{}名
- 時間帯別の必要人数要件: {}
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
2. 人員不足のリスクと時間帯（「12:00-15:00の中番で1名不足」のように、早番・中番・遅番など具体的にどの時間帯で人が足りないかを特定し、誰の出勤を追加するか・誰のシフトを延長するか等の「具体的な改善策」を必ず提示すること）
3. 特定スタッフへの負荷偏り（連勤、長時間労働）
4. 管理者不在の時間帯
5. 新人が一人で入っている時間帯

回答は以下のJSON配列形式のみで出力してください。Markdownは不要です。
[
  {{"type": "danger", "title": "...", "desc": "...", "action": "..."}},
  {{"type": "warning", "title": "...", "desc": "...", "action": "..."}},
  {{"type": "info", "title": "...", "desc": "...", "action": "..."}}
]

typeは重要度順: danger(労基法違反) > warning(人員不足など重大リスク) > info(改善提案)""".format(
            config.get("opening_time", "09:00"),
            config.get("closing_time", "22:00"),
            staff_req.get("min_weekday", 2),
            staff_req.get("min_weekend", 3),
            staff_req.get("min_holiday", 3),
            json.dumps(time_staff_req, ensure_ascii=False) if time_staff_req else "特になし",
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

        # v3.7.139: API key を URL クエリ → x-goog-api-key ヘッダーに移動
        # (URL は Referer / ブラウザ履歴 / プロキシログに残るため)
        url = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent".format(gemini_model)
        resp = httpx.post(url, json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json"
            }
        }, headers={"x-goog-api-key": gemini_key}, timeout=60)

        if resp.status_code != 200:
            return {"status": "error",
                    "message": "AI応答エラー ({})".format(resp.status_code),
                    "suggestions": []}

        try:
            data = resp.json()
            text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
        except (ValueError, AttributeError, IndexError, TypeError, KeyError) as parse_err:
            logger.error("[Gemini Diagnose] Response structure unexpected: %s", parse_err)
            return {"status": "error", "message": "AI応答の形式が不正です", "suggestions": []}
        if not text:
            return {"status": "error", "message": "AIからの応答がありません", "suggestions": []}

        try:
            suggestions = json.loads(text)
        except json.JSONDecodeError as je:
            logger.error("[Gemini Diagnose] JSON parse failed: %s. Raw: %s", je, text[:300])
            return {"status": "error", "message": "AIの返答が解釈できませんでした", "suggestions": []}
        return {"status": "success", "suggestions": suggestions}

    except Exception as e:
        logger.exception("AI diagnose failed")
        err_msg = "AI診断中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return {"status": "error", "message": err_msg, "suggestions": []}


# =============================================================
# Gemini監査
# =============================================================

def run_gemini_audit(api_key: str, model: str, req: ShiftRequest, shifts: list) -> list:
    """Gemini APIでシフトを監査・修正 (サーバーサイド)"""
    try:
        # v3.7.139: API key を URL → x-goog-api-key ヘッダーに移動
        url = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent".format(model)
        _gemini_headers = {"x-goog-api-key": api_key}

        config = req.config
        staff_req = config.get("staff_req", {})
        break_rules = config.get("break_rules", [
            {"min_hours": 6, "break_minutes": 45},
            {"min_hours": 8, "break_minutes": 60}
        ])
        closed_days_names = []
        day_names = ["日", "月", "火", "水", "木", "金", "土"]
        for cd in config.get("closed_days", []):
            # v3.7.137: int 変換失敗を握りつぶさず skip
            try:
                cd_int = int(cd)
            except (ValueError, TypeError):
                continue
            if 0 <= cd_int < 7:
                closed_days_names.append(day_names[cd_int])

        # v3.7.139: スタッフ情報を匿名化して Gemini に送信
        # name / 給与情報 / 評価ランクを除外し、ID と勤務制約のみ
        staff_info = []
        for s in req.staff_list:
            staff_info.append({
                "id": s["id"],  # 内部 UUID (個人特定性は低い)
                "role": s.get("role", "staff"),
                "max_days": s.get("max_days_week", 5),
                "max_hours": s.get("max_hours_day", 8),
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

        # v3.7.72: シフトパターン情報を Gemini に渡す
        # 旧プロンプトには custom_shifts (早番/遅番の時間と曜日別人数) が含まれず、
        # Gemini が「ベース必要人数しか必要ない」と誤判断してパターン構造を
        # 統合・破壊するバグの原因となっていた
        custom_shifts_for_prompt = []
        for sp in config.get("custom_shifts", []):
            custom_shifts_for_prompt.append({
                "name": sp.get("name", ""),
                "start": sp.get("start", ""),
                "end": sp.get("end", ""),
                "count_weekday": sp.get("count_weekday", sp.get("count", 1)),
                "count_weekend": sp.get("count_weekend", sp.get("count", 1)),
                "count_holiday": sp.get("count_holiday", sp.get("count", 1)),
            })

        prompt = """あなたは日本の労働基準法に精通した熟練シフト管理者AIです。
Pythonシステム(MILPソルバー)が生成した「一次シフト案」を監査し、以下の全ルールに違反がないか検証してください。
違反があれば**最小限の修正**を加え、なければそのまま出力してください。

=== 最重要: 最小変更原則 (これを守らないと納品事故になる) ===
- 一次シフト案は MILP で最適化済みです。人員配置バランスは既に計算されています。
- 労基法違反の修正以外は、シフトの追加・削除・**開始/終了時刻の変更を絶対にしない**でください。
- 各シフトの開始/終了時刻は下記「シフトパターン」のいずれかと一致しています。
  Gemini が独自に開始/終了時刻を統合・延長・短縮することを禁止します。
  時刻を変える必要がある場合 (例: 法定休憩追加) は、シフトパターン定義の中から
  別のパターン時刻を選んでください。完全に新規の時刻を作らないでください。

=== シフトパターン定義 (UI で店舗管理者が指定したもの。これを尊重) ===
{}

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
**重要**: 違反がない場合は一次シフト案をそのまま出力してください。不要な変更はしないでください。
**重要**: 各シフトの start_time / end_time は、上記シフトパターン定義の start / end のいずれかと一致させてください。
[
  {{"staff_id": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "break_minutes": 60, "is_irregular": false}},
  ...
]
※ 欠員補充のために社員（monthly）のシフトを延長した、または休みから呼び出した場合は、該当シフトの `"is_irregular": true` としてください。通常シフトは `false` です。""".format(
            json.dumps(custom_shifts_for_prompt, ensure_ascii=False)
                if custom_shifts_for_prompt else "（シフトパターン未定義 / 営業時間全体を一律使用）",
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
        }, headers=_gemini_headers, timeout=90)

        if resp.status_code != 200:
            logger.info("Gemini API error: {}".format(resp.status_code))
            return None

        try:
            data = resp.json()
            text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
        except (ValueError, AttributeError, IndexError, TypeError, KeyError) as parse_err:
            logger.warning("[Gemini Audit] Response structure unexpected, skipping audit: %s", parse_err)
            return None
        if not text:
            return None

        try:
            fixed = json.loads(text)
        except json.JSONDecodeError as je:
            logger.warning("[Gemini Audit] JSON parse failed, skipping audit: %s. Raw: %s", je, text[:200])
            return None

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

        logger.info("[Gemini Audit] {} -> {} shifts".format(len(shifts), len(cleaned)))
        return cleaned

    except Exception as e:
        logger.info("Gemini audit error: {}".format(e))
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
        logger.info("[Email] SMTP not configured. Skipping email to {}".format(to_email))
        logger.info("[Email] Contract ID: {} (SMTP not configured, credentials not logged)".format(contract_id))
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
        # HTML エスケープ: Stripe metadata 経由で <script> 等が混入しても無害化
        org_name=_html.escape(str(org_name)),
        plan_name=_html.escape(str(plan_name)),
        login_url=_html.escape(str(login_url), quote=True),
        contract_id=_html.escape(str(contract_id)),
        password=_html.escape(str(password)),
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = smtp_from
    msg["To"] = to_email
    msg.attach(MIMEText(html_body, "html"))

    def _send_sync():
        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.sendmail(smtp_from, to_email, msg.as_string())

    # SMTP リトライ (3回、指数バックオフ)
    max_retries = 3
    for attempt in range(max_retries):
        try:
            await asyncio.to_thread(_send_sync)
            logger.info("Welcome email sent to %s (attempt %d)", to_email, attempt + 1)
            return
        except Exception as e:
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            # 最終失敗: 顧客にメールが届かない致命的事象。Railway logs に ERROR で残す
            logger.error("Welcome email PERMANENTLY FAILED to %s after %d attempts: %s. Manual resend required.", to_email, max_retries, e)


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

        # オープンリダイレクト防止: 許可ドメインのみ受け入れ
        if not _validate_redirect_url(req.success_url) or not _validate_redirect_url(req.cancel_url):
            return JSONResponse(status_code=400,
                                content={"error": "不正なリダイレクトURLです"})

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

        # v3.7.140: Idempotency-Key で重複課金防止 (customer + plan + 日時)
        import time as _t
        _idem_key_new = f"checkout_new:{customer.id}:{req.plan}:{int(_t.time())}"
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
            idempotency_key=_idem_key_new,
        )

        return {"url": session.url, "session_id": session.id}

    except stripe.error.StripeError as e:
        logger.info("Stripe Error: {}".format(e))
        err_msg = "決済処理中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=400, content={"error": err_msg})
    except Exception as e:
        logger.info("New Subscription Error: {}".format(e))
        err_msg = "サーバーエラーが発生しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500, content={"error": err_msg})


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

        # オープンリダイレクト防止
        if not _validate_redirect_url(success_url) or not _validate_redirect_url(cancel_url):
            return JSONResponse(status_code=400, content={"error": "不正なリダイレクトURLです"})

        # v3.7.140: Idempotency-Key で重複課金防止 (contract + 日時)
        import time as _t2
        _idem_key_resume = f"checkout_resume:{req.contract_id}:{int(_t2.time())}"
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
                # v3.7.169: webhook で stripe_plan を更新するために plan を必ず metadata に含める
                "plan": req.plan,
            },
            subscription_data={
                "metadata": {
                    "contract_id": req.contract_id,
                    "plan": req.plan,
                }
            },
            allow_promotion_codes=True,
            idempotency_key=_idem_key_resume,
        )

        return {"url": session.url, "session_id": session.id}

    except stripe.error.StripeError as e:
        logger.info("Stripe Error: {}".format(e))
        err_msg = "決済セッションの作成に失敗しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=400,
                            content={"error": err_msg})
    except Exception as e:
        logger.info("Checkout Error: {}".format(e))
        err_msg = "サーバーエラーが発生しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500,
                            content={"error": err_msg})


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

        # オープンリダイレクト防止: 戻りURLの検証
        if req.return_url and not _validate_redirect_url(req.return_url):
            return JSONResponse(status_code=400, content={"error": "不正なリダイレクトURLです"})

        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
        )

        return {"url": session.url}

    except Exception as e:
        logger.info("Portal Error: {}".format(e))
        err_msg = "ポータルの作成に失敗しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500,
                            content={"error": err_msg})


# === サブスクリプション情報 (v3.7.256: セルフ解約の発効日アナウンス用) ===
# 契約日から起算した「現在の利用期間の末日」= 解約が発効する日を返す。
# 認証は既存 *_by_contract RPC と同じ contract_id ベアラーモデル。
@app.get("/stripe/subscription-info")
@limiter.limit("20/minute")
async def stripe_subscription_info(request: Request, contract_id: str = ""):
    import re as _re
    cid = (contract_id or "").strip()
    if not _re.match(r"^[A-Za-z0-9_\-]{1,32}$", cid):
        return JSONResponse(status_code=400, content={"error": "invalid contract_id"})

    from urllib.parse import quote as _q
    rows = await supabase_query(
        "config",
        "contract_id=eq.{}&select=stripe_subscription_id,stripe_plan,cancel_requested_at,cancel_effective_date".format(_q(cid, safe="")))
    if rows is None:
        # v3.7.261: DB到達不能を契約ID不存在(404)と混同しない
        return JSONResponse(status_code=503, content={"error": "サーバに接続できません。時間をおいて再度お試しください"})
    if not rows:
        return JSONResponse(status_code=404, content={"error": "契約IDが見つかりません"})
    sub_id = rows[0].get("stripe_subscription_id")
    if not sub_id:
        # 手動発行テナント: 解約申請の状態を返す (v3.7.257)
        return {
            "has_subscription": False,
            "manual_cancel_requested": bool(rows[0].get("cancel_requested_at")),
            "manual_cancel_effective_date": rows[0].get("cancel_effective_date"),
        }

    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return JSONResponse(status_code=500, content={"error": "Stripe is not configured"})
    stripe.api_key = sk
    try:
        sub = stripe.Subscription.retrieve(sub_id)
        # current_period_end: API バージョンにより subscription 直下 or items 配下
        period_end = sub.get("current_period_end")
        if not period_end:
            items = (sub.get("items") or {}).get("data") or []
            if items:
                period_end = items[0].get("current_period_end")
        return {
            "has_subscription": True,
            "status": sub.get("status"),
            "start_date": sub.get("start_date"),
            "current_period_end": period_end,
            "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
            "canceled_at": sub.get("canceled_at"),
        }
    except Exception as e:
        logger.info("subscription-info error: {}".format(e))
        err = "サブスクリプション情報の取得に失敗しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500, content={"error": err})


# === 手動テナントの解約申請 (v3.7.257) ===
# 発効日ルール: 申請した月の末日 (当月末・JST)。Stripe契約テナントは対象外(ポータルで解約)。
class CancelRequestBody(BaseModel):
    contract_id: str = Field(..., max_length=32)


@app.post("/license/cancel-request")
@limiter.limit("5/minute")
async def license_cancel_request(request: Request, req: CancelRequestBody):
    import re as _re
    import calendar as _cal
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz
    cid = (req.contract_id or "").strip()
    if not _re.match(r"^[A-Za-z0-9_\-]{1,32}$", cid):
        return JSONResponse(status_code=400, content={"error": "invalid contract_id"})

    from urllib.parse import quote as _q
    rows = await supabase_query(
        "config",
        "contract_id=eq.{}&select=id,organization_id,stripe_subscription_id,cancel_requested_at".format(_q(cid, safe="")))
    if rows is None:
        return JSONResponse(status_code=503, content={"error": "サーバに接続できません。時間をおいて再度お試しください"})
    if not rows:
        return JSONResponse(status_code=404, content={"error": "契約IDが見つかりません"})
    row = rows[0]
    if row.get("stripe_subscription_id"):
        return JSONResponse(status_code=400, content={
            "error": "Stripe契約のテナントは請求管理ポータルから解約してください"})
    if row.get("cancel_requested_at"):
        return {"success": True, "already": True, "message": "既に解約申請済みです"}

    # 発効日 = 当月末 (JST)
    jst_today = _dt.now(_tz(_td(hours=9))).date()
    last_day = _cal.monthrange(jst_today.year, jst_today.month)[1]
    effective = jst_today.replace(day=last_day)

    # 店舗名を取得
    shop_name = ""
    orgs = await supabase_query(
        "organizations", "id=eq.{}&select=name".format(_q(str(row.get("organization_id") or ""), safe="")))
    if orgs:
        shop_name = orgs[0].get("name") or ""

    # config に申請を記録 (v3.7.261: 一次記録の成否を確認。失敗時は通知せず中断)
    patched = await supabase_query(
        "config", "contract_id=eq.{}".format(_q(cid, safe="")), method="PATCH",
        body={"cancel_requested_at": _dt.now(_tz(_td(hours=9))).isoformat(),
              "cancel_effective_date": effective.isoformat()})
    if patched is None:
        return JSONResponse(status_code=503, content={
            "error": "解約申請の保存に失敗しました。時間をおいて再度お試しください"})

    # 運営管理のお問い合わせ一覧にも記録
    try:
        await supabase_query("inquiries", method="POST", body={
            "company_name": "【解約申請】" + (shop_name or cid),
            "phone": "-",
            "contact_name": "セルフ解約申請",
            "message": "契約ID {} から解約申請がありました。発効日(当月末): {}。発効日にテナントの停止処理を行ってください。".format(cid, effective.isoformat()),
            "status": "new",
        })
    except Exception as e:
        logger.warning("cancel-request inquiry save failed: %s", e)

    # 運営へメール通知 (SMTP設定済みの場合)
    try:
        import smtplib
        from email.mime.text import MIMEText
        to_email = os.environ.get("INQUIRY_EMAIL_TO") or "rakushift.ai@gmail.com"
        smtp_user = os.environ.get("SMTP_USER", "")
        smtp_pass = os.environ.get("SMTP_PASS", "")
        if smtp_user and smtp_pass:
            body_text = ("ラクシフトAI 解約申請\n\n店舗名: {}\n契約ID: {}\n申請日: {}\n解約発効日(当月末): {}\n\n"
                         "発効日に運営管理からテナントの停止処理を行ってください。").format(
                shop_name or "(未設定)", cid, jst_today.isoformat(), effective.isoformat())
            msg = MIMEText(body_text, "plain", "utf-8")
            msg["From"] = smtp_user
            msg["To"] = to_email
            msg["Subject"] = "【ラクシフト】解約申請 - {}".format((shop_name or cid).replace("\r", "").replace("\n", ""))
            def _send_sync():
                with smtplib.SMTP(os.environ.get("SMTP_HOST", "smtp.gmail.com"),
                                  int(os.environ.get("SMTP_PORT", "587")), timeout=20) as server:
                    server.starttls()
                    server.login(smtp_user, smtp_pass)
                    server.send_message(msg)
            await asyncio.to_thread(_send_sync)
            logger.info("cancel-request email sent for %s", cid)
    except Exception as e:
        logger.warning("cancel-request email failed: %s", e)

    return {"success": True, "effective_date": effective.isoformat()}


# === 運営管理: Stripe 決済一覧 (v3.7.255) ===
# 決済済み(paid) / 未決済・失敗(open, uncollectible) を分類して返す。
# 運営管理 (admin.html) の「決済管理」タブが使用。platform_admin セッション必須。
# === 運営管理: 顧客情報の統合ビュー (v3.7.262) ===
# Stripe契約 / 手動発行テナント / お問い合わせ(見込み客) を1つにまとめ、
# 解約状態も含めて返す。運営コンソールの「顧客情報」タブが使用。
@app.get("/admin/customers")
@limiter.limit("10/minute")
async def admin_customers(request: Request,
                          x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})

    # 1. テナント (config + organizations)
    configs = await supabase_query(
        "config",
        "select=organization_id,contract_id,subscription_status,stripe_customer_id,stripe_subscription_id,"
        "stripe_plan,customer_email,contact_email,contact_name,phone,contact_phone,address,referrer_code,company_name,"
        "cancel_requested_at,cancel_effective_date,payment_failed_at,trial_ends_at") or []
    orgs = await supabase_query(
        "organizations",
        "select=id,name,license_status,license_suspended_at,data_deletion_scheduled_at,created_at") or []
    org_map = {o.get("id"): o for o in orgs}

    # スタッフ数集計
    # v3.7.285: staff を REST で直接読むと PostgREST の max-rows=1000 で切り捨てられ、
    # 全テナント合計が1000名を超えた時点で後半テナントのスタッフ数が 0 になっていた
    # (limit=100000 を付けても max-rows の方が優先されるため効かない)。
    # DB側で集計した JSONB を受け取る形に変更。
    staff_counts = await _fetch_staff_counts()

    # Stripe 最新決済状況 + 申込会社名を customer_id ごとにマップ。
    # v3.7.266: Stripe 呼び出しが遅いと顧客タブ全体が待たされ「たまに出てこない」原因に
    #   なるため、別スレッド + 8秒タイムアウトで実行。超過時は決済状況/申込会社名だけ
    #   欠落させ、テナント/見込み客データは即返す。
    pay_status = {}
    cust_company = {}  # customer_id -> 申込時の会社名 (org_name)
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if sk:
        def _fetch_stripe():
            stripe.api_key = sk
            ps, cc = {}, {}
            for inv in stripe.Invoice.list(limit=100).get("data", []):
                cu = inv.get("customer")
                if cu and cu not in ps:
                    ps[cu] = inv.get("status")
            for c2 in stripe.Customer.list(limit=100).get("data", []):
                nm = c2.get("name") or (c2.get("metadata") or {}).get("org_name") or ""
                if nm:
                    cc[c2.get("id")] = nm
            return ps, cc
        try:
            pay_status, cust_company = await asyncio.wait_for(asyncio.to_thread(_fetch_stripe), timeout=8.0)
        except asyncio.TimeoutError:
            logger.info("customers: stripe enrich timed out (8s), returning without it")
        except Exception as e:
            logger.info("customers: stripe enrich skipped: {}".format(e))

    tenants = []
    for c in configs:
        oid = c.get("organization_id")
        org = org_map.get(oid, {})
        src = "stripe" if c.get("stripe_subscription_id") else "manual"
        cid = c.get("stripe_customer_id")
        # v3.7.275: 請求カテゴリー (Stripe / OEM / 請求書払い)
        if c.get("stripe_subscription_id"):
            billing_category = "stripe"
        elif (c.get("stripe_plan") or "") in ("oem", "enterprise"):
            billing_category = "oem"
        else:
            billing_category = "invoice"
        tenants.append({
            "source": src,
            "billing_category": billing_category,
            "organization_id": oid,
            "contract_id": c.get("contract_id"),
            "shop_name": org.get("name") or "",
            "applied_company": c.get("company_name") or (cust_company.get(cid) if cid else "") or "",
            "contact_name": c.get("contact_name") or "",
            "email": c.get("customer_email") or c.get("contact_email") or "",
            "phone": c.get("phone") or "",
            "contact_phone": c.get("contact_phone") or "",
            "address": c.get("address") or "",
            "referrer_code": c.get("referrer_code") or "",
            "plan": c.get("stripe_plan") or "",
            "subscription_status": c.get("subscription_status") or "",
            "license_status": org.get("license_status") or "active",
            "payment_status": pay_status.get(cid) if cid else None,
            "cancel_requested_at": c.get("cancel_requested_at"),
            "cancel_effective_date": c.get("cancel_effective_date"),
            "payment_failed_at": c.get("payment_failed_at"),
            "staff_count": staff_counts.get(oid, 0),
            "data_deletion_scheduled_at": org.get("data_deletion_scheduled_at"),
            "created_at": org.get("created_at"),
        })

    # 2. お問い合わせ (見込み客)
    inquiries = await supabase_query(
        "inquiries",
        "select=id,company_name,business_name,email,company_address,phone,contact_name,contact_phone,plan_summary,"
        "light_plan_count,standard_plan_count,premium_plan_count,preferred_days,preferred_time,referrer_code,"
        "message,status,created_at,handled_at,internal_notes&order=created_at.desc&limit=500") or []
    leads = []
    for q in inquiries:
        _lc = q.get("light_plan_count") or 0
        _sc = q.get("standard_plan_count") or 0
        _pc = q.get("premium_plan_count") or 0
        try:
            total_stores = int(_lc) + int(_sc) + int(_pc)
        except (ValueError, TypeError):
            total_stores = 0
        leads.append({
            "source": "inquiry",
            "id": q.get("id"),
            "company_name": q.get("company_name") or "",
            "business_name": q.get("business_name") or "",
            "email": q.get("email") or "",
            "contact_name": q.get("contact_name") or "",
            "phone": q.get("phone") or "",
            "contact_phone": q.get("contact_phone") or "",
            "address": q.get("company_address") or "",
            "plan_summary": q.get("plan_summary") or "",
            "standard_count": _sc, "pro_count": _lc, "premium_count": _pc,
            "total_stores": total_stores,
            "preferred_days": q.get("preferred_days") or "",
            "preferred_time": q.get("preferred_time") or "",
            "referrer_code": q.get("referrer_code") or "",
            "message": q.get("message") or "",
            "status": q.get("status") or "new",
            "created_at": q.get("created_at"),
            "handled_at": q.get("handled_at"),
        })

    # 解約中/予約のテナント抽出 (解約管理セクション用)
    cancelling = [t for t in tenants
                  if t.get("cancel_requested_at") or t.get("subscription_status") == "canceled"
                  or t.get("license_status") == "suspended"]

    return {
        "tenants": tenants,
        "leads": leads,
        "cancelling": cancelling,
        "counts": {
            "stripe": sum(1 for t in tenants if t["billing_category"] == "stripe"),
            "oem": sum(1 for t in tenants if t["billing_category"] == "oem"),
            "invoice": sum(1 for t in tenants if t["billing_category"] == "invoice"),
            "manual": sum(1 for t in tenants if t["source"] == "manual"),
            "leads": len(leads),
            "cancelling": len(cancelling),
        },
    }


def _rpc_error(result: Any) -> Optional[str]:
    """supabase_rpc の戻りが失敗を表しているなら理由を返す (成功なら None)。

    supabase_rpc は例外ではなく {"status": "error", ...} を返すため、
    そのまま `isinstance(x, list) else []` で潰すと「取得できなかった」のか
    「本当に0件」なのか運営が区別できない。エクスポート側で明示する。
    """
    if isinstance(result, dict) and result.get("status") == "error":
        msg = str(result.get("message", ""))[:120]
        return msg or "unknown error"
    return None


async def _fetch_staff_counts() -> Dict[str, int]:
    """テナントごとのスタッフ数。

    v3.7.285: staff を REST で直接読むと PostgREST の max-rows=1000 で切り捨てられ、
    全テナント合計が1000名を超えると後半テナントが 0 名になる。DB側集計 RPC を使う。
    ただし migration 87 の適用前でも動くよう、RPC が無い場合は従来の集計に落とす
    (デプロイとマイグレーションの順序に依存させないため)。
    """
    try:
        counts = await supabase_rpc("list_staff_counts", {})
        if isinstance(counts, dict) and "status" not in counts:
            return {k: int(v) for k, v in counts.items()}
    except Exception as e:
        logger.info("list_staff_counts unavailable: %s", type(e).__name__)

    fallback: Dict[str, int] = {}
    try:
        rows = await supabase_query("staff", "select=organization_id&limit=100000")
        for s in (rows or []):
            oid = s.get("organization_id")
            if oid:
                fallback[oid] = fallback.get(oid, 0) + 1
    except Exception:
        pass
    return fallback


async def _collect_stripe_payments() -> Dict[str, Any]:
    """Stripe の直近請求書を「支払済み / 未払い」に仕分けして返す。

    v3.7.285: 運営コンソールと GAS 売上シートの両方から使うため関数に切り出し。
    Stripe 未設定時は例外ではなく空の結果を返す (請求書払いだけの運用でも
    売上シート同期が止まらないようにするため)。
    """
    _load_platform_settings()
    sk = _get_setting("stripe_secret_key")
    if not sk:
        return {"paid": [], "unpaid": [], "counts": {"paid": 0, "unpaid": 0},
                "configured": False}
    stripe.api_key = sk

    # customer_id → テナント情報の対応表
    tenant_map = {}
    rows = await supabase_query(
        "config",
        "select=contract_id,organization_id,stripe_customer_id,stripe_plan,referrer_code"
        "&stripe_customer_id=not.is.null")
    orgs = await supabase_query("organizations", "select=id,name")
    org_names = {o.get("id"): o.get("name") for o in (orgs or [])}
    for c in (rows or []):
        cid = c.get("stripe_customer_id")
        if cid:
            tenant_map[cid] = {
                "contract_id": c.get("contract_id"),
                "shop_name": org_names.get(c.get("organization_id"), ""),
                "plan": c.get("stripe_plan"),
                "referrer_code": (c.get("referrer_code") or "").strip().upper(),
            }

    # 直近の請求書 (最大100件 = 約1年分/100テナント月)
    invoices = await asyncio.to_thread(lambda: stripe.Invoice.list(limit=100))
    paid, unpaid = [], []
    for inv in invoices.get("data", []):
        status = inv.get("status")
        if status in ("draft", "void"):
            continue  # 下書き・無効化済みは対象外
        cust = inv.get("customer")
        tenant = tenant_map.get(cust, {})
        item = {
            "invoice_id": inv.get("id"),
            "date": inv.get("created"),
            "amount": inv.get("amount_due") if status != "paid" else inv.get("amount_paid"),
            "currency": inv.get("currency"),
            "status": status,
            "attempt_count": inv.get("attempt_count", 0),
            "next_attempt": inv.get("next_payment_attempt"),
            "customer_email": inv.get("customer_email") or "",
            "invoice_url": inv.get("hosted_invoice_url") or "",
            "contract_id": tenant.get("contract_id") or "",
            "shop_name": tenant.get("shop_name") or "",
            "plan": tenant.get("plan") or "",
            "referrer_code": tenant.get("referrer_code") or "",
        }
        if status == "paid":
            paid.append(item)
        else:
            # open (支払い待ち/失敗リトライ中) / uncollectible (回収不能)
            unpaid.append(item)

    return {"paid": paid, "unpaid": unpaid,
            "counts": {"paid": len(paid), "unpaid": len(unpaid)},
            "configured": True}


@app.get("/admin/stripe/payments")
@limiter.limit("10/minute")
async def admin_stripe_payments(request: Request,
                                x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})

    try:
        result = await _collect_stripe_payments()
        if not result.get("configured"):
            return JSONResponse(status_code=500, content={"error": "Stripe is not configured"})
        return result
    except Exception as e:
        logger.info("admin stripe payments error: {}".format(e))
        err = "決済情報の取得に失敗しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500, content={"error": err})


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
    logger.info("[Stripe Webhook] Event: {}".format(event_type))

    try:
        if event_type == "checkout.session.completed":
            metadata = data.get("metadata", {})
            subscription_id = data.get("subscription")
            customer_id = data.get("customer")
            customer_email = (data.get("customer_details") or {}).get("email") or metadata.get("email", "")

            if metadata.get("type") == "new_subscription":
                # === 新規申し込み: テナント自動作成 + メール送信 ===
                org_name = metadata.get("org_name", "新規店舗")
                plan = metadata.get("plan", "pro")
                contact_name = metadata.get("contact_name", "")
                phone = metadata.get("phone", "")
                contact_phone = metadata.get("contact_phone", "")
                address = metadata.get("address", "")
                referrer_code = (metadata.get("referrer_code", "") or "").strip().upper()

                # 0. 重複チェック（既に同じsubscription_idで作成済みか）
                existing = await supabase_query(
                    "config",
                    "stripe_subscription_id=eq.{}&select=id".format(subscription_id)
                )
                if isinstance(existing, list) and len(existing) > 0:
                    logger.info("[Webhook] SKIPPED: Tenant already exists for subscription {}".format(subscription_id))
                    return JSONResponse(status_code=200, content={"status": "already_processed"})

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
                        "company_name": org_name,
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
                        logger.warning("No email for tenant %s", new_contract_id)
                    logger.info("[Webhook] NEW TENANT created: {} email={} plan={}".format(
                        new_contract_id, customer_email, plan))
                else:
                    logger.info("[Webhook] Tenant creation FAILED: {}".format(tenant_result))

            else:
                # === 既存テナントのプラン変更 ===
                # metadata.contract_id が無くても subscription_id / customer_id で逆引きする
                contract_id = metadata.get("contract_id")
                if not contract_id and subscription_id:
                    configs = await supabase_query(
                        "config",
                        "stripe_subscription_id=eq.{}&select=contract_id".format(subscription_id))
                    if configs and len(configs) > 0:
                        contract_id = configs[0].get("contract_id")
                if not contract_id and customer_id:
                    configs = await supabase_query(
                        "config",
                        "stripe_customer_id=eq.{}&select=contract_id".format(customer_id))
                    if configs and len(configs) > 0:
                        contract_id = configs[0].get("contract_id")

                if contract_id:
                    # v3.7.169: 既存テナントのプラン変更でも stripe_plan を更新する
                    # 優先順位: 1) metadata.plan  2) subscription.items[0].price.id 逆引き
                    new_plan = (metadata.get("plan") or "").strip().lower()
                    if not new_plan and subscription_id:
                        try:
                            sub = stripe.Subscription.retrieve(subscription_id)
                            items = (sub.get("items", {}) or {}).get("data", []) if isinstance(sub, dict) else []
                            if not items and hasattr(sub, "items"):
                                items = sub["items"]["data"]
                            if items:
                                price_id = items[0].get("price", {}).get("id", "") if isinstance(items[0], dict) else items[0]["price"]["id"]
                                _load_platform_settings()
                                for plan_key in ("standard", "pro", "premium"):
                                    if _get_setting("stripe_price_{}".format(plan_key)) == price_id:
                                        new_plan = plan_key
                                        break
                        except Exception as e:
                            logger.warning("[Webhook] subscription retrieve failed: %s", e)
                    update_body = {
                        "stripe_customer_id": customer_id,
                        "stripe_subscription_id": subscription_id,
                        "subscription_status": "active",
                        "payment_failed_at": None,
                    }
                    if new_plan in ("standard", "pro", "premium"):
                        update_body["stripe_plan"] = new_plan
                    await supabase_query(
                        "config",
                        "contract_id=eq.{}".format(contract_id),
                        method="PATCH",
                        body=update_body
                    )
                    logger.info("[Webhook] Subscription activated for: %s (plan=%s)", contract_id, new_plan or "unchanged")
                else:
                    logger.warning("[Webhook] checkout.session.completed: contract_id unresolved (sub=%s cust=%s)", subscription_id, customer_id)

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
                    # v3.7.261: 支払い回復時に payment_failed_at をクリア
                    # (残さないと次回失敗時に古い日付で 21日経過扱いになり即停止する)
                    update_data["payment_failed_at"] = None

                    # v3.7.272: 停止中のテナントが再びactiveになったら自動でライセンス復活。
                    # (支払い回復や解約取消でサブスクが復活してもライセンスが停止のままだと
                    #  ログインできず「テナント情報が変わる」状態が続くため)
                    try:
                        _cfgs = await supabase_query(
                            "config", "contract_id=eq.{}&select=organization_id".format(contract_id))
                        _oid = _cfgs[0].get("organization_id") if _cfgs else None
                        if _oid:
                            _orgs = await supabase_query(
                                "organizations", "id=eq.{}&select=license_status".format(_oid))
                            if _orgs and _orgs[0].get("license_status") == "suspended":
                                await supabase_rpc("activate_license", {
                                    "p_organization_id": _oid,
                                    "p_note": "Stripe subscription reactivated (auto)"
                                })
                                logger.info("[Webhook] Auto-reactivated license for: %s", contract_id)
                    except Exception as _e:
                        logger.warning("[Webhook] auto-reactivate failed: %s", _e)

                    items = data.get("items", {}).get("data", [])
                    if items:
                        price_id = items[0].get("price", {}).get("id", "")
                        # 価格IDからプランを逆引き
                        _load_platform_settings()
                        for plan_key in ("standard", "pro", "premium"):
                            setting_key = "stripe_price_{}".format(plan_key)
                            if _get_setting(setting_key) == price_id:
                                update_data["stripe_plan"] = plan_key
                                logger.info("[Webhook] Plan changed to: {}".format(plan_key))
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
                logger.info("[Webhook] Subscription {} -> {} for: {}".format(
                    event_type, status, contract_id))
                # v3.7.286: 解約が確定した時点で解約者台帳にスナップショットを残す。
                #   テナントは解約6ヶ月後に削除されるため、ここで残さないと
                #   「どの顧客がどれだけ契約していたか」が追えなくなる。
                if status in ("canceled", "unpaid") or event_type == "customer.subscription.deleted":
                    try:
                        await supabase_rpc("record_cancellation",
                                           {"p_contract_id": contract_id,
                                            "p_cancelled_on": None,
                                            "p_reason": "Stripe: " + str(event_type)})
                    except Exception as _e:
                        logger.info("record_cancellation failed: %s", type(_e).__name__)

        elif event_type in ("charge.refunded", "refund.created", "refund.updated"):
            # v3.7.286: 返金の台帳反映。
            #   charge.refunded は charge オブジェクト、refund.* は refund オブジェクトが届く。
            #   どちらでも拾えるように正規化する。テストモードの返金も記録し、
            #   台帳側で「テスト」として区別できるようにする (集計から外す判断ができる)。
            is_test = (event.get("livemode") is False)
            if event_type == "charge.refunded":
                charge_id = data.get("id")
                customer_id = data.get("customer")
                stripe_invoice_id = data.get("invoice")
                refunds_list = ((data.get("refunds") or {}).get("data") or [])
                if not refunds_list:
                    # refunds が展開されていない場合は総額で1件として記録
                    refunds_list = [{
                        "id": None,
                        "amount": data.get("amount_refunded") or 0,
                        "currency": data.get("currency") or "jpy",
                        "reason": data.get("reason") or "",
                        "created": data.get("created"),
                    }]
            else:
                charge_id = data.get("charge")
                customer_id = None
                stripe_invoice_id = None
                refunds_list = [data]

            # customer_id が取れないときは charge から引く
            if not customer_id and charge_id:
                try:
                    _ch = await asyncio.to_thread(lambda: stripe.Charge.retrieve(charge_id))
                    customer_id = _ch.get("customer")
                    stripe_invoice_id = stripe_invoice_id or _ch.get("invoice")
                except Exception as e:
                    logger.info("[Webhook] charge retrieve failed: %s", type(e).__name__)

            contract_id = ""
            if customer_id:
                configs = await supabase_query(
                    "config",
                    "stripe_customer_id=eq.{}&select=contract_id".format(customer_id))
                if configs:
                    contract_id = configs[0].get("contract_id") or ""

            recorded = 0
            for rf in refunds_list:
                amount = rf.get("amount") or 0
                if amount <= 0:
                    continue
                # 返金は pending / failed / canceled になりうる。
                # 成功した分だけを計上しないと返金額を過大に記録してしまう。
                # (charge.refunded 由来で status が無い場合は成功扱い)
                rf_status = rf.get("status")
                if rf_status is not None and rf_status != "succeeded":
                    logger.info("[Webhook] refund skipped (status=%s)", rf_status)
                    continue
                ts = rf.get("created")
                refunded_on = None
                if ts:
                    refunded_on = _datetime_module.datetime.fromtimestamp(
                        ts, _datetime_module.timezone.utc).date().isoformat()
                res = await supabase_rpc("record_refund", {
                    "p_source": "stripe",
                    "p_contract_id": contract_id,
                    "p_amount": amount,          # JPY は最小単位=円なのでそのまま
                    "p_refunded_at": refunded_on,
                    "p_reason": rf.get("reason") or "",
                    "p_invoice_no": None,
                    "p_stripe_refund_id": rf.get("id"),
                    "p_stripe_charge_id": charge_id,
                    "p_stripe_invoice_id": stripe_invoice_id,
                    "p_is_test": is_test,
                    "p_currency": rf.get("currency") or "jpy",
                })
                if isinstance(res, dict) and res.get("success"):
                    recorded += 1
            logger.info("[Webhook] refund recorded: %d (contract=%s test=%s)",
                        recorded, contract_id or "-", is_test)

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
                            update_body["payment_failed_at"] = _datetime_module.datetime.utcnow().isoformat()

                        await supabase_query(
                            "config",
                            "contract_id=eq.{}".format(contract_id),
                            method="PATCH",
                            body=update_body
                        )

                        # 3週間(21日)経過チェック → 自動ライセンス停止
                        if existing_failed_at and org_id:
                            # PostgreSQL TIMESTAMPTZ は ISO 8601 (例: 2026-05-22T12:34:56.789012+00:00 or with Z)
                            # fromisoformat は Python 3.11+ で "Z" を受理するが、3.10 以前は不可なので明示置換
                            raw_dt = str(existing_failed_at).strip()
                            failed_date = None
                            try:
                                failed_date = _datetime_module.datetime.fromisoformat(raw_dt.replace("Z", "+00:00"))
                            except Exception as parse_err:
                                logger.warning("[Webhook] payment_failed_at parse failed for %s: %s. Raw=%s",
                                               contract_id, parse_err, raw_dt[:64])
                            if failed_date is not None:
                                # naive datetime なら UTC 扱い
                                if failed_date.tzinfo is None:
                                    failed_date = failed_date.replace(tzinfo=_datetime_module.timezone.utc)
                                days_since = (_datetime_module.datetime.now(_datetime_module.timezone.utc) - failed_date).days
                                if days_since >= 21:
                                    await supabase_rpc("suspend_license", {
                                        "p_organization_id": org_id,
                                        "p_note": "決済未対応21日超過のため自動停止"
                                    })
                                    logger.info("[Webhook] Auto-suspended after 21 days: %s", contract_id)

                        logger.info("[Webhook] Payment failed for: %s", contract_id)

    except Exception as e:
        # v3.7.139: Stripe webhook 例外時は 500 を返して Stripe に再配信させる
        logger.error("[Webhook Error] %s", type(e).__name__)
        import traceback as _tb
        tb_str = _tb.format_exc()
        logger.error(tb_str)
        _notify_error_webhook("Stripe webhook handler error", str(e)[:200], tb_str)
        return JSONResponse(
            status_code=500,
            content={"received": False, "error": "Internal server error - will retry"}
        )

    return {"received": True}


class SendWelcomeEmailRequest(BaseModel):
    contract_id: str
    email: str
    org_name: str
    plan: str = "standard"


@app.post("/admin/send-welcome-email")
async def admin_send_welcome_email(request: Request, req: SendWelcomeEmailRequest):
    """管理画面から手動で案内メールを送信（管理者認証必須）"""
    # セキュリティ: 管理者トークンで認証
    admin_token = os.environ.get("ADMIN_API_TOKEN", "")
    request_token = request.headers.get("x-admin-token", "")
    # v3.7.185: 定数時間比較 (タイミング攻撃対策)
    if not admin_token or not hmac.compare_digest(str(request_token), str(admin_token)):
        return JSONResponse(status_code=403, content={"error": "管理者認証が必要です"})

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
        logger.exception("WelcomeEmail send failed")
        return JSONResponse(status_code=500,
                            content={"error": "メール送信に失敗しました。しばらく時間をおいて再度お試しください。"})


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
            except stripe.error.StripeError:
                # Stripe例外メッセージにキーやリクエストIDが混入し得るため詳細はマスク
                logger.warning("Stripe API error during subscription status check")

        return result

    except Exception as e:
        err_msg = "ステータス取得中にエラーが発生しました" if IS_PRODUCTION else str(e)
        return {"status": "error", "message": err_msg}


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

    # メール送信先（環境変数優先、未設定時は運営アドレス）
    to_email = os.environ.get("INQUIRY_EMAIL_TO") or "rakushift.ai@gmail.com"
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")

    # v3.7.137: メール本文への注入対策 - 制御文字をエスケープ + 長さ制限
    def _safe_mail_text(s, maxlen=500):
        if s is None:
            return ""
        s = str(s)[:maxlen]
        # 制御文字 (改行除く) を空白に
        return "".join(c if c == "\n" or c == "\t" or (ord(c) >= 0x20 and ord(c) != 0x7F) else " " for c in s)

    sc = {
        "company_name":    _safe_mail_text(req.company_name, 200),
        "business_name":   _safe_mail_text(req.business_name, 200),
        "email":           _safe_mail_text(req.email, 200),
        "company_address": _safe_mail_text(req.company_address, 300),
        "phone":           _safe_mail_text(req.phone, 40),
        "contact_name":    _safe_mail_text(req.contact_name, 100),
        "contact_phone":   _safe_mail_text(req.contact_phone, 40),
        "referrer_code":   _safe_mail_text(req.referrer_code, 20),
        "plan_summary":    _safe_mail_text(req.plan_summary, 200),
        "preferred_days":  _safe_mail_text(req.preferred_days, 200),
        "preferred_time":  _safe_mail_text(req.preferred_time, 100),
        "message":         _safe_mail_text(req.message, 2000),
    }

    # メール本文を構築 (sanitize 済みデータを使用)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━
  ラクシフト AI - 法人お問い合わせ
  受信日時: {now}
━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 会社情報
  会社名:     {sc['company_name']}
  事業者名:   {sc['business_name'] or '(なし)'}
  会社住所:   {sc['company_address']}
  メール:     {sc['email'] or '(なし)'}
  代表電話:   {sc['phone']}
  担当者名:   {sc['contact_name']}
  担当者電話: {sc['contact_phone'] or '(なし)'}
  紹介者コード: {sc['referrer_code'] or '(なし)'}

■ 契約予定プラン
  {sc['plan_summary'] or '未選択'}

■ ご連絡希望日程
  希望曜日:   {sc['preferred_days'] or '指定なし'}
  希望時間帯: {sc['preferred_time'] or '指定なし'}

■ その他ご要望
  {sc['message'] or 'なし'}

━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

    logger.info(f"[Inquiry] Received from {sc['company_name']} ({sc['contact_name']})")

    # Supabaseにも保存を試行
    def _to_int(v):
        try:
            return max(0, int(v) if v else 0)  # v3.7.137: 負値を 0 にクランプ
        except (ValueError, TypeError):
            return 0

    db_saved = False
    try:
        inquiry_data = {
            "company_name": req.company_name,
            "business_name": req.business_name,
            "email": req.email,
            "company_address": req.company_address,
            "phone": req.phone,
            "contact_name": req.contact_name,
            "contact_phone": req.contact_phone,
            "plan_summary": req.plan_summary,
            "light_plan_count": _to_int(req.light_plan_count),
            "standard_plan_count": _to_int(req.standard_plan_count),
            "premium_plan_count": _to_int(req.premium_plan_count),
            "preferred_days": req.preferred_days,
            "preferred_time": req.preferred_time,
            "schedule_summary": req.schedule_summary,
            "message": req.message,
            "referrer_code": (req.referrer_code or "").strip().upper() or None,
            "status": "new"
        }
        result = await supabase_query("inquiries", method="POST", body=inquiry_data)
        if result is not None:
            db_saved = True
            logger.info("[Inquiry] Saved to DB")
        else:
            logger.warning("[Inquiry] DB save returned None - check table existence / RLS")
    except Exception as db_err:
        logger.warning(f"[Inquiry] DB save failed: {db_err}")

    # メール送信
    if to_email and smtp_user and smtp_pass:
        msg = MIMEMultipart()
        msg["From"] = smtp_user
        msg["To"] = to_email
        # SMTPヘッダーインジェクション防止: 改行文字を除去
        safe_company = req.company_name.replace("\r", "").replace("\n", "")
        msg["Subject"] = f"【ラクシフト】法人お問い合わせ - {safe_company}"
        msg.attach(MIMEText(body, "plain", "utf-8"))

        def _send_inquiry_sync():
            with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
                server.starttls()
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)

        # SMTP リトライ (3回、指数バックオフ)
        max_retries = 3
        for attempt in range(max_retries):
            try:
                await asyncio.to_thread(_send_inquiry_sync)
                logger.info("Inquiry email sent to %s (attempt %d)", to_email, attempt + 1)
                return {"success": True, "message": "お問い合わせを受け付けました。メール送信完了。"}
            except Exception as mail_err:
                if attempt < max_retries - 1:
                    await asyncio.sleep(2 ** attempt)  # 1s, 2s, 4s
                    continue
                logger.error("Inquiry email failed after %d retries: %s", max_retries, mail_err)
                if db_saved:
                    return {"success": True, "message": "お問い合わせを受け付けました。（メール送信は失敗したためサポート対応中）"}
                else:
                    return JSONResponse(status_code=500, content={"success": False, "message": "お問い合わせの受付に失敗しました。時間をおいて再度お試しください。"})
    else:
        # v3.7.137: SMTP 未設定時の警告強化
        logger.warning(
            "[Inquiry] SMTP NOT CONFIGURED. db_saved=%s. Set INQUIRY_EMAIL_TO/SMTP_USER/SMTP_PASS.",
            db_saved)
        if db_saved:
            return {"success": True, "message": "お問い合わせを受け付けました。(管理者通知は別途確認中)"}
        else:
            _notify_error_webhook(
                "Inquiry SMTP unconfigured AND db save failed",
                f"company={sc['company_name']}, db_saved={db_saved}",
            )
            return JSONResponse(status_code=500, content={
                "success": False,
                "message": "お問い合わせの受付に失敗しました。時間をおいて再度お試しください。"
            })


# =====================================================================
# v3.7.285: 請求書台帳 / 代理店フィー / GASスプレッドシート連携
#
# 背景:
#   決済管理タブは Stripe API を直読みしているだけで、請求書払い・OEM の
#   顧客には請求も入金も保存先が無く「入金履歴が顧客に紐づかない」状態だった。
#   invoices テーブル (migration 87) を台帳として、Stripe / 請求書 / OEM の
#   すべての売上をここに集約する。
# =====================================================================

def _month_start(value: Optional[str]) -> str:
    """'2026-08' / '2026-08-15' / None → 'YYYY-MM-01' に正規化"""
    today = _datetime_module.date.today()
    if not value:
        return today.replace(day=1).isoformat()
    s = str(value).strip()
    try:
        if len(s) == 7:  # YYYY-MM
            return _datetime_module.date.fromisoformat(s + "-01").replace(day=1).isoformat()
        return _datetime_module.date.fromisoformat(s[:10]).replace(day=1).isoformat()
    except ValueError:
        return today.replace(day=1).isoformat()


async def _fetch_invoices(month: Optional[str] = None,
                          months_back: int = 12) -> List[Dict[str, Any]]:
    """請求書台帳を取得。month 指定時はその月のみ、未指定なら直近 months_back ヶ月。

    テーブルを REST で直接読むと PostgREST の max-rows=1000 で静かに切り捨てられる
    (migration 74/75 と同じ罠) ため、JSONB を返す RPC 経由で取得する。
    """
    if month:
        p_from = p_to = _month_start(month)
    else:
        base = _datetime_module.date.fromisoformat(_month_start(None))
        y, m = base.year, base.month - (months_back - 1)
        while m <= 0:
            m += 12
            y -= 1
        p_from = _datetime_module.date(y, m, 1).isoformat()
        p_to = None
    rows = await supabase_rpc("list_invoices", {"p_from": p_from, "p_to": p_to})
    err = _rpc_error(rows)
    if err:
        logger.info("list_invoices failed: %s", err)
    return rows if isinstance(rows, list) else []


def _summarize_invoices(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """請求書台帳から月次サマリー (請求額/入金額/未入金/代理店フィー) を作る"""
    by_month: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        if r.get("status") == "void":
            continue
        m = str(r.get("billing_month") or "")[:7]
        cat = r.get("billing_category") or "invoice"
        b = by_month.setdefault(m, {
            "month": m, "billed": 0.0, "paid": 0.0, "unpaid": 0.0,
            "agency_fee": 0.0, "agency_fee_payable": 0.0,
            "count": 0, "paid_count": 0, "unpaid_count": 0,
            "by_category": {},
        })
        total = float(r.get("total") or 0)
        paid = float(r.get("paid_amount") or 0)
        fee = float(r.get("agency_fee") or 0)
        b["billed"] += total
        b["paid"] += paid
        b["unpaid"] += max(total - paid, 0)
        b["agency_fee"] += fee
        b["count"] += 1
        if r.get("status") == "paid":
            b["paid_count"] += 1
            b["agency_fee_payable"] += fee
        else:
            b["unpaid_count"] += 1
        c = b["by_category"].setdefault(cat, {"billed": 0.0, "paid": 0.0, "count": 0})
        c["billed"] += total
        c["paid"] += paid
        c["count"] += 1
    return {"months": [by_month[k] for k in sorted(by_month, reverse=True)]}


# ---------------------------------------------------------------------
# 運営コンソール (admin.html) 用: 請求書払い/OEM の請求・入金履歴
# ---------------------------------------------------------------------

class InvoicePaymentBody(BaseModel):
    invoice_no: str
    paid_at: Optional[str] = None
    paid_amount: float = 0
    payment_method: str = "bank"
    payer_name: str = ""
    note: Optional[str] = None


class GenerateInvoicesBody(BaseModel):
    month: Optional[str] = None
    contract_id: Optional[str] = None   # 指定するとその顧客だけを生成する


@app.get("/admin/invoices")
@limiter.limit("20/minute")
async def admin_list_invoices(request: Request,
                              month: Optional[str] = None,
                              x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    """請求書払い・OEM を含む全請求の台帳 (顧客に紐づく入金履歴)"""
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})
    try:
        rows = await _fetch_invoices(month)
        unpaid = [r for r in rows if r.get("status") in ("issued", "sent", "partial")]
        paid = [r for r in rows if r.get("status") == "paid"]
        overdue_ref = _datetime_module.date.today().isoformat()
        return {
            "invoices": rows,
            "unpaid": unpaid,
            "paid": paid,
            "overdue": [r for r in unpaid if (r.get("due_date") or "9999-12-31") < overdue_ref],
            "summary": _summarize_invoices(rows),
            "counts": {"all": len(rows), "paid": len(paid), "unpaid": len(unpaid)},
        }
    except Exception as e:
        logger.info("admin invoices error: {}".format(e))
        err = "請求台帳の取得に失敗しました" if IS_PRODUCTION else str(e)
        return JSONResponse(status_code=500, content={"error": err})


@app.post("/admin/invoices/generate")
@limiter.limit("6/minute")
async def admin_generate_invoices(request: Request, req: GenerateInvoicesBody,
                                  x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    """対象月の請求書を一括生成 (請求書払い・OEM の稼働中テナント)"""
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})
    # 生成は常に「今日」を基準にする。
    #   過去の月を指定して遡って請求書を作れてしまうと、既に請求済みの期間や
    #   本来請求しない過去期間の請求書ができてしまう。画面の対象月は
    #   「一覧の絞り込み」だけに使い、生成の基準日には使わない。
    # contract_id 指定時はその顧客だけを対象にする (手動発行の直後など)。
    result = await supabase_rpc("generate_due_invoices", {
        "p_asof": None,
        "p_contract_id": req.contract_id,
    })
    if isinstance(result, dict) and result.get("status") == "error":
        return JSONResponse(status_code=500, content={"error": "請求書の生成に失敗しました"})
    return result


@app.post("/admin/invoices/pay")
@limiter.limit("30/minute")
async def admin_record_payment(request: Request, req: InvoicePaymentBody,
                               x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    """入金を記録 (請求書に紐づけて消し込む)"""
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})
    return await supabase_rpc("record_invoice_payment", {
        "p_invoice_no": req.invoice_no,
        "p_paid_at": req.paid_at or _datetime_module.date.today().isoformat(),
        "p_paid_amount": req.paid_amount,
        "p_payment_method": req.payment_method,
        "p_payer_name": req.payer_name,
        "p_note": req.note,
    })


# ---------------------------------------------------------------------
# GAS (スプレッドシート) 連携
#   認証は x-gas-key ヘッダー。platform_settings.gas_api_key と定数時間比較する。
#   Supabase の service_role キーをスプレッドシート側に置かずに済ませるため、
#   読み書きはすべてこの API を通す。
# ---------------------------------------------------------------------

class GasKeyBody(BaseModel):
    api_key: Optional[str] = None   # 未指定なら安全な乱数を生成する


@app.get("/admin/gas-key")
@limiter.limit("20/minute")
async def admin_get_gas_key(request: Request,
                            x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    """GAS連携キーの設定状況 (キー本体は返さない)"""
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})
    _load_platform_settings()
    key = _get_setting("gas_api_key")
    return {
        "configured": bool(key) and len(key) >= 16,
        "masked": ("{}****{}".format(key[:4], key[-4:]) if key and len(key) >= 16 else ""),
    }


@app.post("/admin/gas-key")
@limiter.limit("6/minute")
async def admin_set_gas_key(request: Request, req: GasKeyBody,
                            x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    """GAS連携キーを発行/更新して、生成したキーを1度だけ返す"""
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})

    key = (req.api_key or "").strip()
    if not key:
        import secrets
        key = secrets.token_urlsafe(36)
    if len(key) < 16:
        return JSONResponse(status_code=400,
                            content={"error": "APIキーは16文字以上にしてください"})

    result = await supabase_rpc("update_platform_setting",
                                {"p_key": "gas_api_key", "p_value": key})
    if not (isinstance(result, dict) and result.get("success")):
        return JSONResponse(status_code=500, content={"error": "APIキーの保存に失敗しました"})

    # 直後の接続確認で古い値が使われないよう、設定キャッシュを捨てる
    global _platform_settings, _settings_loaded_at
    _platform_settings["gas_api_key"] = key
    _settings_loaded_at = 0
    return {"success": True, "api_key": key}


class RefundBody(BaseModel):
    contract_id: str
    amount: float
    refunded_at: Optional[str] = None
    reason: str = ""
    invoice_no: Optional[str] = None
    source: str = "manual"


@app.post("/admin/refunds")
@limiter.limit("20/minute")
async def admin_record_refund(request: Request, req: RefundBody,
                              x_session_id: Optional[str] = Header(None, alias="x-session-id")):
    """返金を台帳に記録 (請求書払い・手動返金用)"""
    session_info = await verify_session_org_id(x_session_id)
    if not session_info or session_info.get("role") != "platform_admin":
        return JSONResponse(status_code=403, content={"error": "運営管理者の認証が必要です"})
    return await supabase_rpc("record_refund", {
        "p_source": req.source or "manual",
        "p_contract_id": req.contract_id,
        "p_amount": req.amount,
        "p_refunded_at": req.refunded_at,
        "p_reason": req.reason,
        "p_invoice_no": req.invoice_no,
        "p_stripe_refund_id": None,
        "p_stripe_charge_id": None,
        "p_stripe_invoice_id": None,
        "p_is_test": False,
        "p_currency": "jpy",
    })


def _verify_gas_key(provided: Optional[str]) -> bool:
    _load_platform_settings()
    expected = _get_setting("gas_api_key")
    if not expected or len(expected) < 16:
        return False
    # hmac.compare_digest は str 同士だと非ASCIIで TypeError を投げるため、
    # ヘッダーに日本語等が入ってきても 500 にならないようバイト列で比較する。
    try:
        return hmac.compare_digest(str(provided or "").encode("utf-8"),
                                   expected.encode("utf-8"))
    except Exception:
        return False


def _gas_denied() -> JSONResponse:
    return JSONResponse(status_code=403, content={"error": "GAS APIキーが不正です"})


@app.get("/gas/export")
@limiter.limit("30/minute")
async def gas_export(request: Request,
                     sheet: str = "all",
                     month: Optional[str] = None,
                     x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """スプレッドシート同期用の一括エクスポート。

    運営に関わるデータをすべて返す:
      customers  … 顧客台帳 (プラン/代理店/代理店フィー/入金状況)
      bank       … 入金明細と自動消込の結果
      refunds    … 返金台帳 (Stripe / 請求書払い)
      cancellations … 解約者台帳 (契約期間つき。テナント削除後も残る)
      inquiries  … お問い合わせフォームの全項目 (Stripe決済前の見込みも含む全件)
      invoices   … 請求書・入金台帳 (売上管理の元データ)
      stripe     … Stripe の決済履歴
      referrers  … 紹介者(代理店)マスタ
      agency     … 代理店フィーの月次確定集計
      reconcile  … お問い合わせ × 顧客 の突合 (抜け検出)
      summary    … 月次売上サマリー
    """
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()

    want = {s.strip() for s in sheet.split(",")} if sheet != "all" else {"all"}

    def need(name: str) -> bool:
        return "all" in want or name in want

    out: Dict[str, Any] = {
        "generated_at": _datetime_module.datetime.now(_datetime_module.timezone.utc).isoformat(),
        "month": _month_start(month),
    }
    errors = []

    # customers / inquiries も JSONB を返す RPC 経由。
    # ビュー/テーブルの REST 直読みは 1000件で静かに欠落する。
    if need("customers"):
        try:
            rows = await supabase_rpc("list_customer_ledger", {})
            err = _rpc_error(rows)
            if err:
                errors.append("customers: {}".format(err))
            out["customers"] = rows if isinstance(rows, list) else []
        except Exception as e:
            errors.append("customers: {}".format(type(e).__name__))

    if need("inquiries"):
        try:
            # to_jsonb(i) で全カラム返るため、フォーム項目が増えてもシートに自動で載る
            rows = await supabase_rpc("list_inquiries_all", {})
            err = _rpc_error(rows)
            if err:
                errors.append("inquiries: {}".format(err))
            out["inquiries"] = rows if isinstance(rows, list) else []
        except Exception as e:
            errors.append("inquiries: {}".format(type(e).__name__))

    if need("invoices"):
        try:
            # 対象月では絞らない。売上サマリーを複数月で出すため、また過去月の
            # 未入金を追えるようにするため、常に直近24ヶ月を返して GAS 側で絞る。
            out["invoices"] = await _fetch_invoices(None, months_back=24)
        except Exception as e:
            errors.append("invoices: {}".format(type(e).__name__))

    if need("referrers"):
        try:
            rows = await supabase_rpc("list_referrers", {})
            err = _rpc_error(rows)
            if err:
                errors.append("referrers: {}".format(err))
            out["referrers"] = rows if isinstance(rows, list) else []
        except Exception as e:
            errors.append("referrers: {}".format(type(e).__name__))

    if need("agency"):
        try:
            rows = await supabase_rpc("list_agency_fees", {"p_month": _month_start(month)})
            err = _rpc_error(rows)
            if err:
                errors.append("agency: {}".format(err))
            out["agency"] = rows if isinstance(rows, list) else []
        except Exception as e:
            errors.append("agency: {}".format(type(e).__name__))

    if need("reconcile"):
        try:
            rows = await supabase_rpc("reconcile_inquiries", {})
            err = _rpc_error(rows)
            if err:
                errors.append("reconcile: {}".format(err))
            out["reconcile"] = rows if isinstance(rows, dict) and not err else {}
        except Exception as e:
            errors.append("reconcile: {}".format(type(e).__name__))

    if need("bank"):
        try:
            rows = await supabase_rpc("list_bank_transactions", {"p_days": 180})
            err = _rpc_error(rows)
            if err:
                errors.append("bank: {}".format(err))
            out["bank"] = rows if isinstance(rows, list) else []
        except Exception as e:
            errors.append("bank: {}".format(type(e).__name__))

    if need("refunds"):
        try:
            rows = await supabase_rpc("list_refunds", {"p_from": None})
            err = _rpc_error(rows)
            if err:
                errors.append("refunds: {}".format(err))
            out["refunds"] = rows if isinstance(rows, list) else []
        except Exception as e:
            errors.append("refunds: {}".format(type(e).__name__))

    if need("cancellations"):
        try:
            # 解約済みテナントの差分を台帳へ取り込んでから返す
            await supabase_rpc("sync_cancellations", {})
            rows = await supabase_rpc("list_cancellations", {})
            err = _rpc_error(rows)
            if err:
                errors.append("cancellations: {}".format(err))
            out["cancellations"] = rows if isinstance(rows, list) else []
        except Exception as e:
            errors.append("cancellations: {}".format(type(e).__name__))

    if need("stripe"):
        try:
            out["stripe"] = await _collect_stripe_payments()
        except Exception as e:
            out["stripe"] = {"paid": [], "unpaid": [], "configured": False}
            errors.append("stripe: {}".format(type(e).__name__))

    if need("summary"):
        try:
            rows = out.get("invoices")
            if rows is None:
                rows = await _fetch_invoices(None, months_back=24)
            out["summary"] = _summarize_invoices(rows)
        except Exception as e:
            errors.append("summary: {}".format(type(e).__name__))

    if errors:
        # 一部が落ちても取れた分は返す (シート同期を全滅させない)
        out["errors"] = errors
        logger.info("gas export partial failure: %s", errors)
    return out


class GasPaymentRow(BaseModel):
    invoice_no: str
    paid_at: Optional[str] = None
    paid_amount: float = 0
    payment_method: str = "bank"
    payer_name: str = ""
    note: Optional[str] = None


class GasPaymentsBody(BaseModel):
    rows: List[GasPaymentRow] = Field(default_factory=list)


@app.post("/gas/invoices/payments")
@limiter.limit("20/minute")
async def gas_record_payments(request: Request, req: GasPaymentsBody,
                              x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """スプレッドシートで入力した入金をまとめて書き戻す (消込)"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    if len(req.rows) > 500:
        return JSONResponse(status_code=400, content={"error": "一度に処理できるのは500件までです"})

    results, ok = [], 0
    for row in req.rows:
        r = await supabase_rpc("record_invoice_payment", {
            "p_invoice_no": row.invoice_no,
            "p_paid_at": row.paid_at or _datetime_module.date.today().isoformat(),
            "p_paid_amount": row.paid_amount,
            "p_payment_method": row.payment_method,
            "p_payer_name": row.payer_name,
            "p_note": row.note,
        })
        if isinstance(r, dict) and r.get("success"):
            ok += 1
        results.append(r if isinstance(r, dict)
                       else {"success": False, "invoice_no": row.invoice_no})
    return {"success": True, "updated": ok, "failed": len(req.rows) - ok, "results": results}


class GasAgencyRow(BaseModel):
    contract_id: str
    referrer_code: Optional[str] = None
    agency_fee_type: Optional[str] = None
    agency_fee_amount: Optional[float] = None
    billing_email: Optional[str] = None
    payment_terms_days: Optional[int] = None
    billing_start_date: Optional[str] = None
    payer_names: Optional[str] = None


class GasAgencyBody(BaseModel):
    rows: List[GasAgencyRow] = Field(default_factory=list)


@app.post("/gas/customers/agency")
@limiter.limit("20/minute")
async def gas_update_agency(request: Request, req: GasAgencyBody,
                            x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """顧客の代理店(紹介者)・代理店フィー設定をスプレッドシートから書き戻す"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    if len(req.rows) > 500:
        return JSONResponse(status_code=400, content={"error": "一度に処理できるのは500件までです"})

    results, ok = [], 0
    for row in req.rows:
        r = await supabase_rpc("update_customer_agency", {
            "p_contract_id": row.contract_id,
            "p_referrer_code": row.referrer_code,
            "p_fee_type": row.agency_fee_type,
            "p_fee_amount": row.agency_fee_amount,
            "p_billing_email": row.billing_email,
            "p_payment_terms_days": row.payment_terms_days,
            "p_billing_start_date": row.billing_start_date,
            "p_payer_names": row.payer_names,
        })
        if isinstance(r, dict) and r.get("success"):
            ok += 1
        results.append(r if isinstance(r, dict)
                       else {"success": False, "contract_id": row.contract_id})
    return {"success": True, "updated": ok, "failed": len(req.rows) - ok, "results": results}


@app.post("/gas/invoices/generate")
@limiter.limit("6/minute")
async def gas_generate_invoices(request: Request, req: GenerateInvoicesBody,
                                x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """対象月の請求書を一括生成"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    return await supabase_rpc("generate_monthly_invoices",
                              {"p_month": _month_start(req.month)})


class GasMarkDraftedBody(BaseModel):
    invoice_nos: List[str] = Field(default_factory=list)


class BankTxRow(BaseModel):
    paid_on: str
    amount: float
    payer_name: str = ""
    memo: str = ""
    source: str = "csv"
    # 銀行明細の取引識別子 (残高・取引番号・メールのメッセージID)。
    # これを落とすと二重取込の判定が「同内容なら連番」に退化し、
    # 毎朝のメール取込が同じ入金を日々加算してしまう。
    ref: str = ""


class BankTxBody(BaseModel):
    rows: List[BankTxRow] = Field(default_factory=list)


@app.post("/gas/payments/import")
@limiter.limit("20/minute")
async def gas_import_payments(request: Request, req: BankTxBody,
                              x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """銀行の入金明細を取り込む (同じ明細は二重に登録しない)"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    if len(req.rows) > 1000:
        return JSONResponse(status_code=400, content={"error": "一度に処理できるのは1000件までです"})

    imported = dup = failed = 0
    for row in req.rows:
        r = await supabase_rpc("import_bank_transaction", {
            "p_paid_on": row.paid_on,
            "p_amount": row.amount,
            "p_payer_name": row.payer_name,
            "p_memo": row.memo,
            "p_source": row.source,
            "p_ref": row.ref,
        })
        if isinstance(r, dict) and r.get("success"):
            if r.get("duplicated"):
                dup += 1
            else:
                imported += 1
        else:
            failed += 1
    return {"success": True, "imported": imported, "duplicated": dup, "failed": failed}


@app.post("/gas/payments/match")
@limiter.limit("10/minute")
async def gas_match_payments(request: Request,
                             x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """取り込んだ入金明細を未入金の請求書へ自動照合する"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    return await supabase_rpc("auto_match_payments", {"p_days": 90})


@app.get("/gas/invoices/overdue")
@limiter.limit("20/minute")
async def gas_overdue(request: Request,
                      x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """督促対象 (期日超過・未督促または前回から間隔が空いたもの)"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    _load_platform_settings()
    rows = await supabase_rpc("list_overdue_for_reminder", {
        "p_grace_days": 1, "p_interval_days": 7, "p_max_count": 3})
    return {"invoices": rows if isinstance(rows, list) else []}


@app.post("/gas/invoices/mark-reminded")
@limiter.limit("20/minute")
async def gas_mark_reminded(request: Request, req: GasMarkDraftedBody,
                            x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """督促を送った記録 (同じ請求に何度も送らないため)"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    nos = [n for n in req.invoice_nos if n][:500]
    if not nos:
        return {"success": True, "updated": 0}
    return await supabase_rpc("mark_reminder_sent", {"p_invoice_nos": nos})


@app.post("/gas/invoices/mark-sent")
@limiter.limit("20/minute")
async def gas_mark_sent(request: Request, req: GasMarkDraftedBody,
                        x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """請求書メールを実際に送信した記録 (自動送信を有効にしたとき用)"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    nos = [n for n in req.invoice_nos if n][:500]
    if not nos:
        return {"success": True, "updated": 0}
    return await supabase_rpc("mark_invoices_sent", {"p_invoice_nos": nos})


@app.post("/gas/invoices/mark-drafted")
@limiter.limit("20/minute")
async def gas_mark_drafted(request: Request, req: GasMarkDraftedBody,
                           x_gas_key: Optional[str] = Header(None, alias="x-gas-key")):
    """Gmail下書きを作成した請求書に印を付ける (二重下書きの防止)"""
    if not _verify_gas_key(x_gas_key):
        return _gas_denied()
    nos = [n for n in req.invoice_nos if n][:500]
    if not nos:
        return {"success": True, "updated": 0}

    now = _datetime_module.datetime.now(_datetime_module.timezone.utc).isoformat()
    quoted = ",".join('"{}"'.format(n.replace('"', '')) for n in nos)
    rows = await supabase_query(
        "invoices", "invoice_no=in.({})".format(quoted), method="PATCH",
        body={"email_draft_at": now})
    return {"success": rows is not None, "updated": len(rows or [])}


# deploy: 20260516-0508
