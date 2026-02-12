import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
from scheduler import ShiftScheduler

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ShiftRequest(BaseModel):
    staff_list: List[Dict[str, Any]]
    config: Dict[str, Any]
    dates: List[str]
    requests: List[Dict[str, Any]] = []
    mode: str = "auto"


@app.get("/")
def read_root():
    return {"status": "ok", "message": "Rakushift Engine is Ready"}


@app.post("/check")
def check_feasibility(req: ShiftRequest):
    try:
        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests)
        result = scheduler.pre_check()
        return {"status": "success", "check": result}
    except Exception as e:
        print("Check Error: {}".format(e))
        return {"status": "error", "message": str(e)}


@app.post("/generate")
def generate_shifts(req: ShiftRequest):
    print("Received request: {} staff, {} dates, mode={}".format(
        len(req.staff_list), len(req.dates), req.mode))

    try:
        scheduler = ShiftScheduler(
            req.staff_list, req.config, req.dates, req.requests)

        force = (req.mode == "force")
        result = scheduler.solve(force=force)

        if result:
            return {
                "status": "success",
                "mode": "math_force" if force else "math",
                "shifts": result
            }
        else:
            return {"status": "success", "mode": "math_failed", "shifts": []}

    except Exception as e:
        print("Error: {}".format(e))
        return {"status": "error", "message": str(e)}
