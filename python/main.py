import os
import json
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from pydantic import BaseModel
from scheduler import ShiftScheduler  # 数理最適化
from ai_scheduler import AIShiftScheduler # Gemini AI

app = FastAPI()

# リクエストボディの定義
class ShiftRequest(BaseModel):
    staff_list: List[Dict[str, Any]]
    config: Dict[str, Any]
    dates: List[str]
    requests: List[Dict[str, Any]] = []
    mode: str = "auto"  # 'auto', 'math', 'ai'

@app.get("/")
def read_root():
    return {"status": "ok", "service": "Rakushift Calculation Engine"}

@app.post("/generate")
def generate_shifts(req: ShiftRequest, authorization: Optional[str] = Header(None)):
    """
    シフト生成のエンドポイント
    - AuthorizationヘッダーでSupabaseのトークンを検証することを推奨 (今回は簡易実装)
    """
    
    # 1. まず数理最適化で試す (コスト安・高速・正確)
    if req.mode in ["auto", "math"]:
        try:
            print("Running Math Scheduler...")
            scheduler = ShiftScheduler(req.staff_list, req.config, req.dates, req.requests)
            result = scheduler.solve()
            
            if result:
                return {"status": "success", "mode": "math", "shifts": result}
            
            print("Math Scheduler failed to find solution.")
        except Exception as e:
            print(f"Math Scheduler Error: {e}")

    # 2. 数理モデルで解けない、またはAIモード指定ならGemini発動
    if req.mode in ["auto", "ai"]:
        # APIキーの確認
        gemini_key = os.environ.get("GEMINI_API_KEY")
        if not gemini_key:
            # 環境変数になければリクエスト内のconfigから探す（クライアント側設定の場合）
            gemini_key = req.config.get("gemini_api_key")
        
        if not gemini_key:
             raise HTTPException(status_code=400, detail="Math optimization failed and no Gemini API Key provided for fallback.")

        try:
            print("Running AI Scheduler (Gemini)...")
            ai_scheduler = AIShiftScheduler(api_key=gemini_key)
            result = ai_scheduler.generate(req.staff_list, req.config, req.dates, req.requests)
            
            if result:
                return {"status": "success", "mode": "ai", "shifts": result}
            
        except Exception as e:
            print(f"AI Scheduler Error: {e}")
            raise HTTPException(status_code=500, detail=f"AI Generation Failed: {str(e)}")

    raise HTTPException(status_code=422, detail="Could not generate shifts with given constraints.")
