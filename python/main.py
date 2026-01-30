import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
from scheduler import ShiftScheduler

app = FastAPI()

# ★★★ CORS設定 (これがないとブラウザから拒否される) ★★★
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # すべてのサイトからのアクセスを許可
    allow_credentials=True,
    allow_methods=["*"],  # GET, POSTなど全て許可
    allow_headers=["*"],  # ヘッダーも全て許可
)

# リクエストのデータ型定義
class ShiftRequest(BaseModel):
    staff_list: List[Dict[str, Any]]
    config: Dict[str, Any]
    dates: List[str]
    requests: List[Dict[str, Any]] = []
    mode: str = "auto"

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Rakushift Engine is Ready"}

@app.post("/generate")
def generate_shifts(req: ShiftRequest):
    print(f"Received request: {len(req.staff_list)} staff, {len(req.dates)} dates")
    
    try:
        # 数理最適化を実行 (scheduler.py)
        scheduler = ShiftScheduler(req.staff_list, req.config, req.dates, req.requests)
        result = scheduler.solve()
        
        # 結果を返す
        if result:
            return {"status": "success", "mode": "math", "shifts": result}
        else:
            # 解なしの場合でもエラーにせず空配列を返す
            return {"status": "success", "mode": "math_failed", "shifts": []}
            
    except Exception as e:
        print(f"Error: {e}")
        return {"status": "error", "message": str(e)}
