import pulp
import random
from datetime import datetime, timedelta

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

        # シフトパターン = 出勤開始時間の選択肢
        raw_patterns = config.get('custom_shifts', [])
        self.start_times = []
        for p in raw_patterns:
            st = p.get('start', '09:00')
            if st not in self.start_times:
                self.start_times.append(st)
        
        if not self.start_times:
            self.start_times = ['09:00', '14:00', '17:00']

        # 営業時間
        self.op_limit = config.get('opening_time', '09:00')
        self.cl_limit = config.get('closing_time', '22:00')
        
        self.opening_times = config.get('opening_times', {
            'weekday': {'start': '09:00', 'end': '22:00'},
            'weekend': {'start': '10:00', 'end': '20:00'},
            'holiday': {'start': '10:00', 'end': '20:00'}
        })

        # 人員配置要件
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

    def solve(self):
        result = self._solve_optimized()
        if not result:
            print("Optimized solver failed. Trying fallback...")
            result = self._solve_fallback()
        return result

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

    def _calc_duration_hours(self, start, end):
        s = self._to_minutes(start)
        e = self._to_minutes(end)
        if e <= s:
            e += 24 * 60
        return (e - s) / 60

    def _get_day_type(self, date_str):
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        dow = dt.weekday()  # 0=Mon, 6=Sun
        
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

    def _get_staff_end_time(self, staff, start_time, day_close):
        """スタッフの契約に基づいて終了時間を算出"""
        salary_type = str(staff.get('salary_type', 'hourly')).lower()
        max_hours = float(staff.get('max_hours_day', 8))
        
        # 固定給（社員）: 最低8時間、max_hours_dayまで
        if salary_type == 'monthly':
            work_hours = max(8, max_hours)
        else:
            work_hours = max_hours
        
        start_min = self._to_minutes(start_time)
        end_min = start_min + int(work_hours * 60)
        close_min = self._to_minutes(day_close)
        
        # 営業時間でクリップ
        end_min = min(end_min, close_min)
        
        return self._from_minutes(end_min)

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

    # =========================================================
    # スタッフ別のシフト候補を事前生成
    # =========================================================
    def _build_shift_options(self, staff, date_str):
        """
        スタッフ×日付ごとに可能なシフト候補を返す
        各候補: (start_time, end_time, start_min, end_min, duration_hours)
        """
        day_open, day_close = self._get_opening_hours(date_str)
        open_min = self._to_minutes(day_open)
        close_min = self._to_minutes(day_close)
        
        salary_type = str(staff.get('salary_type', 'hourly')).lower()
        max_hours = float(staff.get('max_hours_day', 8))
        
        if salary_type == 'monthly':
            work_minutes = max(480, int(max_hours * 60))  # 社員は最低8時間
        else:
            work_minutes = int(max_hours * 60)
        
        options = []
        for st in self.start_times:
            st_min = self._to_minutes(st)
            
            # 営業時間外の開始は無効
            if st_min < open_min or st_min >= close_min:
                continue
            
            end_min = min(st_min + work_minutes, close_min)
            actual_hours = (end_min - st_min) / 60
            
            # 最低1時間、社員は最低実働時間確保
            if actual_hours < 1:
                continue
            
            # 社員で8時間確保できない開始時間はスキップ
            if salary_type == 'monthly' and actual_hours < 8:
                continue
            
            options.append({
                'start': self._from_minutes(st_min),
                'end': self._from_minutes(end_min),
                'start_min': st_min,
                'end_min': end_min,
                'hours': actual_hours
            })
        
        return options

    # =========================================================
    # 数理最適化ソルバー
    # =========================================================
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

            # === 変数定義: x[staff_id, date, option_idx] ===
            # スタッフ×日付ごとに候補を事前計算
            x = {}
            staff_options = {}  # (staff_id, date) -> [option, ...]
            
            for s in self.staff_list:
                ng_dates = self._get_ng_dates(s)
                # 承認済み休暇も追加
                for req in self.requests:
                    if (req.get('staff_id') == s['id'] and 
                        req.get('type') in ['off', 'holiday'] and 
                        req.get('status') == 'approved'):
                        rd = str(req.get('dates', ''))
                        if rd and rd not in ng_dates:
                            ng_dates.append(rd)
                
                for d in self.dates:
                    # NG日・定休日はスキップ
                    if d in ng_dates or self._get_day_type(d) == 'closed':
                        staff_options[(s['id'], d)] = []
                        continue
                    
                    options = self._build_shift_options(s, d)
                    staff_options[(s['id'], d)] = options
                    
                    for oi, opt in enumerate(options):
                        x[(s['id'], d, oi)] = pulp.LpVariable(
                            f"x_{s['id']}_{d}_{oi}", 0, 1, pulp.LpBinary
                        )

            penalty = pulp.LpAffineExpression()

            # === 制約1: 1日1シフトまで ===
            for s in self.staff_list:
                for d in self.dates:
                    opts = staff_options.get((s['id'], d), [])
                    if opts:
                        problem += pulp.lpSum(
                            [x[(s['id'], d, oi)] for oi in range(len(opts))]
                        ) <= 1

            # === 制約2: 曜日別 必要人数（時間帯別） ===
            for d in self.dates:
                req_num = self._get_required_staff(d)
                if req_num <= 0:
                    continue
                
                day_open, day_close = self._get_opening_hours(d)
                op_min = self._to_minutes(day_open)
                cl_min = self._to_minutes(day_close)
                
                for h_min in range(op_min, cl_min, 60):
                    workers = []
                    for s in self.staff_list:
                        opts = staff_options.get((s['id'], d), [])
                        for oi, opt in enumerate(opts):
                            if opt['start_min'] <= h_min < opt['end_min']:
                                workers.append(x[(s['id'], d, oi)])
                    
                    if workers:
                        slack = pulp.LpVariable(f"slack_{d}_{h_min}", 0, req_num)
                        problem += pulp.lpSum(workers) + slack >= req_num
                        penalty += slack * 50000

            # === 制約3: 時間帯別人員増強 ===
            for rule in self.time_staff_req:
                rule_days = rule.get('days', [])
                r_start = self._to_minutes(rule.get('start', '00:00'))
                r_end = self._to_minutes(rule.get('end', '24:00'))
                r_count = int(rule.get('count', 0))
                
                for d in self.dates:
                    dt = datetime.strptime(d, '%Y-%m-%d')
                    js_dow = (dt.weekday() + 1) % 7
                    if js_dow not in rule_days:
                        continue
                    
                    for h_min in range(r_start, r_end, 60):
                        workers = []
                        for s in self.staff_list:
                            opts = staff_options.get((s['id'], d), [])
                            for oi, opt in enumerate(opts):
                                if opt['start_min'] <= h_min < opt['end_min']:
                                    workers.append(x[(s['id'], d, oi)])
                        
                        if workers:
                            slack = pulp.LpVariable(f"trslack_{d}_{h_min}", 0, r_count)
                            problem += pulp.lpSum(workers) + slack >= r_count
                            penalty += slack * 50000

            # === 制約4: 管理者最低人数 ===
            for d in self.dates:
                if self._get_day_type(d) == 'closed':
                    continue
                mgr_vars = []
                for mid in managers:
                    opts = staff_options.get((mid, d), [])
                    for oi in range(len(opts)):
                        mgr_vars.append(x[(mid, d, oi)])
                
                if mgr_vars:
                    slack = pulp.LpVariable(f"mgrslack_{d}", 0, self.min_manager)
                    problem += pulp.lpSum(mgr_vars) + slack >= self.min_manager
                    penalty += slack * 100000

            # === 制約5: 週の勤務日数上限 ===
            week_groups = self._group_dates_by_week()
            for s in self.staff_list:
                max_days = int(s.get('max_days_week', 5))
                for week_dates in week_groups:
                    week_vars = []
                    for d in week_dates:
                        opts = staff_options.get((s['id'], d), [])
                        for oi in range(len(opts)):
                            week_vars.append(x[(s['id'], d, oi)])
                    if week_vars:
                        problem += pulp.lpSum(week_vars) <= max_days

            # === 制約6: 連勤6日まで（労基法） ===
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
            
            # 固定給（社員）: 出勤しないと高ペナルティ
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

            # 評価によるコスト（低評価ほど使いたくない）
            for s in self.staff_list:
                sid = s['id']
                score = eval_score.get(sid, 3)
                cost_map = {4: 0, 3: 50, 2: 300, 1: 1500}
                cost = cost_map.get(score, 50)
                
                for d in self.dates:
                    opts = staff_options.get((sid, d), [])
                    for oi in range(len(opts)):
                        penalty += x[(sid, d, oi)] * cost

            # === 求解 ===
            problem += penalty
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=60)
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
                
                print(f"Generated {len(shifts)} shifts")
                return shifts if shifts else None
            
            return None

        except Exception as e:
            print(f"Solver Error: {e}")
            import traceback
            traceback.print_exc()
            return None

    # =========================================================
    # フォールバック
    # =========================================================
    def _solve_fallback(self):
        shifts = []
        weekly_count = {}  # staff_id -> 週番号 -> 出勤日数
        
        for d in sorted(self.dates):
            if self._get_day_type(d) == 'closed':
                continue
            
            req_num = self._get_required_staff(d)
            dt = datetime.strptime(d, '%Y-%m-%d')
            week_key = f"{dt.year}-W{dt.isocalendar()[1]}"
            
            # 利用可能スタッフ
            available = []
            for s in self.staff_list:
                ng = self._get_ng_dates(s)
                if d in ng:
                    continue
                
                # 週上限チェック
                max_days = int(s.get('max_days_week', 5))
                current = weekly_count.get(s['id'], {}).get(week_key, 0)
                if current >= max_days:
                    continue
                
                available.append(s)
            
            # ソート: 社員優先 → 評価高い順
            score_map = {'A': 4, 'B': 3, 'C': 2, 'D': 1}
            available.sort(key=lambda s: (
                0 if str(s.get('salary_type', '')).lower() == 'monthly' else 1,
                -score_map.get(str(s.get('evaluation', 'B')).upper(), 3)
            ))
            
            selected = available[:max(req_num, 1)]
            
            for s in selected:
                options = self._build_shift_options(s, d)
                if not options:
                    continue
                
                # 社員は最長パターン、バイトも最長（max_hours内）
                best = max(options, key=lambda o: o['hours'])
                
                brk = self._get_break_minutes(best['hours'])
                shifts.append({
                    "staff_id": s['id'],
                    "date": d,
                    "start_time": best['start'],
                    "end_time": best['end'],
                    "break_minutes": brk
                })
                
                # 週カウント更新
                if s['id'] not in weekly_count:
                    weekly_count[s['id']] = {}
                weekly_count[s['id']][week_key] = weekly_count[s['id']].get(week_key, 0) + 1
        
        return shifts
