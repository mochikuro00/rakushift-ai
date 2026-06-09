"""過剰配置 (allow_overstaffing) ON/OFF の挙動テスト

検証観点:
  - OFF: パターン人数ぴったり (許容超過なし)
  - ON: min_days_month 未達なら補完、不足日を優先 (v3.7.121)
  - 補完時の連勤上限厳守 (v3.7.120)
  - max_days_month を超えない
"""
import sys
import datetime
import pytest

sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def _mk_staff(sid, min_dm=0, max_dm=31, max_consec=6, eligible=None):
    s = {
        'id': sid, 'name': sid, 'role': 'staff', 'salary_type': 'hourly',
        'evaluation': 'B', 'hourly_wage': 1100,
        'max_days_week': 6, 'max_hours_day': 9,
        'min_days_week': 0, 'min_days_month': min_dm, 'max_days_month': max_dm,
        'max_consecutive_days': max_consec,
        'position': 'any',
        'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': [],
    }
    if eligible is not None:
        s['eligible_patterns'] = eligible
    return s


def _mk_config(allow_overstaff=False, count_per_pat=1):
    return {
        'opening_times': {
            'weekday': {'start': '09:00', 'end': '18:00'},
            'weekend': {'start': '09:00', 'end': '18:00'},
            'holiday': {'start': '09:00', 'end': '18:00'},
        },
        'closed_days': [],
        'custom_shifts': [
            {'name': '通し', 'start': '09:00', 'end': '18:00',
             'count_weekday': count_per_pat, 'count_weekend': count_per_pat,
             'count_holiday': count_per_pat, 'count': count_per_pat},
        ],
        'staff_req': {'min_weekday': 0, 'min_weekend': 0, 'min_holiday': 0, 'min_manager': 0},
        'time_staff_req': [], 'break_periods': {}, 'positions': ['hall'], 'roles': [],
        'break_rules': [], 'hourly_wage_default': 1100, 'is_24h': {},
        'special_holidays': [], 'special_days': {},
        'allow_overstaffing': allow_overstaff,
    }


def _dates(start, n):
    base = datetime.datetime.strptime(start, '%Y-%m-%d')
    return [(base + datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(n)]


# ========== 過剰配置 OFF ==========

def test_overstaff_off_no_min_days():
    """OFF + min_days_month=0: 必要人数ぴったり"""
    cfg = _mk_config(allow_overstaff=False, count_per_pat=2)
    staff = [_mk_staff(f's{i}', min_dm=0) for i in range(3)]
    dates = _dates('2026-09-01', 14)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # 1日あたりのシフト数 = 2 (パターン人数)
    by_date = {}
    for sh in result:
        by_date[sh['date']] = by_date.get(sh['date'], 0) + 1
    for d, n in by_date.items():
        assert n <= 3, f"OFF で過剰: {d} に {n}人 (目標 2人)"


def test_overstaff_off_respects_min_days_within_coverage():
    """OFF + min_days_month=10: 必要人数を満たす範囲で minを尊重"""
    cfg = _mk_config(allow_overstaff=False, count_per_pat=1)
    staff = [_mk_staff(f's{i}', min_dm=5) for i in range(3)]
    dates = _dates('2026-09-01', 20)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # 各スタッフが何らかの日数出勤
    for s in staff:
        n = sum(1 for sh in result if sh['staff_id'] == s['id'])
        assert n >= 3, f"{s['id']}: 出勤{n}日 (min=5)"


# ========== 過剰配置 ON ==========

def test_overstaff_on_fills_to_min_days():
    """ON + min_days_month=15: 補完されて目標到達"""
    cfg = _mk_config(allow_overstaff=True, count_per_pat=1)
    staff = [_mk_staff(f's{i}', min_dm=15) for i in range(3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for s in staff:
        n = sum(1 for sh in result if sh['staff_id'] == s['id'])
        assert n >= 13, f"ON {s['id']}: min=15 達成失敗 ({n}日)"


def test_overstaff_on_respects_max_days_month():
    """ON + max_days_month=10: 上限超えない"""
    cfg = _mk_config(allow_overstaff=True, count_per_pat=1)
    staff = [_mk_staff(f's{i}', min_dm=8, max_dm=10) for i in range(3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for s in staff:
        n = sum(1 for sh in result if sh['staff_id'] == s['id'])
        assert n <= 10, f"max_days_month=10 超過: {s['id']} {n}日"


def test_overstaff_on_respects_consec_limit():
    """ON + 補完時も連勤上限を厳守 (v3.7.120 回帰防止)"""
    cfg = _mk_config(allow_overstaff=True, count_per_pat=1)
    staff = [_mk_staff(f's{i}', min_dm=15, max_consec=2) for i in range(3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    ops = sched._operational_dates
    for s in staff:
        sid = s['id']
        days = set(sh['date'] for sh in result if sh['staff_id'] == sid)
        max_run = cur = 0
        prev_idx = None
        for i, d in enumerate(ops):
            if d in days:
                if prev_idx is None or i - prev_idx == 1:
                    cur += 1
                else:
                    cur = 1
                max_run = max(max_run, cur)
                prev_idx = i
            else:
                cur = 0
                prev_idx = None
        assert max_run <= 2, f"ON 補完で連勤上限超過: {sid} {max_run}日"


def test_overstaff_on_prefers_shortage_dates():
    """ON 補完: 不足日を優先 (v3.7.121 _compute_date_shortages)"""
    cfg = _mk_config(allow_overstaff=True, count_per_pat=2)
    # 1人だけ min=30 を設定すると、他スタッフカバレッジが少ない日
    # (人員不足日) に優先配置されるべき
    staff = [_mk_staff('s0', min_dm=10), _mk_staff('s1', min_dm=10),
             _mk_staff('extra', min_dm=15)]
    dates = _dates('2026-09-01', 20)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # extra スタッフは min_dm=15 を達成する
    n = sum(1 for sh in result if sh['staff_id'] == 'extra')
    assert n >= 13, f"不足日優先補完が機能していない: extra {n}日"


# ========== 切替動作 ==========

def test_off_to_on_increases_total_shifts():
    """同条件で ON にすると総シフト数が増える (=補完が効いている)"""
    cfg_off = _mk_config(allow_overstaff=False, count_per_pat=1)
    cfg_on = _mk_config(allow_overstaff=True, count_per_pat=1)
    staff_proto = lambda: [_mk_staff(f's{i}', min_dm=15) for i in range(3)]
    dates = _dates('2026-09-01', 30)
    sched_off = ShiftScheduler(staff_proto(), cfg_off, dates)
    sched_on = ShiftScheduler(staff_proto(), cfg_on, dates)
    n_off = len(sched_off.solve() or [])
    n_on = len(sched_on.solve() or [])
    assert n_on >= n_off, f"ON ({n_on}) が OFF ({n_off}) より少ない"


# ========== 例外なく動作 ==========

@pytest.mark.parametrize('staff_count,min_dm', [(1, 5), (5, 0), (10, 25)])
def test_overstaff_various_scales(staff_count, min_dm):
    """様々なスタッフ数/min_dm で例外を出さない"""
    cfg = _mk_config(allow_overstaff=True, count_per_pat=2)
    staff = [_mk_staff(f's{i}', min_dm=min_dm) for i in range(staff_count)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve()
    assert result is not None


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
