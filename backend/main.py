from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import os
import sys

# scheduler.py をインポートできるようにパスを通す（必要であれば）
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from scheduler import ShiftScheduler

app = FastAPI()

# CORS設定 (フロントエンドからのアクセスを許可)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 本番環境では具体的なドメインを指定することを推奨
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- データモデル定義 ---
class ShiftRequest(BaseModel):
    staff_list: List[Dict[str, Any]]
    config: Dict[str, Any]
    dates: List[str]
    requests: List[Dict[str, Any]] = []

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Rakushift Optimization Engine is Running"}

@app.post("/optimize")
def optimize_shifts(payload: ShiftRequest):
    """
    フロントエンドからデータを受け取り、最適化されたシフトを返すAPI
    """
    print(f"Request received for dates: {payload.dates}")
    
    try:
        # スケジューラーロジックの実行
        scheduler = ShiftScheduler(
            staff_list=payload.staff_list,
            config=payload.config,
            dates=payload.dates,
            requests=payload.requests
        )
        
        result = scheduler.solve()
        
        if not result:
            return {
                "status": "failed", 
                "message": "条件を満たす解が見つかりませんでした。要件（必要人数や勤務時間）を緩和して再試行してください。", 
                "shifts": []
            }
            
        return {"status": "success", "shifts": result}

    except Exception as e:
        print(f"Server Error: {e}")
        # 詳細なエラーログを返す
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
