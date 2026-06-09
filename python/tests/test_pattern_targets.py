"""pattern_target_counts の min/max 解釈テスト (v3.7.122 以降の回帰防止)

過去バグ:
  v3.7.122 → max=0 が「月0回まで」制約として効いてしまい、スタッフGが
             21日設定なのに19日しか出勤しなかった

検証観点:
  - min=0 / max=0 → 制約なし (空欄と同じ扱い)
  - 旧データ互換 (整数 = min=max)
  - min/max 範囲指定の効果
  - 範囲外の sanitize
"""
import sys
import datetime
import pytest

sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def _mk_staff(sid, ptc=None, min_dm=20, max_dm=22, eligible=None):
    s = {
        'id': sid, 'name': sid, 'role': 'staff', 'salary_type': 'hourly',
        'evaluation': 'B', 'hourly_wage': 1100,
        'max_days_week': 6, 'max_hours_day': 9,
        'min_days_week': 0, 'min_days_month': min_dm, 'max_days_month': max_dm,
        'max_consecutive_days': 6,
        'position': 'any',
        'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': [],
    }
    if ptc is not None:
        s['pattern_target_counts'] = ptc
    if eligible is not None:
        s['eligible_patterns'] = eligible
    return s


def _mk_config(patterns=None, allow_overstaff=True):
    return {
        'opening_times': {
            'weekday': {'start': '09:00', 'end': '19:30'},
            'weekend': {'start': '09:00', 'end': '19:30'},
            'holiday': {'start': '09:00', 'end': '19:30'},
        },
        'closed_days': [],
        'custom_shifts': patterns or [
            {'name': '早番', 'start': '09:30', 'end': '18:45',
             'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
            {'name': '遅番', 'start': '09:45', 'end': '19:15',
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


def _count_pattern(result, sid, pat_name, patterns):
    """シフトをパターン名でカウント"""
    pat = next((p for p in patterns if p['name'] == pat_name), None)
    if not pat:
        return 0
    return sum(1 for sh in result
               if sh['staff_id'] == sid
               and sh.get('start_time', '').startswith(pat['start'])
               and sh.get('end_time', '').startswith(pat['end']))


# ========== max=0 は制約なし (v3.7.122 バグの直接回帰防止) ==========

def test_max_0_is_no_constraint():
    """pattern_target_counts max=0 は「制約なし」として扱う (空欄と同じ)

    v3.7.122 のバグ: max=0 が「月0回まで」と解釈され、min_days_month=21
    を達成できず 19日になった。
    """
    cfg = _mk_config()
    # スタッフG と同じ設定: 全パターン min=0/max=0
    G = _mk_staff('G', ptc={
        '早番': {'min': 0, 'max': 0},
        '遅番': {'min': 0, 'max': 0},
    }, min_dm=21, max_dm=21)
    # コカレッジ確保のため他に2人 (制約なし)
    others = [_mk_staff(f's{i}', min_dm=0, max_dm=31) for i in range(2)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler([G] + others, cfg, dates)
    result = sched.solve() or []
    g_days = sum(1 for sh in result if sh['staff_id'] == 'G')
    assert g_days >= 21, (
        f"max=0 で「月0回」制約が誤発動 → G:{g_days}日 (目標21日)")


def test_min_0_max_0_both_no_constraint():
    """min も max も 0 → 完全に制約なし"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ptc={'早番': {'min': 0, 'max': 0}})]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    # 例外なくsolveできること
    result = sched.solve()
    assert result is not None


# ========== 旧データ互換: 整数 = min=max ==========

def test_legacy_int_format_compat():
    """旧データ形式: 整数 N → min=max=N として扱う"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ptc={'早番': 3}, min_dm=10, max_dm=20)]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    # 早番が概ね 3回 (ソフト制約なので厳密一致は保証されない、±2 程度許容)
    cnt = _count_pattern(result, 's0', '早番', cfg['custom_shifts'])
    assert 1 <= cnt <= 6, f"旧データ整数3が反映されない: 早番{cnt}回"


# ========== min 範囲指定の効果 ==========

def test_min_value_pushes_toward_target():
    """min=5 → 早番を月5回以上に近づける"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ptc={'早番': {'min': 5, 'max': 31}},
                       min_dm=10, max_dm=25)]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    cnt = _count_pattern(result, 's0', '早番', cfg['custom_shifts'])
    assert cnt >= 3, f"min=5 が考慮されていない: 早番{cnt}回"


# ========== max 範囲指定の効果 ==========

def test_max_value_caps_pattern():
    """max=2 → 早番を月2回以下に抑える"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ptc={'早番': {'min': 0, 'max': 2}},
                       min_dm=15, max_dm=25)]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    cnt = _count_pattern(result, 's0', '早番', cfg['custom_shifts'])
    # ソフト制約 (slack付き) なので超過もあり得るが、概ね抑えられているはず
    assert cnt <= 5, f"max=2 が機能していない: 早番{cnt}回"


# ========== 範囲外/不正値の sanitize ==========

@pytest.mark.parametrize('bad_min,bad_max', [
    (-1, 5),       # min < 0
    (5, 100),      # max > 31 → 制約なし
    (None, 5),     # min なし
    (5, None),     # max なし
])
def test_sanitize_invalid_min_max(bad_min, bad_max):
    """min/max に不正値が来ても例外を出さない"""
    cfg = _mk_config()
    ptc = {'早番': {}}
    if bad_min is not None:
        ptc['早番']['min'] = bad_min
    if bad_max is not None:
        ptc['早番']['max'] = bad_max
    staff = [_mk_staff('s0', ptc=ptc)]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    # 例外なく solve できること
    result = sched.solve()
    assert result is not None


# ========== 該当外パターンとの組合せ ==========

def test_ptc_with_eligible_patterns_restriction():
    """eligible_patterns で『パート』を該当外、pattern_target_counts は全部0/0
    → スタッフG と同じ条件で min_days_month を達成する
    """
    cfg = _mk_config(patterns=[
        {'name': '早番', 'start': '09:30', 'end': '18:45',
         'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': '遅番', 'start': '09:45', 'end': '19:15',
         'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': 'パート', 'start': '09:30', 'end': '16:30',
         'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
    ])
    G = _mk_staff('G', ptc={
        '早番': {'min': 0, 'max': 0},
        '遅番': {'min': 0, 'max': 0},
        'パート': {'min': 0, 'max': 0},
    }, eligible=['早番', '遅番'], min_dm=21, max_dm=21)
    others = [_mk_staff(f's{i}') for i in range(2)]
    dates = _dates('2026-09-01', 30)
    sched = ShiftScheduler([G] + others, cfg, dates)
    result = sched.solve() or []
    g_days = sum(1 for sh in result if sh['staff_id'] == 'G')
    assert g_days >= 21, f"G の min_days_month 達成失敗: {g_days}日"


# ========== 空辞書 / None ==========

@pytest.mark.parametrize('ptc', [None, {}])
def test_no_ptc_no_constraint(ptc):
    """pattern_target_counts なし / 空 → 制約なし"""
    cfg = _mk_config()
    staff = [_mk_staff('s0', ptc=ptc)]
    staff += [_mk_staff(f's{i}') for i in range(1, 3)]
    dates = _dates('2026-09-01', 15)
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve()
    assert result is not None


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
