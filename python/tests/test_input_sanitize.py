"""入力 sanitize / データ整合性テスト (v3.7.124)

過去バグ:
  v3.7.124: time_staff_req.days/count に文字列混在で ValueError
  v3.7.124: existing_shifts 重複の静かな上書き
"""
import sys
import datetime
import pytest

sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def _mk_staff(sid, **kwargs):
    base = {
        'id': sid, 'name': sid, 'role': 'staff', 'salary_type': 'hourly',
        'evaluation': 'B', 'hourly_wage': 1100,
        'max_days_week': 6, 'max_hours_day': 9,
        'min_days_week': 0, 'min_days_month': 0, 'max_days_month': 31,
        'max_consecutive_days': 6, 'position': 'any',
        'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': [],
    }
    base.update(kwargs)
    return base


def _mk_config(time_staff_req=None):
    return {
        'opening_times': {
            'weekday': {'start': '09:00', 'end': '18:00'},
            'weekend': {'start': '09:00', 'end': '18:00'},
            'holiday': {'start': '09:00', 'end': '18:00'},
        },
        'closed_days': [],
        'custom_shifts': [
            {'name': '通し', 'start': '09:00', 'end': '18:00',
             'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        ],
        'staff_req': {'min_weekday': 0, 'min_weekend': 0, 'min_holiday': 0, 'min_manager': 0},
        'time_staff_req': time_staff_req or [],
        'break_periods': {}, 'positions': ['hall'], 'roles': [],
        'break_rules': [], 'hourly_wage_default': 1100, 'is_24h': {},
        'special_holidays': [], 'special_days': {},
    }


def _dates(start, n):
    base = datetime.datetime.strptime(start, '%Y-%m-%d')
    return [(base + datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(n)]


# ========== time_staff_req sanitize ==========

@pytest.mark.parametrize('bad_days', [
    ['1', '2', '3'],            # 文字列
    [1, '2', 3],                # 混在
    ['abc', 1],                 # 数値変換不可
    ['1, 2, 3'],                # CSV 文字列 (1 要素として変換不可)
    [None, 1],                  # None 混在
])
def test_time_staff_req_days_string(bad_days):
    """time_staff_req.days に文字列が混ざってもクラッシュしない"""
    cfg = _mk_config(time_staff_req=[
        {'days': bad_days, 'start': '12:00', 'end': '14:00', 'count': 2}
    ])
    staff = [_mk_staff(f's{i}') for i in range(3)]
    dates = _dates('2026-09-01', 10)
    sched = ShiftScheduler(staff, cfg, dates)
    # 例外なく solve できること
    result = sched.solve()
    assert result is not None


@pytest.mark.parametrize('bad_count', ['', 'abc', None])
def test_time_staff_req_count_invalid(bad_count):
    """time_staff_req.count に不正値があってもクラッシュしない"""
    cfg = _mk_config(time_staff_req=[
        {'days': [1, 2, 3, 4, 5], 'start': '12:00', 'end': '14:00',
         'count': bad_count}
    ])
    staff = [_mk_staff(f's{i}') for i in range(3)]
    dates = _dates('2026-09-01', 10)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve()
    assert result is not None


def test_time_staff_req_non_dict_rule():
    """time_staff_req に dict 以外が混ざっても無視"""
    cfg = _mk_config(time_staff_req=[
        None,
        "invalid",
        {'days': [1], 'start': '12:00', 'end': '14:00', 'count': 1},
    ])
    staff = [_mk_staff(f's{i}') for i in range(3)]
    dates = _dates('2026-09-01', 10)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve()
    assert result is not None


# ========== existing_shifts 重複 ==========

def test_existing_shifts_duplicate_skipped(caplog):
    """existing_shifts に重複 (同じ staff_id + date) があれば WARN ログ + 1件目採用"""
    import logging
    caplog.set_level(logging.WARNING)
    cfg = _mk_config()
    staff = [_mk_staff('s0'), _mk_staff('s1')]
    dates = _dates('2026-09-01', 10)
    existing = [
        {'staff_id': 's0', 'date': '2026-09-01',
         'start_time': '09:00', 'end_time': '13:00'},
        {'staff_id': 's0', 'date': '2026-09-01',  # 同じキー (重複)
         'start_time': '14:00', 'end_time': '18:00'},
    ]
    sched = ShiftScheduler(staff, cfg, dates, existing_shifts=existing)
    result = sched.solve() or []
    # 例外なく動作
    assert result is not None
    # WARN ログが出ていること
    warn_msgs = [r.message for r in caplog.records if r.levelno == logging.WARNING]
    assert any('duplicate existing_shift' in m for m in warn_msgs), \
        f"重複警告が出ていない: {warn_msgs}"


def test_existing_shifts_empty_safe():
    """existing_shifts が None/空でクラッシュしない"""
    cfg = _mk_config()
    staff = [_mk_staff('s0')]
    dates = _dates('2026-09-01', 5)
    for ex in [None, [], [{}]]:  # 空 dict も混ぜる
        sched = ShiftScheduler(staff, cfg, dates, existing_shifts=ex)
        result = sched.solve()
        assert result is not None, f"existing_shifts={ex} で失敗"


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
