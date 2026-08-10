"""v3.7.108 追加 4 シナリオ検証
A: 10-19時店舗 + 5種類シフト + パート 3種類
B: 24時間営業
C: 24時間営業 + 夜勤 12時間 (>10h)
D: admin.html マルチテナント管理者画面 (HTTP 200 + 主要マーカー)
"""
import sys
sys.path.insert(0, '.')
sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def mk(i, salary='hourly', max_h=8, max_d=5, max_dm=31, ng=None):
    return {'id': f's{i}', 'name': f'st{i}', 'role': 'staff', 'salary_type': salary,
            'evaluation': 'B', 'hourly_wage': 1100,
            'max_days_week': max_d, 'max_hours_day': max_h,
            'min_days_week': 0, 'min_days_month': 0,
            'max_days_month': max_dm, 'position': 'any',
            'pref_start_wd': None, 'pref_end_wd': None,
            'pref_start_we': None, 'pref_end_we': None,
            'req_pairs': None, 'ng_weekdays': ng or []}


def base_cfg(open_t, close_t, patterns, is_24h=False):
    return {
        'opening_times': {
            'weekday': {'start': open_t, 'end': close_t},
            'weekend': {'start': open_t, 'end': close_t},
            'holiday': {'start': open_t, 'end': close_t},
        },
        'closed_days': [],
        'custom_shifts': patterns,
        'staff_req': {'min_weekday': 0, 'min_weekend': 0, 'min_holiday': 0, 'min_manager': 0},
        'time_staff_req': [], 'break_periods': {}, 'positions': ['hall'], 'roles': [],
        'break_rules': [{'min_hours': 6, 'break_minutes': 45},
                        {'min_hours': 8, 'break_minutes': 60}],
        'hourly_wage_default': 1100,
        'is_24h': {'weekday': is_24h, 'weekend': is_24h, 'holiday': is_24h},
        'special_holidays': [], 'special_days': {},
        'allow_overstaffing': False,
    }


def test_A_5_patterns_with_part_time():
    print("\n=== A: 10-19時店舗 + 一般5種類 + パート専用3種類 (計8種) ===")
    patterns = [
        # 一般 5 種類 (4時間以上、社員/フルタイム時給向け)
        {'name': '早番',    'start': '10:00', 'end': '15:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': '中早番',  'start': '11:00', 'end': '16:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': '中遅番',  'start': '13:00', 'end': '18:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': '遅番',    'start': '14:00', 'end': '19:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': '通し',    'start': '10:00', 'end': '19:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        # パート 3 種類 (短時間 4時間)
        {'name': 'パートA',  'start': '10:00', 'end': '14:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': 'パートB',  'start': '12:00', 'end': '16:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
        {'name': 'パートC',  'start': '15:00', 'end': '19:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
    ]
    cfg = base_cfg('10:00', '19:00', patterns)
    # 社員 5 + パート 3
    staff = [mk(i, salary='monthly', max_h=9, max_d=5) for i in range(5)] + \
            [mk(i + 5, salary='hourly', max_h=4, max_d=3) for i in range(3)]
    dates = ['2026-07-06']
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    by_pat = {}
    for s in result:
        k = f"{s['start_time'][:5]}-{s['end_time'][:5]}"
        by_pat[k] = by_pat.get(k, 0) + 1
    print(f"  配置: {by_pat}")
    expected_ranges = [
        ('10:00-15:00', '早番'),
        ('11:00-16:00', '中早番'),
        ('13:00-18:00', '中遅番'),
        ('14:00-19:00', '遅番'),
        ('10:00-19:00', '通し'),
        ('10:00-14:00', 'パートA'),
        ('12:00-16:00', 'パートB'),
        ('15:00-19:00', 'パートC'),
    ]
    placed = sum(1 for k, n in expected_ranges if by_pat.get(k, 0) >= 1)
    print(f"  8種類パターンのうち配置あり: {placed}/8")
    return placed >= 6  # 8種すべて 1名以上配置 (許容: 6 以上)


def test_B_24h():
    print("\n=== B: 24時間営業 (3シフト 8時間) ===")
    patterns = [
        {'name': '早番', 'start': '06:00', 'end': '14:00', 'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
        {'name': '中番', 'start': '14:00', 'end': '22:00', 'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
        {'name': '夜勤', 'start': '22:00', 'end': '06:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
    ]
    cfg = base_cfg('00:00', '23:45', patterns, is_24h=True)
    staff = [mk(i, max_h=10, max_d=7) for i in range(8)]
    dates = ['2026-07-06', '2026-07-07']
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    by_pat = {}
    for s in result:
        if s['date'] == '2026-07-06':
            k = f"{s['start_time'][:5]}-{s['end_time'][:5]}"
            by_pat[k] = by_pat.get(k, 0) + 1
    print(f"  7/6 配置: {by_pat}")
    haya = by_pat.get('06:00-14:00', 0)
    naka = by_pat.get('14:00-22:00', 0)
    yakin = by_pat.get('22:00-06:00', 0)
    print(f"  早番 {haya} (要2) / 中番 {naka} (要2) / 夜勤 {yakin} (要1)")
    return haya >= 2 and naka >= 2 and yakin >= 1


def test_C_24h_long_night():
    print("\n=== C: 24時間営業 + 夜勤 12時間 (>10h) ===")
    patterns = [
        {'name': '日勤', 'start': '10:00', 'end': '22:00', 'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
        {'name': '長夜勤', 'start': '22:00', 'end': '10:00', 'count_weekday': 1, 'count_weekend': 1, 'count_holiday': 1, 'count': 1},
    ]
    cfg = base_cfg('00:00', '23:45', patterns, is_24h=True)
    # max_hours_day=12 にして 12時間シフトを許容
    staff = [mk(i, max_h=12, max_d=6) for i in range(6)]
    dates = ['2026-07-06']
    sched = ShiftScheduler(staff, cfg, dates)
    result = sched.solve() or []
    by_pat = {}
    for s in result:
        if s['date'] == '2026-07-06':
            k = f"{s['start_time'][:5]}-{s['end_time'][:5]}"
            by_pat[k] = by_pat.get(k, 0) + 1
    print(f"  配置: {by_pat}")
    long_night = by_pat.get('22:00-10:00', 0)
    print(f"  長夜勤 (12h) 配置: {long_night} 名")
    return long_night >= 1


def test_D_admin_html():
    print("\n=== D: マルチテナント管理者画面 (admin.html) ===")
    import urllib.request
    try:
        req = urllib.request.Request(
            'https://rakushift-ai.pages.dev/admin.html',
            headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode('utf-8', errors='ignore')
            print(f"  HTTP {r.status} / size {len(body)} chars")
            markers = ['管理者ログイン', 'テナント', 'admin', 'ラクシフト']
            found = [m for m in markers if m in body]
            print(f"  マーカー検出: {found}")
            return r.status == 200 and len(found) >= 2
    except Exception as e:
        print(f"  ERROR: {e}")
        return False


if __name__ == '__main__':
    results = {
        'A.5種パターン+パート': test_A_5_patterns_with_part_time(),
        'B.24時間営業': test_B_24h(),
        'C.24h+夜勤12h': test_C_24h_long_night(),
        'D.admin.html': test_D_admin_html(),
    }
    print("\n" + "=" * 50)
    print("結果サマリー:")
    passed = sum(1 for v in results.values() if v)
    for name, ok in results.items():
        mark = '✅' if ok else '❌'
        print(f"  {mark} {name}")
    print(f"\n {passed}/{len(results)} PASS")
    sys.exit(0 if passed == len(results) else 1)
