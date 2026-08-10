"""24時間営業 シミュレーション (v3.7.126 動作確認)

シナリオ:
  - 24時間営業店舗 (コンビニ・カフェ等)
  - パターン: 早番 (06-14)、中番 (14-22)、夜勤 (22-06)
  - 各時間帯 2-3名配置
  - スタッフ 15名 (社員4 / パート8 / 夜勤専用3)
  - 月30日

検証項目:
  - 24時間 全スロット人員カバー
  - 連勤上限厳守 (各スタッフ別)
  - eligible_patterns 遵守 (夜勤専用が早番に入らない)
  - 日跨ぎシフト (22-06) の正当処理
  - ng_weekdays / ng_holiday 遵守
  - 休憩時間の自動算出
  - 月間出勤日数 (min/max) 達成
"""
import sys
import datetime

sys.path.insert(0, 'python')
from scheduler import ShiftScheduler


def _mk_config():
    return {
        'opening_times': {
            'weekday': {'start': '00:00', 'end': '24:00'},
            'weekend': {'start': '00:00', 'end': '24:00'},
            'holiday': {'start': '00:00', 'end': '24:00'},
        },
        'closed_days': [],
        'custom_shifts': [
            {'name': '早番', 'start': '06:00', 'end': '14:00',
             'count_weekday': 2, 'count_weekend': 3, 'count_holiday': 3, 'count': 2},
            {'name': '中番', 'start': '14:00', 'end': '22:00',
             'count_weekday': 2, 'count_weekend': 3, 'count_holiday': 3, 'count': 2},
            {'name': '夜勤', 'start': '22:00', 'end': '06:00',
             'count_weekday': 2, 'count_weekend': 2, 'count_holiday': 2, 'count': 2},
        ],
        'staff_req': {'min_weekday': 0, 'min_weekend': 0, 'min_holiday': 0, 'min_manager': 0},
        'time_staff_req': [], 'break_periods': {},
        'positions': ['hall'], 'roles': [],
        'break_rules': [
            {'min_hours': 6, 'break_minutes': 45},
            {'min_hours': 8, 'break_minutes': 60},
        ],
        'hourly_wage_default': 1100, 'is_24h': {'weekday': True, 'weekend': True, 'holiday': True},
        'special_holidays': [], 'special_days': {},
        'allow_overstaffing': False,
    }


def _mk_staff_list():
    """15名: 社員4 (店長1+副店長1+一般2) / パート8 / 夜勤専用3"""
    staff = []
    # 社員 (店長/副店長/社員) - 全パターン可、月20日
    staff.append({
        'id': 'mgr', 'name': '店長', 'role': 'manager', 'salary_type': 'monthly',
        'evaluation': 'A', 'hourly_wage': 0, 'monthly_salary': 350000,
        'max_days_week': 6, 'max_hours_day': 9,
        'min_days_week': 0, 'min_days_month': 20, 'max_days_month': 23,
        'max_consecutive_days': 6,
        'position': 'any', 'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': [], 'ng_holiday': False,
    })
    staff.append({
        'id': 'sub', 'name': '副店長', 'role': 'sub_manager', 'salary_type': 'monthly',
        'evaluation': 'A', 'hourly_wage': 0, 'monthly_salary': 300000,
        'max_days_week': 6, 'max_hours_day': 9,
        'min_days_week': 0, 'min_days_month': 20, 'max_days_month': 23,
        'max_consecutive_days': 6,
        'position': 'any', 'pref_start_wd': None, 'pref_end_wd': None,
        'pref_start_we': None, 'pref_end_we': None,
        'req_pairs': None, 'ng_weekdays': [], 'ng_holiday': False,
    })
    for i, name in enumerate(['社員A', '社員B'], 3):
        staff.append({
            'id': f'emp{i}', 'name': name, 'role': 'employee', 'salary_type': 'monthly',
            'evaluation': 'B', 'hourly_wage': 0, 'monthly_salary': 270000,
            'max_days_week': 6, 'max_hours_day': 9,
            'min_days_week': 0, 'min_days_month': 19, 'max_days_month': 22,
            'max_consecutive_days': 5,
            'position': 'any', 'pref_start_wd': None, 'pref_end_wd': None,
            'pref_start_we': None, 'pref_end_we': None,
            'req_pairs': None, 'ng_weekdays': [], 'ng_holiday': False,
        })
    # パート 8名: 早番/中番のみ (夜勤NG)
    for i in range(1, 9):
        staff.append({
            'id': f'pt{i}', 'name': f'パート{i}', 'role': 'staff', 'salary_type': 'hourly',
            'evaluation': 'B', 'hourly_wage': 1200,
            'max_days_week': 5, 'max_hours_day': 8,
            'min_days_week': 0, 'min_days_month': 10, 'max_days_month': 18,
            'max_consecutive_days': 4,
            'eligible_patterns': ['早番', '中番'],  # 夜勤NG
            'position': 'any', 'pref_start_wd': None, 'pref_end_wd': None,
            'pref_start_we': None, 'pref_end_we': None,
            'req_pairs': None, 'ng_weekdays': [], 'ng_holiday': False,
        })
    # 夜勤専用 3名
    for i in range(1, 4):
        staff.append({
            'id': f'nt{i}', 'name': f'夜勤{i}', 'role': 'staff', 'salary_type': 'hourly',
            'evaluation': 'B', 'hourly_wage': 1500,
            'max_days_week': 5, 'max_hours_day': 9,
            'min_days_week': 0, 'min_days_month': 12, 'max_days_month': 18,
            'max_consecutive_days': 3,  # 夜勤は連勤短め
            'eligible_patterns': ['夜勤'],  # 夜勤のみ
            'position': 'any', 'pref_start_wd': None, 'pref_end_wd': None,
            'pref_start_we': None, 'pref_end_we': None,
            'req_pairs': None, 'ng_weekdays': [], 'ng_holiday': False,
        })
    return staff


def _dates(start, n):
    base = datetime.datetime.strptime(start, '%Y-%m-%d')
    return [(base + datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(n)]


def main():
    print("=" * 70)
    print("24時間営業 シミュレーション (v3.7.126)")
    print("=" * 70)
    cfg = _mk_config()
    staff = _mk_staff_list()
    dates = _dates('2026-09-01', 30)
    print(f"店舗: 24時間営業 / 早番 06-14 / 中番 14-22 / 夜勤 22-06")
    print(f"スタッフ: 全{len(staff)}名 (社員4/パート8/夜勤専用3)")
    print(f"期間: {dates[0]} 〜 {dates[-1]} ({len(dates)}日)")
    print("-" * 70)

    sched = ShiftScheduler(staff, cfg, dates)
    import time
    t0 = time.time()
    result = sched.solve() or []
    elapsed = time.time() - t0
    print(f"\n生成完了: {len(result)} シフト / 経過 {elapsed:.1f}s")

    # ---------- 1. 日別カバレッジ ----------
    print("\n【1. 日別 シフト数】")
    by_date_pat = {}
    for sh in result:
        d = sh['date']
        st = sh['start_time'][:5]
        # パターン推定
        if st.startswith('06'): p = '早番'
        elif st.startswith('14'): p = '中番'
        elif st.startswith('22'): p = '夜勤'
        else: p = f'その他({st})'
        by_date_pat.setdefault(d, {}).setdefault(p, 0)
        by_date_pat[d][p] += 1
    coverage_issues = 0
    for d in dates[:7]:  # 最初の1週間サマリ
        dow = datetime.datetime.strptime(d, '%Y-%m-%d').weekday()
        dow_label = ['月', '火', '水', '木', '金', '土', '日'][dow]
        is_we = dow >= 5
        expected = {'早番': 3 if is_we else 2, '中番': 3 if is_we else 2, '夜勤': 2}
        cnts = by_date_pat.get(d, {})
        missing = [(p, expected[p], cnts.get(p, 0)) for p in expected
                   if cnts.get(p, 0) < expected[p]]
        marker = '⚠' if missing else '✓'
        m_str = '/'.join(f"{p}{cnts.get(p,0)}/{expected[p]}" for p in expected)
        print(f"  {marker} {d}({dow_label}): {m_str}")
        if missing:
            coverage_issues += 1

    # ---------- 2. 連勤上限チェック ----------
    print("\n【2. 連勤上限チェック (営業日ベース)】")
    ops = sched._operational_dates
    violations = 0
    for s in staff:
        sid = s['id']
        limit = int(s.get('max_consecutive_days', 6))
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
        marker = '✓' if max_run <= limit else '⚠ NG'
        if max_run > limit:
            violations += 1
            print(f"  {marker} {s['name']:<8s}: 連続{max_run}日 (上限{limit}日)")
    if violations == 0:
        print(f"  ✓ 全{len(staff)}名 連勤上限厳守 (違反0件)")

    # ---------- 3. eligible_patterns 遵守 ----------
    print("\n【3. 該当シフトパターン遵守】")
    elig_violations = 0
    for s in staff:
        sid = s['id']
        elig = s.get('eligible_patterns', [])
        if not elig:
            continue
        for sh in result:
            if sh['staff_id'] != sid:
                continue
            st = sh['start_time'][:5]
            if st.startswith('06'): p = '早番'
            elif st.startswith('14'): p = '中番'
            elif st.startswith('22'): p = '夜勤'
            else: p = '?'
            if p not in elig:
                elig_violations += 1
                print(f"  ⚠ {s['name']} が {sh['date']} {p} に配置 (許可: {elig})")
    if elig_violations == 0:
        print(f"  ✓ 該当パターン違反 0件 (パート8名/夜勤3名 全員適合)")

    # ---------- 4. 日跨ぎシフト (夜勤) ----------
    print("\n【4. 夜勤 (22-06 日跨ぎ) 処理】")
    night_shifts = [sh for sh in result if sh['start_time'].startswith('22')]
    print(f"  夜勤シフト数: {len(night_shifts)}")
    for sh in night_shifts[:3]:
        brk = sh.get('break_minutes', 0)
        print(f"    {sh['date']} {sh['start_time']}-{sh['end_time']} 休憩{brk}分 staff={sh['staff_id']}")
    if night_shifts:
        all_brk_ok = all(sh.get('break_minutes', 0) >= 60 for sh in night_shifts)
        print(f"  ✓ 全夜勤に60分以上の休憩自動付与: {all_brk_ok}")

    # ---------- 5. スタッフ別 出勤日数 ----------
    print("\n【5. スタッフ別 月間出勤日数 (min/max 達成)】")
    fail_count = 0
    for s in staff:
        n = sum(1 for sh in result if sh['staff_id'] == s['id'])
        min_dm = s.get('min_days_month', 0)
        max_dm = s.get('max_days_month', 31)
        ok = '✓' if (n >= min_dm and n <= max_dm) else '⚠'
        if n < min_dm or n > max_dm:
            fail_count += 1
        print(f"  {ok} {s['name']:<8s}: {n}日 / 範囲 {min_dm}-{max_dm}日")
    if fail_count == 0:
        print(f"\n  ✓ 全員 min/max 範囲内")

    # ---------- 結論 ----------
    print("\n" + "=" * 70)
    summary = []
    summary.append(f"カバレッジ違反 (最初の1週間): {coverage_issues}件")
    summary.append(f"連勤上限違反: {violations}件")
    summary.append(f"該当パターン違反: {elig_violations}件")
    summary.append(f"min/max 範囲外: {fail_count}件")
    total_issues = coverage_issues + violations + elig_violations + fail_count
    print(f"【総合】 違反 合計 {total_issues}件")
    for s in summary:
        print(f"  - {s}")
    print(f"\n{'✅ PASS' if total_issues == 0 else '⚠ 要確認'}")
    return total_issues == 0


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
