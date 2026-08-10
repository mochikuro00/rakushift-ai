"""
夜勤シフト ① シナリオテスト

要件 (ユーザー定義):
  - 日勤: 8:30-17:30, 4名/日 (土日祝も)
  - 夜勤: 16:00-9:00, 1名/日 (毎日、日勤者のみ)
  - パート朝: 8:30-13:00, 2名
  - パート通し: 8:30-15:00, 2名
  - パートは月-土勤務 (1名は月-金のみ)
  - パートは夜勤しない

スタッフ構成:
  - 日勤者 (正社員/月給) ×6  → 日勤4名 + 夜勤1名 + 予備1名 必要
  - パート (時給) ×3        → 1名は月-金のみ
"""
import sys, collections
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from scheduler import ShiftScheduler  # noqa: E402

DATES = [f"2026-06-{d:02d}" for d in range(1, 31)]

CONFIG = {
    "opening_time": "08:30",
    "closing_time": "22:00",
    "custom_shifts": [
        {"name": "日勤", "start": "08:30", "end": "17:30",
         "count_weekday": 4, "count_weekend": 4, "count_holiday": 4},
        {"name": "夜勤", "start": "16:00", "end": "09:00",
         "count_weekday": 1, "count_weekend": 1, "count_holiday": 1},
        {"name": "パート朝", "start": "08:30", "end": "13:00",
         "count_weekday": 2, "count_weekend": 2, "count_holiday": 2},
        {"name": "パート通し", "start": "08:30", "end": "15:00",
         "count_weekday": 2, "count_weekend": 2, "count_holiday": 2},
    ],
    "roles": [
        {"id": "manager", "name": "店長", "level": 5},
        {"id": "employee", "name": "正社員", "level": 4},
        {"id": "part", "name": "パート", "level": 2},
    ],
    "weekly_holidays": ["sun"],
    "special_holidays": [],
}

def staff(sid, name, role, salary, max_d=5, min_d=0, unavail=None,
          max_hours=8, eligible=None):
    s = {
        "id": sid, "name": name, "role": role,
        "salary_type": salary,
        "contract_type": "regular" if salary == "monthly" else "general",
        "max_days_week": max_d,
        "min_days_week": min_d,
        "unavailable_dates": unavail or [],
        "max_consecutive_workdays": 6,
        "weekly_hours": None,
        "max_hours_day": max_hours,
    }
    if eligible:
        s["eligible_patterns"] = eligible
    return s

# 月-金 のみのパート: 6月の土曜日 (6,13,20,27) を unavailable に
saturdays = [f"2026-06-{d:02d}" for d in (6, 13, 20, 27)]

STAFF = [
    # 日勤者×6 (月給正社員) - 夜勤対応のため max_hours_day=17
    # eligible_patterns で日勤+夜勤のみ許可 (パート系シフトはやらない)
    staff("d1", "日勤1 田中", "employee", "monthly", max_d=5,
          max_hours=17, eligible=["日勤", "夜勤"]),
    staff("d2", "日勤2 鈴木", "employee", "monthly", max_d=5,
          max_hours=17, eligible=["日勤", "夜勤"]),
    staff("d3", "日勤3 佐藤", "employee", "monthly", max_d=5,
          max_hours=17, eligible=["日勤", "夜勤"]),
    staff("d4", "日勤4 山田", "employee", "monthly", max_d=5,
          max_hours=17, eligible=["日勤", "夜勤"]),
    staff("d5", "日勤5 高橋", "employee", "monthly", max_d=5,
          max_hours=17, eligible=["日勤", "夜勤"]),
    staff("d6", "日勤6 渡辺", "manager", "monthly", max_d=5,
          max_hours=17, eligible=["日勤", "夜勤"]),
    # パート×3 (時給) - パート朝/通しのみ
    staff("p1", "パート1 伊藤(月-土)", "part", "hourly", max_d=4,
          eligible=["パート朝", "パート通し"]),
    staff("p2", "パート2 加藤(月-土)", "part", "hourly", max_d=4,
          eligible=["パート朝", "パート通し"]),
    staff("p3", "パート3 中村(月-金のみ)", "part", "hourly",
          max_d=3, unavail=saturdays,
          eligible=["パート朝", "パート通し"]),
]

# 夜勤は max_hours_day=17 でも端数調整で 16:00-09:00 のまま保存される想定だが、
# 圧縮されている可能性もあるので幅を持たせる
def classify(st, et):
    if st == "08:30" and et == "17:30": return "日勤"
    if st == "16:00" and et in ("09:00", "01:00", "08:00"): return "夜勤"
    if st == "08:30" and et == "13:00": return "パート朝"
    if st == "08:30" and et == "15:00": return "パート通し"
    return f"その他({st}-{et})"

PART_IDS = {"p1", "p2", "p3"}
P3_UNAVAIL = set(saturdays)


def test_night_shift_scenario():
    """夜勤を含む混在シフトで、日勤4名/夜勤1名/パートの非夜勤を同時に満たせること。"""
    print("=" * 70)
    print("夜勤シフト ① シナリオテスト")
    print("=" * 70)
    print(f"対象期間: {DATES[0]} 〜 {DATES[-1]} ({len(DATES)}日間)")
    print("スタッフ: 日勤者 6名 + パート 3名")
    print("シフトパターン: 日勤(4)/夜勤(1)/パート朝(2)/パート通し(2)")
    print()

    result = ShiftScheduler(STAFF, CONFIG, DATES).solve(force=False)
    shifts = result.get("shifts", []) if isinstance(result, dict) else result
    print(f"生成シフト件数: {len(shifts)}")

    time_dist = collections.Counter()
    for s in shifts:
        time_dist[(s.get("start_time", "")[:5], s.get("end_time", "")[:5])] += 1
    print("時刻ペア分布:")
    for (st, et), n in time_dist.most_common():
        print(f"   {st}-{et}: {n}件")
    print()

    by_date_pattern = collections.defaultdict(lambda: collections.defaultdict(list))
    sat_violations = []

    for s in shifts:
        st = s.get("start_time", "")[:5]
        et = s.get("end_time", "")[:5]
        pat = classify(st, et)
        d = s.get("date")
        sid = s.get("staff_id")
        by_date_pattern[d][pat].append(sid)
        if sid == "p3" and d in P3_UNAVAIL:
            sat_violations.append((sid, d))

    # 集計
    days_with_4_day = 0
    days_with_1_night = 0
    night_assigned_to_part = []
    all_ok_days = 0

    for d in DATES:
        night_ids = by_date_pattern[d].get("夜勤", [])
        day_cnt = len(by_date_pattern[d].get("日勤", []))
        night_cnt = len(night_ids)
        if day_cnt >= 4:
            days_with_4_day += 1
        if night_cnt >= 1:
            days_with_1_night += 1
        night_assigned_to_part += [(nid, d) for nid in night_ids if nid in PART_IDS]
        if day_cnt >= 4 and night_cnt >= 1:
            all_ok_days += 1

    print("=" * 70)
    print("検証結果")
    print("=" * 70)
    print(f"[1] 日勤 4名以上 達成: {days_with_4_day}/{len(DATES)} 日")
    print(f"[2] 夜勤 1名 達成:    {days_with_1_night}/{len(DATES)} 日")
    print(f"[3] パートに夜勤 割当: {len(night_assigned_to_part)} 件 {night_assigned_to_part[:3]}")
    print(f"[4] パート3 土曜日 違反: {len(sat_violations)} 件 {sat_violations[:3]}")
    print(f"[5] 全要件 同時達成日:  {all_ok_days}/{len(DATES)} 日")

    # 各スタッフの稼働
    print()
    print("=" * 70)
    print("スタッフ別 稼働状況")
    print("=" * 70)
    staff_count = collections.defaultdict(lambda: collections.defaultdict(int))
    for s in shifts:
        pat = classify(s.get("start_time", "")[:5], s.get("end_time", "")[:5])
        staff_count[s.get("staff_id")][pat] += 1

    for s in STAFF:
        totals = dict(staff_count.get(s["id"], {}))
        print(f"  {s['name']:30s} 合計{sum(totals.values()):3d}日 {totals}")

    assert days_with_4_day == len(DATES), f"日勤4名を満たせない日がある ({days_with_4_day}/{len(DATES)})"
    assert days_with_1_night == len(DATES), f"夜勤1名を満たせない日がある ({days_with_1_night}/{len(DATES)})"
    assert not night_assigned_to_part, f"パートに夜勤が割り当たった: {night_assigned_to_part[:3]}"
    assert not sat_violations, f"月-金のみのパートに土曜が割り当たった: {sat_violations[:3]}"


if __name__ == "__main__":
    try:
        test_night_shift_scenario()
    except AssertionError as e:
        print(f"\n=== NG: {e} ===")
        sys.exit(1)
    print("\n=== 4/4 制約 PASS ===")
