import pulp
import random
from datetime import datetime, timedelta

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

        # シフトパターン = (start, end) のペアとして保持
        raw_patterns = config.get('custom_shifts', [])
        self.shift_patterns = []
        for p in raw_patterns:
            st = p.get('start', '09:00')
            en = p.get('end', '18:00')
            self.shift_patterns.append({'start': st, 'end': en, 'name': p.get('name', '')})
        
        if not self.shift_patterns:
            self.shift_patterns = [
                {'start': '09:00', 'end': '17:00', 'name': '早番'},
                {'start': '14:00', 'end': '22:00', 'name': '遅番'},
            ]

        self.op_limit = config.get('opening_time', '09:00')
        self.cl_limit = config.get('closing_time', '22:00')
        
        # opening_times が空の場合はop_limit/cl_limitからデフォルト生成
        raw_ot = config.get('opening_times', {})
        if not raw_ot or not raw_ot.get('weekday'):
            self.opening_times = {
                'weekday': {'start': self.op_limit, 'end': self.cl_limit},
                'weekend': {'start': self.op_limit, 'end': self.cl_limit},
                'holiday': {'start': self.op_limit, 'end': self.cl_limit}
            }
        else:
            self.opening_times = raw_ot

        self.staff_req = config.get('staff_req', {})
        self.min_weekday = int(self.staff_req.get('min_weekday', 2))
        self.min_weekend = int(self.staff_req.get('min_weekend', 3))
        self.min_holiday = int(self.staff_req.get('min_holiday', 3))
        self.min_manager = int(self.staff_req.get('min_manager', 1))
        
        self.time_staff_req = config.get('time_staff_req', [])
        
        self.break_rules = config.get('break_rules', [
            {'min_hours': 6, 'break_minutes': 45},
            {'min_hours': 8, 'break_minutes': 60}
        ])
        
        self.closed_days = config.get('closed_days', [])
        self.special_holidays = config.get('special_holidays', [])

        # デバッグ: 受信データをログ
        print(f"[Init] Staff: {len(self.staff_list)}, Dates: {len(self.dates)}")
        print(f"[Init] Patterns: {self.shift_patterns}")
        print(f"[Init] Requirements: weekday={self.min_weekday}, weekend={self.min_weekend}, holiday={self.min_holiday}")
        print(f"[Init] Opening times: {self.opening_times}")
        print(f"[Init] Time staff req: {self.time_staff_req}")

    # =========================================================
    # ヘルパー関数
    # =========================================================
    def _to_minutes(self, time_str):
        try:
            parts = str(time_str).split(':')
            return int(parts[0]) * 60 + int(parts[1])
        except:
            return 0

    def _from_minutes(self, mins):
        h = int(mins) // 60
        m = int(mins) % 60
        return f"{h:02d}:{m:02d}"

    def _get_day_type(self, date_str):
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        dow = dt.weekday()
        
        if date_str in self.special_holidays:
            return 'closed'
        
        js_dow = (dow + 1) % 7
        if js_dow in self.closed_days:
            return 'closed'
        
        if dow == 6:
            return 'holiday'
        if dow == 5:
            return 'weekend'
        return 'weekday'

    def _get_required_staff(self, date_str):
        day_type = self._get_day_type(date_str)
        if day_type == 'closed':
            return 0
        elif day_type == 'holiday':
            return self.min_holiday
        elif day_type == 'weekend':
            return self.min_weekend
        else:
            return self.min_weekday

    def _get_opening_hours(self, date_str):
        special_days = self.config.get('special_days', {})
        if date_str in special_days:
            sd = special_days[date_str]
            return sd.get('start', self.op_limit), sd.get('end', self.cl_limit)
        
        day_type = self._get_day_type(date_str)
        if day_type == 'holiday':
            t = self.opening_times.get('holiday', {})
        elif day_type == 'weekend':
            t = self.opening_times.get('weekend', {})
        else:
            t = self.opening_times.get('weekday', {})
        
        return t.get('start', self.op_limit), t.get('end', self.cl_limit)

    def _get_break_minutes(self, duration_hours):
        brk = 0
        sorted_rules = sorted(self.break_rules, key=lambda r: r.get('min_hours', 0))
        for rule in sorted_rules:
            if duration_hours > rule.get('min_hours', 0):
                brk = rule.get('break_minutes', 0)
        return brk

    def _get_ng_dates(self, staff):
        raw = staff.get('unavailable_dates')
        if not raw:
            return []
        if isinstance(raw, list):
            return [str(d).strip() for d in raw]
        return [str(d).strip() for d in str(raw).split(',')]

    def _group_dates_by_week(self):
        if not self.dates:
            return []
        weeks = []
        current_week = []
        for d in sorted(self.dates):
            dt = datetime.strptime(d, '%Y-%m-%d')
            if not current_week:
                current_week.append(d)
            else:
                prev_dt = datetime.strptime(current_week[-1], '%Y-%m-%d')
                if dt.isocalendar()[1] == prev_dt.isocalendar()[1] and dt.year == prev_dt.year:
                    current_week.append(d)
                else:
                    weeks.append(current_week)
                    current_week = [d]
        if current_week:
            weeks.append(current_week)
        return weeks

    def _build_shift_options(self, staff, date_str):
        """
        スタッフ×日付ごとに可能なシフト候補を返す。
        シフトパターンの(start, end)をそのまま使い、
        スタッフのmax_hoursを超えるパターンは除外する。
        """
        day_open, day_close = self._get_opening_hours(date_str)
        open_min = self._to_minutes(day_open)
        close_min = self._to_minutes(day_close)
        
        salary_type = str(staff.get('salary_type', 'hourly')).lower()
        max_hours = float(staff.get('max_hours_day') or 8)
        
        # max_hours が 0 の場合はこのスタッフは使えない
        if max_hours <= 0:
            return []
        
        options = []
        for pattern in self.shift_patterns:
            p_start = self._to_minutes(pattern['start'])
            p_end = self._to_minutes(pattern['end'])
            
            # 営業時間外のパターンはスキップ
            if p_start < open_min or p_end > close_min:
                # パターンをクリップして使う
                p_start = max(p_start, open_min)
                p_end = min(p_end, close_min)
            
            if p_start >= p_end:
                continue
            
            actual_hours = (p_end - p_start) / 60
            
            # 最低1時間
            if actual_hours < 1:
                continue
            
            # スタッフの最大時間を超えるパターンはスキップ
            if actual_hours > max_hours:
                continue
            
            # 月給社員で8時間未満のパターンはスキップ
            if salary_type == 'monthly' and actual_hours < 8:
                continue
            
            options.append({
                'start': self._from_minutes(p_start),
                'end': self._from_minutes(p_end),
                'start_min': p_start,
                'end_min': p_end,
                'hours': actual_hours
            })
        
        return options

    # =========================================================
    # 時間スロットごとの必要人数マップを生成
    # =========================================================
    def _build_slot_requirements(self, date_str):
        req_num = self._get_required_staff(date_str)
        if req_num <= 0:
            return {}
        
        day_open, day_close = self._get_opening_hours(date_str)
        op_min = self._to_minutes(day_open)
        cl_min = self._to_minutes(day_close)
        
        slots = {}
        for t in range(op_min, cl_min, 15):
            slots[t] = req_num
        
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        js_dow = (dt.weekday() + 1) % 7
        
        for rule in self.time_staff_req:
            rule_days = rule.get('days', [])
            if js_dow not in rule_days:
                continue
            
            r_start = self._to_minutes(rule.get('start', '00:00'))
            r_end = self._to_minutes(rule.get('end', '24:00'))
            r_count = int(rule.get('count', 0))
            
            for t in range(op_min, cl_min, 15):
                if r_start <= r_end:
                    in_range = (t >= r_start and t < r_end)
                else:
                    in_range = (t >= r_start or t < r_end)
                
                if in_range and t in slots:
                    slots[t] = max(slots[t], r_count)
        
        return slots

    # =========================================================
    # メインソルバー
    # =========================================================
    def solve(self):
        result = self._solve_optimized()
        if not result:
            print("Optimized solver failed. Trying fallback...")
            result = self._solve_fallback()
        return result

    def _solve_optimized(self):
        try:
            problem = pulp.LpProblem("Shift_Optimization", pulp.LpMinimize)
            
            # === スタッフ分類 ===
            monthly_ids = []
            managers = []
            eval_score = {}
            
            for s in self.staff_list:
                sid = s['id']
                if str(s.get('salary_type', 'hourly')).lower() == 'monthly':
                    monthly_ids.append(sid)
                if str(s.get('role', 'staff')).lower() in ['manager', 'leader']:
                    managers.append(sid)
                score_map = {'A': 4, 'B': 3, 'C': 2, 'D': 1}
                eval_score[sid] = score_map.get(str(s.get('evaluation', 'B')).upper(), 3)

            # === 変数定義 ===
            x = {}
            staff_options = {}
            
            for s in self.staff_list:
                ng_dates = self._get_ng_dates(s)
                for req in self.requests:
                    if (req.get('staff_id') == s['id'] and 
                        req.get('type') in ['off', 'holiday'] and 
                        req.get('status') == 'approved'):
                        rd = str(req.get('dates', ''))
                        if rd and rd not in ng_dates:
                            ng_dates.append(rd)
                
                for d in self.dates:
                    if d in ng_dates or self._get_day_type(d) == 'closed':
                        staff_options[(s['id'], d)] = []
                        continue
                    
                    options = self._build_shift_options(s, d)
                    staff_options[(s['id'], d)] = options
                    
                    for oi, opt in enumerate(options):
                        x[(s['id'], d, oi)] = pulp.LpVariable(
                            f"x_{s['id']}_{d}_{oi}", 0, 1, pulp.LpBinary
                        )

            # デバッグ: 各スタッフの選択肢数を出力
            for s in self.staff_list:
                d0 = self.dates[0] if self.dates else ''
                opts = staff_options.get((s['id'], d0), [])
                print(f"  Staff '{s.get('name','')}' options on {d0}: {[f\"{o['start']}-{o['end']}\" for o in opts]}")

            penalty = pulp.LpAffineExpression()

            # === 制約1: 1日1シフトまで ===
            for s in self.staff_list:
                for d in self.dates:
                    opts = staff_options.get((s['id'], d), [])
                    if opts:
                        problem += pulp.lpSum(
                            [x[(s['id'], d, oi)] for oi in range(len(opts))]
                        ) <= 1

            # === 制約2: 全時間スロットで必要人数を満たす (15分刻み) ===
            for d in self.dates:
                slot_reqs = self._build_slot_requirements(d)
                
                for slot_min, req_count in slot_reqs.items():
                    workers = []
                    for s in self.staff_list:
                        opts = staff_options.get((s['id'], d), [])
                        for oi, opt in enumerate(opts):
                            if opt['start_min'] <= slot_min < opt['end_min']:
                                workers.append(x[(s['id'], d, oi)])
                    
                    if workers:
                        slack = pulp.LpVariable(f"slot_{d}_{slot_min}", 0, None, pulp.LpInteger)
                        problem += pulp.lpSum(workers) + slack >= req_count
                        penalty += slack * 1000000
                    else:
                        # どのスタッフのどのパターンもこのスロットをカバーできない
                        time_str = self._from_minutes(slot_min)
                        print(f"  CRITICAL: No staff can cover {d} {time_str} (need {req_count})")

            # === 制約3: 管理者最低人数 (全時間スロット) ===
            for d in self.dates:
                if self._get_day_type(d) == 'closed':
                    continue
                
                slot_reqs = self._build_slot_requirements(d)
                if not slot_reqs:
                    continue
                
                for slot_min in slot_reqs.keys():
                    mgr_vars = []
                    for mid in managers:
                        opts = staff_options.get((mid, d), [])
                        for oi, opt in enumerate(opts):
                            if opt['start_min'] <= slot_min < opt['end_min']:
                                mgr_vars.append(x[(mid, d, oi)])
                    
                    if mgr_vars:
                        slack = pulp.LpVariable(f"mgr_{d}_{slot_min}", 0, None, pulp.LpInteger)
                        problem += pulp.lpSum(mgr_vars) + slack >= self.min_manager
                        penalty += slack * 500000

            # === 制約4: 週の勤務日数上限 ===
            week_groups = self._group_dates_by_week()
            for s in self.staff_list:
                max_days = int(s.get('max_days_week') or 5)
                if max_days <= 0:
                    # max_days=0 のスタッフは出勤させない
                    for d in self.dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi in range(len(opts)):
                            problem += x[(s['id'], d, oi)] == 0
                    continue
                    
                for week_dates in week_groups:
                    week_vars = []
                    for d in week_dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi in range(len(opts)):
                            week_vars.append(x[(s['id'], d, oi)])
                    if week_vars:
                        problem += pulp.lpSum(week_vars) <= max_days

            # === 制約5: 連勤6日まで ===
            for s in self.staff_list:
                sorted_dates = sorted(self.dates)
                for idx in range(len(sorted_dates) - 6):
                    span = sorted_dates[idx:idx + 7]
                    span_vars = []
                    for d in span:
                        opts = staff_options.get((s['id'], d), [])
                        for oi in range(len(opts)):
                            span_vars.append(x[(s['id'], d, oi)])
                    if span_vars:
                        problem += pulp.lpSum(span_vars) <= 6

            # === 目的関数 ===
            
            # 固定給社員: 出勤しないとペナルティ
            for sid in monthly_ids:
                for d in self.dates:
                    if self._get_day_type(d) == 'closed':
                        continue
                    opts = staff_options.get((sid, d), [])
                    if opts:
                        not_working = 1 - pulp.lpSum(
                            [x[(sid, d, oi)] for oi in range(len(opts))]
                        )
                        penalty += not_working * 30000

            # 評価スコアによるコスト
            for s in self.staff_list:
                sid = s['id']
                score = eval_score.get(sid, 3)
                cost_map = {4: 0, 3: 50, 2: 300, 1: 1500}
                cost = cost_map.get(score, 50)
                
                for d in self.dates:
                    opts = staff_options.get((sid, d), [])
                    for oi in range(len(opts)):
                        penalty += x[(sid, d, oi)] * cost

            # 人件費最小化
            for s in self.staff_list:
                if str(s.get('salary_type', 'hourly')).lower() != 'hourly':
                    continue
                wage = float(s.get('hourly_wage', 1100))
                for d in self.dates:
                    opts = staff_options.get((s['id'], d), [])
                    for oi, opt in enumerate(opts):
                        penalty += x[(s['id'], d, oi)] * wage * opt['hours'] * 0.01

            # === 求解 ===
            problem += penalty
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=120)
            problem.solve(solver)

            status = pulp.LpStatus[problem.status]
            print(f"Solver status: {status}")

            if status in ['Optimal', 'Not Solved']:
                shifts = []
                for s in self.staff_list:
                    for d in self.dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi, opt in enumerate(opts):
                            if (s['id'], d, oi) in x and pulp.value(x[(s['id'], d, oi)]) == 1:
                                dur = opt['hours']
                                brk = self._get_break_minutes(dur)
                                shifts.append({
                                    "staff_id": s['id'],
                                    "date": d,
                                    "start_time": opt['start'],
                                    "end_time": opt['end'],
                                    "break_minutes": brk
                                })
                
                self._validate_result(shifts)
                
                print(f"Generated {len(shifts)} shifts")
                return shifts if shifts else None
            
            return None

        except Exception as e:
            print(f"Solver Error: {e}")
            import traceback
            traceback.print_exc()
            return None

    def _validate_result(self, shifts):
        violations = 0
        for d in self.dates:
            slot_reqs = self._build_slot_requirements(d)
            day_shifts = [s for s in shifts if s['date'] == d]
            
            for slot_min, req_count in slot_reqs.items():
                coverage = 0
                for s in day_shifts:
                    s_start = self._to_minutes(s['start_time'])
                    s_end = self._to_minutes(s['end_time'])
                    if s_start <= slot_min < s_end:
                        coverage += 1
                
                if coverage < req_count:
                    time_str = self._from_minutes(slot_min)
                    print(f"  WARNING: {d} {time_str} - Need {req_count}, got {coverage}")
                    violations += 1
        
        if violations == 0:
            print("  VALIDATION: All time slots fully covered!")
        else:
            print(f"  VALIDATION: {violations} slot violations found")

    # =========================================================
    # フォールバック
    # =========================================================
    def _solve_fallback(self):
        shifts = []
        weekly_count = {}
        
        for d in sorted(self.dates):
            if self._get_day_type(d) == 'closed':
                continue
            
            slot_reqs = self._build_slot_requirements(d)
            if not slot_reqs:
                continue
            
            dt = datetime.strptime(d, '%Y-%m-%d')
            week_key = f"{dt.year}-W{dt.isocalendar()[1]}"
            
            day_shifts = []
            assigned_staff = set()
            
            max_passes = 20
            for _ in range(max_passes):
                deficit_slots = {}
                for slot_min, req_count in slot_reqs.items():
                    coverage = 0
                    for s in day_shifts:
                        s_start = self._to_minutes(s['start_time'])
                        s_end = self._to_minutes(s['end_time'])
                        if s_start <= slot_min < s_end:
                            coverage += 1
                    
                    if coverage < req_count:
                        deficit_slots[slot_min] = req_count - coverage
                
                if not deficit_slots:
                    break
                
                worst_slot = max(deficit_slots, key=deficit_slots.get)
                
                best_staff = None
                best_option = None
                best_coverage = 0
                
                for s in self.staff_list:
                    if s['id'] in assigned_staff:
                        continue
                    
                    ng = self._get_ng_dates(s)
                    for req in self.requests:
                        if (req.get('staff_id') == s['id'] and 
                            req.get('type') in ['off', 'holiday'] and 
                            req.get('status') == 'approved'):
                            rd = str(req.get('dates', ''))
                            if rd and rd not in ng:
                                ng.append(rd)
                    
                    if d in ng:
                        continue
                    
                    max_days = int(s.get('max_days_week') or 5)
                    if max_days <= 0:
                        continue
                    current = weekly_count.get(s['id'], {}).get(week_key, 0)
                    if current >= max_days:
                        continue
                    
                    options = self._build_shift_options(s, d)
                    for opt in options:
                        if opt['start_min'] <= worst_slot < opt['end_min']:
                            cov = sum(1 for sm in deficit_slots if opt['start_min'] <= sm < opt['end_min'])
                            if cov > best_coverage:
                                best_coverage = cov
                                best_staff = s
                                best_option = opt
                
                if best_staff and best_option:
                    brk = self._get_break_minutes(best_option['hours'])
                    shift = {
                        "staff_id": best_staff['id'],
                        "date": d,
                        "start_time": best_option['start'],
                        "end_time": best_option['end'],
                        "break_minutes": brk
                    }
                    day_shifts.append(shift)
                    assigned_staff.add(best_staff['id'])
                    
                    if best_staff['id'] not in weekly_count:
                        weekly_count[best_staff['id']] = {}
                    weekly_count[best_staff['id']][week_key] = weekly_count[best_staff['id']].get(week_key, 0) + 1
                else:
                    break
            
            shifts.extend(day_shifts)
        
        return shifts
