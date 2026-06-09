"""連続出勤日数の厳密マトリクステスト (v3.7.122 以降の回帰防止)

連勤上限 × closed_days × min_days_month × allow_overstaffing のマトリクスを網羅し、
営業日連続最大が設定値を超えないことを検証する。

過去バグ:
  v3.7.113 → 連勤機能追加
  v3.7.114 → force モードで緩和されるバグ
  v3.7.116 → Greedy 3箇所が固定6日を使うバグ
  v3.7.119 → 週またぎリセット (営業日ベース判定)
  v3.7.120 → 過剰配置ON時のランダム補完が無視
  v3.7.121 → work_requests ループが無視
  v3.7.122 → DnD で破れる (フロント側修正)
"""
import sys
import datetime
import pytest

sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def _mk_staff(sid, max_consec, min_dm=0, max_dm=31, max_dw=7, eligible=None, ptc=None):
    s = {
        'id': sid, 'name': sid, 'role': 'staff', 'salary_type': 'hourly',
        'evaluation': 'B', 'hourly_wage': 1100,
        'max_days_week': max_dw, 'max_hours_day': 9,
        'min_days_week': 0, 'min_days_month': min_dm, 'max_days_month': max_dm,
        'max_consecutive_days': max_consec,
        'position': 'any',
        'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': [],
    }
    if eligible is not None:
        s['eligible_patterns'] = eligible
    if ptc is not None:
        s['pattern_target_counts'] = ptc
    return s


def _mk_config(closed_days=None, allow_overstaff=False, patterns=None):
    return {
        'opening_times': {
            'weekday': {'start': '09:00', 'end': '18:00'},
            'weekend': {'start': '09:00', 'end': '18:00'},
            'holiday': {'start': '09:00', 'end': '18:00'},
        },
        'closed_days': closed_days or [],
        'custom_shifts': patterns or [
            {'name': '通し', 'start': '09:00', 'end': '18:00',
             'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
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


def _max_op_run(result, sid, sched):
    """営業日リスト上での最大連続出勤日数"""
    days = set(sh['date'] for sh in result if sh['staff_id'] == sid)
    ops = sched._operational_dates
    max_run = 0
    cur = 0
    prev_idx = None
    for i, d in enumerate(ops):
        if d in days:
            if prev_idx is None or i - prev_idx == 1:
                cur += 1
            else:
                cur = 1
            max_run = max(max_run, cur)
            prev_idx = i
        # else: 出勤していない営業日 → 連勤途切れ (cur はそのまま、次の出勤で 1 から)
        else:
            cur = 0
            prev_idx = None
    return max_run


# ========== マトリクス: 連勤上限 × closed_days ==========

@pytest.mark.parametrize('limit', [2, 3, 4, 6, 7])
def test_consec_limit_no_closed(limit):
    """closed_days なし: 上限通りに連勤を抑制"""
    cfg = _mk_config()
    cfg['custom_shifts'][0]['count'] = 2
    cfg['custom_shifts'][0]['count_weekday'] = 2
    cfg['custom_shifts'][0]['count_weekend'] = 2
    cfg['custom_shifts'][0]['count_holiday'] = 2
    staff = [_mk_staff(f's{i}', limit) for i in range(3)]
    dates = _dates('2026-09-01', 20)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for s in staff:
        run = _max_op_run(result, s['id'], sched)
        assert run <= limit, f"{s['id']}: 連続{run}日 > 上限{limit}"


@pytest.mark.parametrize('closed', [[0], [0, 6], [1, 4]])
def test_consec_with_closed_days(closed):
    """closed_days あり: 休業日を挟んでも営業日ベースで上限厳守"""
    cfg = _mk_config(closed_days=closed)
    staff = [_mk_staff('s0', 4)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    run = _max_op_run(result, 's0', sched)
    assert run <= 4, f"closed_days={closed} 上限4日 違反: {run}日"


# ========== 過剰配置 ON で min_days_month あり ==========

@pytest.mark.parametrize('limit,min_dm', [(2, 10), (3, 15), (4, 20), (6, 25)])
def test_consec_overstaff_on_min_days(limit, min_dm):
    """過剰配置ON + min_days_month: ランダム補完も連勤上限厳守"""
    cfg = _mk_config(allow_overstaff=True)
    staff = [_mk_staff(f's{i}', limit, min_dm=min_dm) for i in range(3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for s in staff:
        run = _max_op_run(result, s['id'], sched)
        assert run <= limit, (
            f"過剰ON {s['id']}: min_dm={min_dm} 上限{limit}日 違反: {run}日")


# ========== 過剰配置 OFF ==========

@pytest.mark.parametrize('limit', [2, 3, 4])
def test_consec_overstaff_off(limit):
    """過剰配置OFF: ぴったり配置でも連勤上限厳守"""
    cfg = _mk_config(allow_overstaff=False)
    staff = [_mk_staff(f's{i}', limit) for i in range(3)]
    dates = _dates('2026-09-01', 20)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for s in staff:
        run = _max_op_run(result, s['id'], sched)
        assert run <= limit, f"過剰OFF {s['id']}: 上限{limit}日 違反: {run}日"


# ========== work_requests あり ==========

def test_consec_with_work_requests():
    """承認済み出勤希望が連続して並んでも上限厳守 (v3.7.121 Greedy 経路)"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', 3), _mk_staff('s1', 3), _mk_staff('s2', 3)]
    dates = _dates('2026-09-01', 20)
    # work_request を 5日連続で s0 に
    reqs = [{'staff_id': 's0', 'date': d, 'type': 'work', 'status': 'approved'}
            for d in dates[:5]]
    sched = ShiftScheduler(staff, cfg, dates, requests=reqs)
    result = sched.solve() or []
    run = _max_op_run(result, 's0', sched)
    assert run <= 3, f"work_requests で連勤上限破られた: {run}日 > 3日"


# ========== 上限1日 (最厳条件) ==========

def test_consec_limit_1():
    """上限1日: 隔日勤務になるか確認"""
    cfg = _mk_config()
    staff = [_mk_staff(f's{i}', 1) for i in range(3)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for s in staff:
        run = _max_op_run(result, s['id'], sched)
        assert run <= 1, f"上限1日違反: {s['id']} {run}日"


# ========== 月またぎテスト ==========

def test_consec_month_boundary():
    """月末→月初の連続出勤も連勤判定される"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', 4)]
    # 9/28 ~ 10/05 (月またぎ)
    dates = _dates('2026-09-28', 8)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    run = _max_op_run(result, 's0', sched)
    assert run <= 4, f"月またぎ連勤違反: {run}日 > 4日"


# ========== 異常値の sanitize ==========

@pytest.mark.parametrize('bad_value', [0, -1, 8, 100, None, 'abc'])
def test_consec_invalid_value_falls_back_to_6(bad_value):
    """max_consecutive_days に不正値 → デフォルト 6 に fallback"""
    cfg = _mk_config()
    staff = [_mk_staff(f's{i}', bad_value) for i in range(3)]
    dates = _dates('2026-09-01', 20)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for s in staff:
        run = _max_op_run(result, s['id'], sched)
        assert run <= 6, f"不正値 {bad_value}: fallback 6 違反 {run}日"


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
