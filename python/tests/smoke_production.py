"""本番ユーザー設定を再現した精度テスト。

実際の本番設定 (スクリーンショットより):
- 9名 (月給4 + 時給5)
- 全員 min_days_week=5 (岩井のみ 6), min_days_month=21 (岩井のみ 24)
- 全員 max_days_week=5 (岩井のみ 6), max_hours_day=8〜10
- 全員「希望時間 ON」+ pref_start_wd=10:00 / pref_end_wd=19:00 (平日のみ)
- pref_start_we / pref_end_we は空欄 (土日希望未設定)
- 営業時間: 10:00-19:00 (推定)
- 必要人数: 平日6名 / 土日4名
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from scheduler import ShiftScheduler
from datetime import datetime, timedelta


def daterange(start_str, days):
    s = datetime.strptime(start_str, "%Y-%m-%d")
    return [(s + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)]


def scenario_production():
    staff = [
        # 月給スタッフ (社員)
        {"id": "m1", "name": "名倉", "role": "employee", "salary_type": "monthly",
         "hourly_wage": 0, "monthly_salary": 250000, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 10, "min_days_week": 5, "min_days_month": 21,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "medium", "contract_type": "general"},
        {"id": "m2", "name": "坂本", "role": "employee", "salary_type": "monthly",
         "hourly_wage": 0, "monthly_salary": 250000, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 10, "min_days_week": 5, "min_days_month": 21,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "medium", "contract_type": "general"},
        {"id": "m3", "name": "山田", "role": "manager", "salary_type": "monthly",
         "hourly_wage": 0, "monthly_salary": 400000, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 5, "min_days_month": 21,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "high", "contract_type": "regular"},
        {"id": "m4", "name": "岩井", "role": "sub_manager", "salary_type": "monthly",
         "hourly_wage": 0, "monthly_salary": 290000, "evaluation": "A",
         "max_days_week": 6, "max_hours_day": 10, "min_days_week": 6, "min_days_month": 24,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "high", "contract_type": "regular"},
        # 時給スタッフ (パート/学生)
        {"id": "h1", "name": "岩村", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 4, "min_days_month": 17,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "medium", "contract_type": "general"},
        {"id": "h2", "name": "岸本", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 4, "min_days_month": 17,
         "pref_start_wd": "09:00", "pref_end_wd": "18:00",
         "shift_priority": "medium", "contract_type": "general"},
        {"id": "h3", "name": "江口", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 4, "min_days_month": 17,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "medium", "contract_type": "general"},
        {"id": "h4", "name": "矢口", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 4, "min_days_month": 17,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "medium", "contract_type": "general"},
        {"id": "h5", "name": "西田", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 4, "min_days_month": 17,
         "pref_start_wd": "10:00", "pref_end_wd": "19:00",
         "shift_priority": "medium", "contract_type": "general"},
    ]
    config = {
        "opening_time": "10:00", "closing_time": "19:00",
        "business_hours": {
            "weekday": {"start": "10:00", "end": "19:00"},
            "weekend": {"start": "10:00", "end": "19:00"},
            "holiday": {"start": "10:00", "end": "19:00"},
        },
        "staff_req": {
            "min_weekday": 6, "min_weekend": 4, "min_holiday": 4,
            "min_manager": 1
        },
        "closed_days": [],
        "custom_shifts": [
            # v3.7.29 再検証: 「シフトパターン1つ」の本番パターンを再現
            {"name": "終日", "start": "10:00", "end": "19:00"},
        ],
    }
    return staff, config, daterange("2026-06-01", 28), []


def main():
    staff, config, dates, requests = scenario_production()
    print(f"\n=== 本番再現シナリオ: {len(staff)}名 / {len(dates)}日 ===")
    print(f"     月給4名 + 時給5名、min_days_month合計 = "
          f"{sum(s['min_days_month'] for s in staff)}人日\n")

    import time
    t0 = time.time()
    sch = ShiftScheduler(staff_list=staff, config=config, dates=dates, requests=requests)
    shifts = sch.solve(force=False)
    elapsed = time.time() - t0

    if not shifts:
        print(f"❌ 生成失敗 ({elapsed:.2f}s)")
        return

    # 日別配置数とピーク
    by_date = {}
    for s in shifts:
        by_date.setdefault(s["date"], []).append(s)

    def to_min(t):
        h, m = t.split(":")[:2]
        return int(h) * 60 + int(m)

    print(f"⏱  求解時間: {elapsed:.2f}s")
    print(f"📊 総シフト数: {len(shifts)}")
    print()
    print(f"{'日付':12} {'曜':3} {'配置':5} {'ピーク':6} {'必要':5} {'判定':6}")
    over_days = 0
    for d in dates:
        wd_idx = datetime.strptime(d, "%Y-%m-%d").weekday()
        wd = ['月','火','水','木','金','土','日'][wd_idx]
        req = 4 if wd_idx >= 5 else 6
        ds = by_date.get(d, [])
        cnt = len(ds)
        slot_counts = {}
        for s in ds:
            start = to_min(s["start_time"])
            end = to_min(s["end_time"])
            if end <= start:
                end += 1440
            for t in range(start, end, 15):
                slot_counts[t % 1440] = slot_counts.get(t % 1440, 0) + 1
        peak = max(slot_counts.values()) if slot_counts else 0
        diff = peak - req
        verdict = "ぴったり" if diff == 0 else (f"過剰+{diff}" if diff > 0 else f"不足{diff}")
        if diff > 0:
            over_days += 1
        print(f"{d}  {wd}  {cnt}人  {peak}人   {req}人   {verdict}")

    print()
    print(f"過剰日数: {over_days}/{len(dates)}")

    # スタッフ別出勤日数
    print()
    print("【スタッフ別 出勤日数 vs 最低出勤日数】")
    by_staff = {}
    for s in shifts:
        by_staff[s["staff_id"]] = by_staff.get(s["staff_id"], 0) + 1
    for st in staff:
        sid = st["id"]
        actual = by_staff.get(sid, 0)
        target = st["min_days_month"]
        diff = actual - target
        mark = "✓" if diff >= 0 else f"⚠ {diff}日不足"
        print(f"  {st['name']:6} ({st['salary_type']:7}): "
              f"{actual:2}/{target:2}日  {mark}")


if __name__ == "__main__":
    main()
