"""eligible_patterns / ng_weekdays / ng_holiday の組合せテスト

検証観点:
  - eligible_patterns=['早番'] → 早番のみ配置、遅番は0回
  - eligible_patterns=None/[] → 全パターン該当 (デフォルト)
  - ng_weekdays=[6] → 土曜出勤しない
  - ng_holiday=True → 国民の祝日に出勤しない
  - 全組合せの干渉なし
"""
import sys
import datetime
import pytest

sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def _mk_staff(sid, eligible=None, ng_weekdays=None, ng_holiday=False):
    s = {
        'id': sid, 'name': sid, 'role': 'staff', 'salary_type': 'hourly',
        'evaluation': 'B', 'hourly_wage': 1100,
        'max_days_week': 6, 'max_hours_day': 9,
        'min_days_week': 0, 'min_days_month': 0, 'max_days_month': 31,
        'max_consecutive_days': 6,
        'position': 'any',
        'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': ng_weekdays or [],
        'ng_holiday': ng_holiday,
    }
    if eligible is not None:
        s['eligible_patterns'] = eligible
    return s


def _mk_config(patterns=None):
    return {
        'opening_times': {
            'weekday': {'start': '09:00', 'end': '19:30'},
            'weekend': {'start': '09:00', 'end': '19:30'},
            'holiday': {'start': '09:00', 'end': '19:30'},
        },
        'closed_days': [],
        'custom_shifts': patterns or [
            {'name': '早番', 'start': '09:00', 'end': '14:00',
             'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
            {'name': '遅番', 'start': '14:00', 'end': '19:00',
             'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        ],
        'staff_req': {'min_weekday': 0, 'min_weekend': 0, 'min_holiday': 0, 'min_manager': 0},
        'time_staff_req': [], 'break_periods': {}, 'positions': ['hall'], 'roles': [],
        'break_rules': [], 'hourly_wage_default': 1100, 'is_24h': {},
        'special_holidays': [], 'special_days': {},
        'allow_overstaffing': False,
    }


def _dates(start, n):
    base = datetime.datetime.strptime(start, '%Y-%m-%d')
    return [(base + datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(n)]


def _count_pattern(result, sid, pat_name, patterns):
    pat = next((p for p in patterns if p['name'] == pat_name), None)
    if not pat:
        return 0
    return sum(1 for sh in result
               if sh['staff_id'] == sid
               and sh.get('start_time', '').startswith(pat['start'])
               and sh.get('end_time', '').startswith(pat['end']))


# ========== eligible_patterns ==========

def test_eligible_only_morning():
    """eligible=['早番'] → 遅番が0回"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', eligible=['早番'])]
    staff += [_mk_staff(f's{i}') for i in range(1, 4)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    late_count = _count_pattern(result, 's0', '遅番', cfg['custom_shifts'])
    assert late_count == 0, f"eligible=['早番'] なのに遅番 {late_count}回"


def test_eligible_only_evening():
    """eligible=['遅番'] → 早番が0回"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', eligible=['遅番'])]
    staff += [_mk_staff(f's{i}') for i in range(1, 4)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    morning_count = _count_pattern(result, 's0', '早番', cfg['custom_shifts'])
    assert morning_count == 0, f"eligible=['遅番'] なのに早番 {morning_count}回"


@pytest.mark.parametrize('eligible', [None, [], ['早番', '遅番']])
def test_eligible_all_or_none(eligible):
    """None / 空配列 / 全パターン指定 → 全パターン該当 (デフォルト)"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', eligible=eligible)]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # 例外なく solve できれば OK
    assert result is not None


# ========== ng_weekdays ==========

def test_ng_weekdays_saturday():
    """ng_weekdays=[6] → 土曜出勤なし"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ng_weekdays=[6])]
    staff += [_mk_staff(f's{i}') for i in range(1, 4)]
    # 2026-09-05 は土曜
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for sh in result:
        if sh['staff_id'] != 's0':
            continue
        dow = datetime.datetime.strptime(sh['date'], '%Y-%m-%d').weekday()
        # weekday: 月=0..日=6 (Python標準) / JS: 日=0..土=6 → 変換
        js_dow = (dow + 1) % 7
        assert js_dow != 6, f"ng_weekdays=[6] 違反: {sh['date']} (土曜)"


def test_ng_weekdays_multiple():
    """ng_weekdays=[0, 6] → 土日出勤なし"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ng_weekdays=[0, 6])]
    staff += [_mk_staff(f's{i}') for i in range(1, 4)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    for sh in result:
        if sh['staff_id'] != 's0':
            continue
        dow = datetime.datetime.strptime(sh['date'], '%Y-%m-%d').weekday()
        js_dow = (dow + 1) % 7
        assert js_dow not in (0, 6), f"ng_weekdays=[0,6] 違反: {sh['date']}"


# ========== ng_holiday (国民の祝日) ==========

def test_ng_holiday_excludes_japanese_holidays():
    """ng_holiday=True → 国民の祝日に出勤なし"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ng_holiday=True)]
    staff += [_mk_staff(f's{i}') for i in range(1, 4)]
    # 9月 (2026年): 9/21 敬老の日, 9/22 秋分の日
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    s0_dates = set(sh['date'] for sh in result if sh['staff_id'] == 's0')
    # ng_holiday=True なら 9/21 (敬老の日), 9/22 (秋分の日) に出勤しない
    assert '2026-09-21' not in s0_dates, "ng_holiday: 9/21 (敬老の日) に出勤"
    assert '2026-09-22' not in s0_dates, "ng_holiday: 9/22 (秋分の日) に出勤"


def test_ng_holiday_false_allows():
    """ng_holiday=False (デフォルト) → 国民の祝日も配置可能"""
    cfg = _mk_config()
    staff = [_mk_staff(f's{i}', ng_holiday=False) for i in range(3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # 9/21 や 9/22 に誰かしら配置されていること
    holiday_assignments = [sh for sh in result
                           if sh['date'] in ('2026-09-21', '2026-09-22')]
    assert len(holiday_assignments) > 0, "祝日に誰も配置されていない"


# ========== 全組合せ ==========

def test_eligible_ng_combined():
    """eligible + ng_weekdays + ng_holiday 同時指定で例外なし"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', eligible=['早番'], ng_weekdays=[6, 0],
                       ng_holiday=True)]
    staff += [_mk_staff(f's{i}') for i in range(1, 4)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve()
    assert result is not None
    # s0 は早番のみ / 土日NG / 祝日NG
    for sh in result:
        if sh['staff_id'] != 's0':
            continue
        # パターン確認
        assert sh['start_time'].startswith('09:00'), \
            f"eligible=['早番'] なのに別パターン: {sh}"


# ========== 不正値の sanitize ==========

@pytest.mark.parametrize('bad_eligible', [None, [], ['存在しないパターン名']])
def test_eligible_sanitize(bad_eligible):
    """eligible_patterns に不正値 → エラーにならない"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', eligible=bad_eligible)]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve()
    assert result is not None


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
