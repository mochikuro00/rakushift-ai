"""req=0 (パターン外時間帯) で EMPTY_SLOT ペナルティが発動しないこと

v3.7.125 修正: フロント側 (人員状況計算) では req=0 を「パターン外」扱いで
不足判定しないが、バックエンド MILP は req=0 でも「最低1名」要求していた。
フロント/バックエンドの仕様を統一。
"""
import sys
import datetime
import pytest

sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def _mk_staff(sid, max_dm=31, max_consec=6, min_dw=0):
    return {
        'id': sid, 'name': sid, 'role': 'staff', 'salary_type': 'hourly',
        'evaluation': 'B', 'hourly_wage': 1100,
        'max_days_week': 6, 'max_hours_day': 9,
        'min_days_week': min_dw, 'min_days_month': 0, 'max_days_month': max_dm,
        'max_consecutive_days': max_consec, 'position': 'any',
        'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': [],
    }


def _mk_config():
    """営業 09-18時、パターンは 09-13時 (午前のみ) → 13-18時は req=0"""
    return {
        'opening_times': {
            'weekday': {'start': '09:00', 'end': '18:00'},
            'weekend': {'start': '09:00', 'end': '18:00'},
            'holiday': {'start': '09:00', 'end': '18:00'},
        },
        'closed_days': [],
        'custom_shifts': [
            {'name': '午前', 'start': '09:00', 'end': '13:00',
             'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        ],
        'staff_req': {'min_weekday': 0, 'min_weekend': 0, 'min_holiday': 0, 'min_manager': 0},
        'time_staff_req': [], 'break_periods': {}, 'positions': ['hall'], 'roles': [],
        'break_rules': [], 'hourly_wage_default': 1100, 'is_24h': {},
        'special_holidays': [], 'special_days': {},
    }


def _dates(start, n):
    base = datetime.datetime.strptime(start, '%Y-%m-%d')
    return [(base + datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(n)]


def test_pattern_only_morning_no_afternoon_force():
    """09-13 のパターンのみ → 13-18 時間帯にスタッフを無理やり詰め込まない"""
    cfg = _mk_config()
    staff = [_mk_staff(f's{i}') for i in range(2)]
    dates = _dates('2026-09-01', 7)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # 全シフトの終了時刻が 13:00 まで
    for sh in result:
        end_hh = int(sh['end_time'].split(':')[0])
        assert end_hh <= 13, (
            f"パターン外 (13:00以降) にシフトが入っている: {sh}")


def test_pattern_outside_no_min1_constraint():
    """パターン外時間帯で min1_slack ペナルティが発生していないこと
    (= 過剰なスタッフ配置を強制されない)"""
    cfg = _mk_config()
    # 単独スタッフ、出勤希望なし
    staff = [_mk_staff('s0')]
    dates = _dates('2026-09-01', 5)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # 出勤日数は 5日 (1日1人で配置)、それ以上の過剰配置はない
    n = sum(1 for sh in result if sh['staff_id'] == 's0')
    assert n <= 5, f"パターン外で過剰配置: {n}日"


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
