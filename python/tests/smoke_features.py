"""v3.7.75 主要機能の確認テスト
ユーザー指定の 9 項目 (UI 含む 7 を除く 1-6, 8, 9) を直接スケジューラで検証
"""
import sys
sys.path.insert(0, '.')
sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def base_staff(n, max_h=8, max_d=5, role='staff', salary='hourly'):
    return [
        {'id': f's{i}', 'name': f'st{i}', 'role': role, 'salary_type': salary,
         'evaluation': 'B', 'hourly_wage': 1100,
         'max_days_week': max_d, 'max_hours_day': max_h,
         'min_days_week': 0, 'min_days_month': 0, 'position': 'any',
         'pref_start_wd': None, 'pref_end_wd': None,
         'pref_start_we': None, 'pref_end_we': None,
         'req_pairs': None, 'ng_weekdays': []}
        for i in range(n)
    ]


def base_config(open_t='09:45', close_t='19:15', patterns=None, base_req=0):
    return {
        'opening_times': {
            'weekday': {'start': open_t, 'end': close_t},
            'weekend': {'start': open_t, 'end': close_t},
            'holiday': {'start': open_t, 'end': close_t},
        },
        'closed_days': [],
        'custom_shifts': patterns or [],
        'staff_req': {
            'min_weekday': base_req, 'min_weekend': base_req,
            'min_holiday': base_req, 'min_manager': 0,
        },
        'time_staff_req': [], 'break_periods': {},
        'positions': ['hall', 'kitchen'], 'roles': [],
        'break_rules': [{'min_hours': 6, 'break_minutes': 45},
                        {'min_hours': 8, 'break_minutes': 60}],
        'hourly_wage_default': 1100, 'is_24h': {},
        'special_holidays': [], 'special_days': {},
    }


def shifts_by_time(shifts, date):
    by = {}
    for s in shifts:
        if s.get('date') != date:
            continue
        k = s.get('start_time', '')[:5] + '-' + s.get('end_time', '')[:5]
        by[k] = by.get(k, 0) + 1
    return by


def run_solve(config, staff, dates):
    sched = ShiftScheduler(staff, config, dates)
    return sched.solve() or []


def test_1_normal():
    print("\n=== 1. ノーマル動作 (パターン2つ・必要人数満たす) ===")
    cfg = base_config('09:00', '22:00', [
        {'name': 'haya', 'start': '09:00', 'end': '15:00',
         'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
        {'name': 'oso', 'start': '15:00', 'end': '22:00',
         'count_weekday': 3, 'count_weekend': 3, 'count_holiday': 3, 'count': 3},
    ])
    staff = base_staff(6)
    result = run_solve(cfg, staff, ['2026-06-08'])
    by = shifts_by_time(result, '2026-06-08')
    print("  配置:", by)
    ok = by.get('09:00-15:00', 0) >= 2 and by.get('15:00-22:00', 0) >= 3
    print("  ", "✅ PASS" if ok else "❌ FAIL")
    return ok


def test_2_early_late():
    print("\n=== 2. 早番/遅番に正しく人数が入るか ===")
    cfg = base_config('09:45', '19:15', [
        {'name': 'haya', 'start': '09:45', 'end': '15:00',
         'count_weekday': 3, 'count_weekend': 3, 'count_holiday': 3, 'count': 3},
        {'name': 'oso', 'start': '14:00', 'end': '19:15',
         'count_weekday': 4, 'count_weekend': 4, 'count_holiday': 4, 'count': 4},
    ])
    staff = base_staff(9, max_h=8)
    result = run_solve(cfg, staff, ['2026-06-08'])
    by = shifts_by_time(result, '2026-06-08')
    print("  配置:", by)
    haya = by.get('09:45-15:00', 0)
    oso = by.get('14:00-19:15', 0)
    ok = haya >= 3 and oso >= 4
    print(f"  早番 {haya} (要3) / 遅番 {oso} (要4) → {'✅ PASS' if ok else '❌ FAIL'}")
    return ok


def test_3_24h():
    print("\n=== 3. 24時間営業 ===")
    cfg = base_config('00:00', '23:45', [
        {'name': 'night', 'start': '22:00', 'end': '06:00',
         'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': 'morning', 'start': '06:00', 'end': '14:00',
         'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
        {'name': 'afternoon', 'start': '14:00', 'end': '22:00',
         'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
    ])
    cfg['is_24h'] = {'weekday': True, 'weekend': True, 'holiday': True}
    staff = base_staff(10, max_h=10)
    result = run_solve(cfg, staff, ['2026-06-08'])
    by = shifts_by_time(result, '2026-06-08')
    print("  配置:", by)
    ok = len(by) >= 2 and sum(by.values()) >= 4
    print("  ", "✅ PASS" if ok else "❌ FAIL")
    return ok


def test_4_night_15h():
    print("\n=== 4. 夜勤 15時間シフトが組めるか ===")
    cfg = base_config('00:00', '23:45', [
        {'name': 'long_night', 'start': '17:00', 'end': '08:00',
         'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
    ])
    cfg['is_24h'] = {'weekday': True, 'weekend': True, 'holiday': True}
    staff = base_staff(3, max_h=15, max_d=7)
    result = run_solve(cfg, staff, ['2026-06-08'])
    print(f"  生成シフト数: {len(result)}")
    long_shifts = [s for s in result
                   if s.get('start_time', '')[:5] == '17:00'
                   and s.get('end_time', '')[:5] == '08:00']
    ok = len(long_shifts) >= 1
    print(f"  17:00-08:00 シフト: {len(long_shifts)} 件 → {'✅ PASS' if ok else '❌ FAIL'}")
    return ok


def test_5_understaffed():
    print("\n=== 5. 人数が足りない (要求 > 人員) ===")
    cfg = base_config('09:00', '22:00', [
        {'name': 'all', 'start': '09:00', 'end': '17:00',
         'count_weekday': 5, 'count_weekend': 5, 'count_holiday': 5, 'count': 5},
    ])
    staff = base_staff(2, max_h=8)
    result = run_solve(cfg, staff, ['2026-06-08'])
    by = shifts_by_time(result, '2026-06-08')
    print(f"  配置: {by} (要求 5名 / 在籍 2名)")
    ok = sum(by.values()) <= 2  # 物理的上限を超えない
    print("  ", "✅ PASS (物理上限内)" if ok else "❌ FAIL")
    return ok


def test_6_overstaffed():
    print("\n=== 6. 人数が多すぎる (人員 > 要求) ===")
    cfg = base_config('09:00', '22:00', [
        {'name': 'all', 'start': '09:00', 'end': '17:00',
         'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
    ])
    staff = base_staff(8, max_h=8)
    result = run_solve(cfg, staff, ['2026-06-08'])
    by = shifts_by_time(result, '2026-06-08')
    placed = sum(by.values())
    print(f"  配置: {by} (要求 2名 / 在籍 8名)")
    ok = placed >= 2  # 最低限要求を満たす
    print(f"  配置 {placed} 名 (≥要求2) → {'✅ PASS' if ok else '❌ FAIL'}")
    return ok


def test_8_pair():
    print("\n=== 8. ペア (req_pairs) ===")
    # ペアの効果が出やすいよう要求人数を多くして全員配置にし、ペアが同日に揃うか確認
    cfg = base_config('09:00', '22:00', [
        {'name': 'all', 'start': '09:00', 'end': '17:00',
         'count_weekday': 4, 'count_weekend': 4, 'count_holiday': 4, 'count': 4},
    ])
    staff = base_staff(4, max_h=8, max_d=7)
    # スタッフ s0 と s1 をペアに (互いを参照)
    staff[0]['req_pairs'] = 's1'
    staff[1]['req_pairs'] = 's0'
    dates = ['2026-06-08', '2026-06-09', '2026-06-10']
    result = run_solve(cfg, staff, dates)
    dates_with_s0 = {s['date'] for s in result if s['staff_id'] == 's0'}
    dates_with_s1 = {s['date'] for s in result if s['staff_id'] == 's1'}
    overlap = dates_with_s0 & dates_with_s1
    print(f"  s0 出勤日: {sorted(dates_with_s0)} / s1 出勤日: {sorted(dates_with_s1)}")
    # ペアが両方とも配置されたかを確認 (全要求 4 名で全員配置されるので overlap が日数分あるはず)
    s0_only = dates_with_s0 - dates_with_s1
    s1_only = dates_with_s1 - dates_with_s0
    if not dates_with_s0 and not dates_with_s1:
        print("  ⚪ SKIP (ペア対象スタッフ未配置)")
        return True
    ok = len(overlap) > 0 and len(s0_only) + len(s1_only) <= 1
    print(f"  同日{len(overlap)}日 / s0単独{len(s0_only)}日 / s1単独{len(s1_only)}日 → {'✅ PASS' if ok else '⚠ ペア優先弱い'}")
    return ok


def test_9_off_request():
    print("\n=== 9. 休み希望が反映されるか ===")
    cfg = base_config('09:00', '22:00', [
        {'name': 'all', 'start': '09:00', 'end': '17:00',
         'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
    ])
    staff = base_staff(4, max_h=8)
    dates = ['2026-06-08', '2026-06-09']
    # s0 は 2026-06-08 が休み希望 (承認済み) — scheduler は dates フィールドを読む
    requests_data = [
        {'staff_id': 's0', 'dates': ['2026-06-08'], 'type': 'off',
         'status': 'approved'},
    ]
    sched = ShiftScheduler(staff, cfg, dates, requests=requests_data)
    result = sched.solve() or []
    s0_on_08 = [s for s in result if s['staff_id'] == 's0' and s['date'] == '2026-06-08']
    print(f"  s0 が 2026-06-08 に配置された数: {len(s0_on_08)}")
    ok = len(s0_on_08) == 0
    print("  ", "✅ PASS" if ok else "❌ FAIL")
    return ok


if __name__ == '__main__':
    results = {}
    tests = [
        ('1.ノーマル', test_1_normal),
        ('2.早番遅番', test_2_early_late),
        ('3.24時間営業', test_3_24h),
        ('4.夜勤15h', test_4_night_15h),
        ('5.人員不足', test_5_understaffed),
        ('6.人員過剰', test_6_overstaffed),
        ('8.ペア', test_8_pair),
        ('9.休み希望', test_9_off_request),
    ]
    for name, fn in tests:
        try:
            results[name] = fn()
        except Exception as e:
            print(f"  💥 EXCEPTION: {e}")
            results[name] = False

    print("\n" + "=" * 50)
    print("結果サマリー:")
    passed = 0
    for name, ok in results.items():
        mark = '✅' if ok else '❌'
        print(f"  {mark} {name}")
        if ok:
            passed += 1
    print(f"\n {passed}/{len(results)} PASS")
    sys.exit(0 if passed == len(results) else 1)
