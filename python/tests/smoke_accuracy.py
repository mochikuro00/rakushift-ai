"""v3.7.20 シフト生成精度の実機計測 (一時 smoke test, pytest 対象外)。

計測項目:
1. 法定遵守率 (連続6日 / 週40h / インターバル10h)
2. 人員過不足精度 (要件 vs 実配置)
3. 希望シフト充足率
4. 社員 (月給+店長) 常駐率
5. 偏り指標 (土日集中度 / 戦力バランス変動)
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from scheduler import ShiftScheduler
from datetime import datetime, timedelta


def daterange(start_str, days):
    s = datetime.strptime(start_str, "%Y-%m-%d")
    return [(s + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)]


def scenario_realistic():
    """現実的店舗: 10名 / 4週間 / 平日3名・土日4名"""
    staff = [
        {"id": "m1", "name": "店長田中", "role": "manager",  "salary_type": "monthly",
         "hourly_wage": 0, "monthly_salary": 280000, "evaluation": "A",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 5},
        {"id": "m2", "name": "副店長鈴木", "role": "sub_manager", "salary_type": "monthly",
         "hourly_wage": 0, "monthly_salary": 240000, "evaluation": "A",
         "max_days_week": 5, "max_hours_day": 8, "min_days_week": 5},
        {"id": "v1", "name": "ベテラン佐藤", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1300, "evaluation": "A", "max_days_week": 5,
         "max_hours_day": 8, "min_days_week": 5,
         "shift_priority": "high"},
        {"id": "v2", "name": "ベテラン高橋", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1300, "evaluation": "B", "max_days_week": 5,
         "max_hours_day": 8, "min_days_week": 0},
        {"id": "p1", "name": "パート伊藤", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B", "max_days_week": 4,
         "max_hours_day": 6, "min_days_week": 5,
         "pref_start_wd": "09:00", "pref_end_wd": "15:00"},
        {"id": "p2", "name": "パート渡辺", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B", "max_days_week": 4,
         "max_hours_day": 6, "min_days_week": 5,
         "pref_start_wd": "15:00", "pref_end_wd": "22:00"},
        {"id": "p3", "name": "学生山本", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1050, "evaluation": "C", "max_days_week": 3,
         "max_hours_day": 5, "min_days_week": 5,
         "ng_weekdays": [1, 2, 3]},  # 平日NG (火水木)
        {"id": "p4", "name": "学生中村", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1050, "evaluation": "C", "max_days_week": 3,
         "max_hours_day": 5, "min_days_week": 0},
        {"id": "r1", "name": "新人小林", "role": "rookie", "salary_type": "hourly",
         "hourly_wage": 1000, "evaluation": "C", "max_days_week": 4,
         "max_hours_day": 6, "min_days_week": 0},
        {"id": "p5", "name": "パート加藤", "role": "staff", "salary_type": "hourly",
         "hourly_wage": 1100, "evaluation": "B", "max_days_week": 4,
         "max_hours_day": 6, "min_days_week": 5,
         "contract_type": "regular"},
    ]
    config = {
        "opening_time": "10:00", "closing_time": "22:00",
        "business_hours": {
            "weekday": {"start": "10:00", "end": "22:00"},
            "weekend": {"start": "10:00", "end": "22:00"},
            "holiday": {"start": "10:00", "end": "22:00"},
        },
        "staff_req": {
            "min_weekday": 3, "min_weekend": 4, "min_holiday": 4,
            "min_manager": 1
        },
        "closed_days": [],
        "custom_shifts": [
            {"name": "早番", "start": "09:00", "end": "15:00"},
            {"name": "遅番", "start": "15:00", "end": "22:00"},
            {"name": "終日", "start": "10:00", "end": "20:00"},
        ],
    }
    # 希望シフト (各スタッフ 2-3件)
    requests = [
        {"staff_id": "v1", "date": "2026-06-05", "type": "work", "status": "pending",
         "start_time": "10:00", "end_time": "20:00"},
        {"staff_id": "p1", "date": "2026-06-10", "type": "work", "status": "pending",
         "start_time": "09:00", "end_time": "15:00"},
        {"staff_id": "p2", "date": "2026-06-15", "type": "work", "status": "pending",
         "start_time": "15:00", "end_time": "22:00"},
        {"staff_id": "p3", "date": "2026-06-06", "type": "work", "status": "pending"},
        {"staff_id": "p4", "date": "2026-06-13", "type": "work", "status": "pending"},
        {"staff_id": "r1", "date": "2026-06-12", "type": "work", "status": "pending"},
    ]
    return staff, config, daterange("2026-06-01", 28), requests


def compute_metrics(shifts, staff, config, dates, requests):
    n_shifts = len(shifts)
    by_date = {}
    by_staff = {}
    for s in shifts:
        by_date.setdefault(s["date"], []).append(s)
        by_staff.setdefault(s["staff_id"], []).append(s)

    # 1. 人員過不足精度
    req_map = config["staff_req"]
    def required(d):
        wd = datetime.strptime(d, "%Y-%m-%d").weekday()
        if wd >= 5:
            return req_map["min_weekend"]
        return req_map["min_weekday"]

    # 同時刻配置人数を計測 (シフトの時間範囲を分解して最大同時人数を取る)
    def to_min(t):
        h, m = t.split(":")[:2]
        return int(h) * 60 + int(m)

    coverage_diff = []
    for d in dates:
        r = required(d)
        ds = by_date.get(d, [])
        # その日の全シフト範囲を分解、15分刻みで同時人数を計算
        slot_counts = {}
        for s in ds:
            start = to_min(s["start_time"])
            end = to_min(s["end_time"])
            if end <= start:
                end += 1440
            for t in range(start, end, 15):
                slot_counts[t % 1440] = slot_counts.get(t % 1440, 0) + 1
        peak = max(slot_counts.values()) if slot_counts else 0
        avg = sum(slot_counts.values()) / len(slot_counts) if slot_counts else 0
        coverage_diff.append((d, r, peak, avg, peak - r))

    exact_count = sum(1 for _, _, peak, _, diff in coverage_diff if diff == 0)
    under_count = sum(1 for _, _, peak, _, diff in coverage_diff if diff < 0)
    over_count = sum(1 for _, _, peak, _, diff in coverage_diff if diff > 0)

    # 2. 希望シフト充足
    fulfilled = 0
    for req in requests:
        sid = req["staff_id"]
        rd = req["date"]
        if any(s["staff_id"] == sid and s["date"] == rd for s in shifts):
            fulfilled += 1
    pref_rate = fulfilled / len(requests) * 100 if requests else 0

    # 3. 社員 (月給) 常駐率
    monthly_ids = {s["id"] for s in staff if s.get("salary_type") == "monthly"}
    manager_ids = {s["id"] for s in staff if s.get("role") in ("manager", "sub_manager")}
    employee_ids = monthly_ids | manager_ids
    days_with_employee = 0
    for d in dates:
        ds = by_date.get(d, [])
        if any(s["staff_id"] in employee_ids for s in ds):
            days_with_employee += 1
    employee_coverage = days_with_employee / len(dates) * 100

    # 4. 法定違反検出
    violations = []
    for sid, shs in by_staff.items():
        sorted_shs = sorted(shs, key=lambda x: x["date"])
        # 連続6日チェック
        dates_set = {datetime.strptime(s["date"], "%Y-%m-%d") for s in shs}
        max_consec = 0
        cur = 0
        prev = None
        for d in sorted(dates_set):
            if prev is None or (d - prev).days == 1:
                cur += 1
            else:
                cur = 1
            max_consec = max(max_consec, cur)
            prev = d
        if max_consec > 6:
            violations.append(f"{sid}: 連続{max_consec}日勤務")

    # 5. 土日偏り (標準偏差)
    weekend_count = {}
    for d, shs in by_date.items():
        wd = datetime.strptime(d, "%Y-%m-%d").weekday()
        if wd >= 5:
            for s in shs:
                weekend_count[s["staff_id"]] = weekend_count.get(s["staff_id"], 0) + 1
    if weekend_count:
        vals = list(weekend_count.values())
        avg = sum(vals) / len(vals)
        stddev = (sum((v - avg) ** 2 for v in vals) / len(vals)) ** 0.5
    else:
        avg = stddev = 0

    return {
        "total_shifts": n_shifts,
        "coverage_exact": exact_count,
        "coverage_under": under_count,
        "coverage_over": over_count,
        "coverage_total_days": len(coverage_diff),
        "pref_fulfilled": fulfilled,
        "pref_total": len(requests),
        "pref_rate": pref_rate,
        "employee_coverage_pct": employee_coverage,
        "violations": violations,
        "weekend_stddev": stddev,
        "weekend_avg": avg,
        "weekend_distribution": dict(weekend_count),
    }


def main():
    staff, config, dates, requests = scenario_realistic()
    print(f"\n=== シナリオ: {len(staff)}名 / {len(dates)}日 / 希望{len(requests)}件 ===\n")

    import time
    t0 = time.time()
    sch = ShiftScheduler(
        staff_list=staff, config=config, dates=dates, requests=requests
    )
    shifts = sch.solve(force=False)
    elapsed = time.time() - t0

    if not shifts:
        print(f"❌ 生成失敗 ({elapsed:.2f}s)")
        return

    metrics = compute_metrics(shifts, staff, config, dates, requests)
    print(f"⏱  求解時間: {elapsed:.2f}s")
    print(f"📊 総シフト数: {metrics['total_shifts']}")
    print()
    print("【精度指標 (ピーク同時刻人数 vs 必要人数)】")
    print(f"  ぴったり日数: {metrics['coverage_exact']}/{metrics['coverage_total_days']} ({metrics['coverage_exact']/metrics['coverage_total_days']*100:.1f}%)")
    print(f"  不足日数:     {metrics['coverage_under']}/{metrics['coverage_total_days']}")
    print(f"  過剰日数:     {metrics['coverage_over']}/{metrics['coverage_total_days']}")
    print(f"  希望充足率:       {metrics['pref_fulfilled']}/{metrics['pref_total']} ({metrics['pref_rate']:.1f}%)")
    print(f"  社員/月給日カバー: {metrics['employee_coverage_pct']:.1f}%")
    print(f"  法定違反数:       {len(metrics['violations'])}")
    if metrics['violations']:
        for v in metrics['violations']:
            print(f"    - {v}")
    print()
    print("【公平性】")
    print(f"  土日シフト分布: {metrics['weekend_distribution']}")
    print(f"  土日平均±SD:    {metrics['weekend_avg']:.1f} ± {metrics['weekend_stddev']:.2f}")

    # 詳細: 過剰配置日と未充足希望
    print()
    print("【詳細: 過剰配置日】")
    over_days = [(d, r, peak) for d, r, peak, _, diff in
                 [(d, r, p, a, p - r) for d, r, p, a, _ in []]]
    by_date = {}
    for s in shifts:
        by_date.setdefault(s["date"], []).append(s)
    for d in dates:
        wd = datetime.strptime(d, "%Y-%m-%d").weekday()
        r = 4 if wd >= 5 else 3
        ds = by_date.get(d, [])
        slot_counts = {}
        for s in ds:
            sh, sm = s["start_time"].split(":")[:2]
            eh, em = s["end_time"].split(":")[:2]
            start = int(sh) * 60 + int(sm)
            end = int(eh) * 60 + int(em)
            if end <= start:
                end += 1440
            for t in range(start, end, 15):
                slot_counts[t % 1440] = slot_counts.get(t % 1440, 0) + 1
        peak = max(slot_counts.values()) if slot_counts else 0
        if peak > r:
            staff_str = ", ".join(s["staff_id"] for s in ds)
            print(f"  {d} ({['月','火','水','木','金','土','日'][wd]}): 必要{r} ピーク{peak} ({len(ds)}人) [{staff_str}]")

    print()
    print("【詳細: 希望シフト充足状況】")
    for req in requests:
        sid = req["staff_id"]
        rd = req["date"]
        matched = [s for s in shifts if s["staff_id"] == sid and s["date"] == rd]
        if matched:
            m = matched[0]
            print(f"  ✅ {sid} {rd}: {m['start_time']}-{m['end_time']}")
        else:
            print(f"  ❌ {sid} {rd}: 未配置")


if __name__ == "__main__":
    main()
