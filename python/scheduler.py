import pulp
import random
from datetime import datetime, timedelta

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

        # シフトパターン取得
        self.patterns = config.get('custom_shifts', [])
        
        # 営業時間
        self.op_limit = config.get('opening_time', '09:00')
        self.cl_limit = config.get('closing_time', '22:00')
        
        # 営業時間詳細
        self.opening_times = config.get('opening_times', {
            'weekday': {'start': '09:00', 'end': '22:00'},
            'weekend': {'start': '10:00', 'end': '20:00'},
            'holiday': {'start': '10:00', 'end': '20:00'}
        })

        # パターンがなければデフォルト生成
        if not self.patterns:
            op = self.op_limit
            cl = self.cl_limit
            mid_h = (self._to_minutes(op) + self._to_minutes(cl)) // 2
            mid_time = f"{mid_h // 60:02d}:{mid_h % 60:02d}"
            self.patterns = [
                {"name": "早番", "start": op, "end": mid_time},
                {"name": "遅番", "start": mid_time, "end": cl},
                {"name": "通し", "start": op, "end": cl}
            ]

        # 人員配置要件
        self.staff_req = config.get('staff_req', {})
        self.min_weekday = int(self.staff_req.get('min_weekday', 2))
        self.min_weekend = int(self.staff_req.get('min_weekend', 3))
        self.min_holiday = int(self.staff_req.get('min_holiday', 3))
        self.min_manager = int(self.staff_req.get('min_manager', 1))
        
        # 時間帯別人員ルール
        self.time_staff_req = config.get('time_staff_req', [])
        
        # 休憩ルール
        self.break_rules = config.get('break_rules', [
            {'min_hours': 6, 'break_minutes': 45},
            {'min_hours': 8, 'break_minutes': 60}
        ])
        
        # 定休日
        self.closed_days = config.get('closed_days', [])
        
        # 臨時休業日
        self.special_holidays = config.get('special_holidays', [])

    def solve(self):
        result = self._solve_optimized()
        if not result:
            print("Fallback logic triggered.")
            result = self._solve_fallback()
        return result

    def _get_day_type(self, date_str):
        """日付の種別を返す: 'closed', 'holiday', 'weekend', 'weekday'"""
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        dow = dt.weekday()  # 0=Mon, 6=Sun
        
        # 臨時休業
        if date_str in self.special_holidays:
            return 'closed'
        
        # 定休日 (JS: 0=Sun,1=Mon... → Python: 0=Mon...6=Sun)
        js_dow = (dow + 1) % 7  # Python→JS変換
        if js_dow in self.closed_days:
            return 'closed'
        
        # 日曜・祝日
        if dow == 6:  # Sunday
            return 'holiday'
        
        # 土曜
        if dow == 5:
            return 'weekend'
        
        return 'weekday'

    def _get_required_staff(self, date_str):
        """その日の必要人数を返す"""
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
        """その日の営業開始・終了時間を返す"""
        # 特定日チェック
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

    def _solve_optimized(self):
        try:
            problem = pulp.LpProblem("Shift_Optimization", pulp.LpMinimize)
            
            # === 変数定義 ===
            x = {}
            for s in self.staff_list:
                for d in self.dates:
                    for i, p in enumerate(self.patterns):
                        x[(s['id'], d, i)] = pulp.LpVariable(
                            f"x_{s['id']}_{d}_{i}", 0, 1, pulp.LpBinary
                        )

            # === スタッフ分類 ===
            monthly_staff = []  # 固定給（社員）
            hourly_staff = []   # 時給（アルバイト）
            managers = []       # 管理者（店長・リーダー）
            
            eval_score = {}  # 評価スコア（高い=優先）
            
            for s in self.staff_list:
                sid = s['id']
                salary_type = str(s.get('salary_type', 'hourly')).lower()
                role = str(s.get('role', 'staff')).lower()
                evaluation = str(s.get('evaluation', 'B')).upper()
                
                if salary_type == 'monthly':
                    monthly_staff.append(sid)
                else:
                    hourly_staff.append(sid)
                
                if role in ['manager', 'leader']:
                    managers.append(sid)
                
                # 評価スコア: A=4, B=3, C=2, D=1
                score_map = {'A': 4, 'B': 3, 'C': 2, 'D': 1}
                eval_score[sid] = score_map.get(evaluation, 3)

            penalty = pulp.LpAffineExpression()

            # === 制約1: 1日1シフトまで ===
            for s in self.staff_list:
                for d in self.dates:
                    problem += pulp.lpSum(
                        [x[(s['id'], d, i)] for i in range(len(self.patterns))]
                    ) <= 1

            # === 制約2: NG日（希望休・unavailable_dates）===
            for s in self.staff_list:
                ng_dates = self._get_ng_dates(s)
                # 承認済み休暇申請もNG日に追加
                for req in self.requests:
                    if (req.get('staff_id') == s['id'] and 
                        req.get('type') in ['off', 'holiday'] and 
                        req.get('status') == 'approved'):
                        req_dates = str(req.get('dates', ''))
                        if req_dates and req_dates not in ng_dates:
                            ng_dates.append(req_dates)
                
                for d in self.dates:
                    if d in ng_dates:
                        for i in range(len(self.patterns)):
                            problem += x[(s['id'], d, i)] == 0

            # === 制約3: 定休日・臨時休業日は全員休み ===
            for d in self.dates:
                if self._get_day_type(d) == 'closed':
                    for s in self.staff_list:
                        for i in range(len(self.patterns)):
                            problem += x[(s['id'], d, i)] == 0

            # === 制約4: 曜日別必要人数の確保 ===
            for d in self.dates:
                req_num = self._get_required_staff(d)
                if req_num <= 0:
                    continue
                
                day_open, day_close = self._get_opening_hours(d)
                op_min = self._to_minutes(day_open)
                cl_min = self._to_minutes(day_close)
                
                # 1時間刻みでチェック
                for h_min in range(op_min, cl_min, 60):
                    workers = []
                    for s in self.staff_list:
                        for i, p in enumerate(self.patterns):
                            p_start = self._to_minutes(p['start'])
                            p_end = self._to_minutes(p['end'])
                            # このパターンがこの時間帯をカバーするか
                            if p_start <= h_min < p_end:
                                workers.append(x[(s['id'], d, i)])
                    
                    if workers:
                        slack = pulp.LpVariable(f"slack_{d}_{h_min}", 0, req_num)
                        problem += pulp.lpSum(workers) + slack >= req_num
                        penalty += slack * 50000  # 人員不足は最大ペナルティ

            # === 制約5: 時間帯別人員増強ルール ===
            for rule in self.time_staff_req:
                rule_days = rule.get('days', [])  # JS曜日 (0=Sun)
                rule_start = self._to_minutes(rule.get('start', '00:00'))
                rule_end = self._to_minutes(rule.get('end', '24:00'))
                rule_count = int(rule.get('count', 0))
                
                for d in self.dates:
                    dt = datetime.strptime(d, '%Y-%m-%d')
                    js_dow = (dt.weekday() + 1) % 7  # Python→JS曜日変換
                    
                    if js_dow not in rule_days:
                        continue
                    
                    for h_min in range(rule_start, rule_end, 60):
                        workers = []
                        for s in self.staff_list:
                            for i, p in enumerate(self.patterns):
                                p_start = self._to_minutes(p['start'])
                                p_end = self._to_minutes(p['end'])
                                if p_start <= h_min < p_end:
                                    workers.append(x[(s['id'], d, i)])
                        
                        if workers:
                            slack = pulp.LpVariable(f"trslack_{d}_{h_min}", 0, rule_count)
                            problem += pulp.lpSum(workers) + slack >= rule_count
                            penalty += slack * 50000

            # === 制約6: 管理者最低1名確保 ===
            for d in self.dates:
                if self._get_day_type(d) == 'closed':
                    continue
                mgr_workers = []
                for mid in managers:
                    for i in range(len(self.patterns)):
                        mgr_workers.append(x[(mid, d, i)])
                
                if mgr_workers:
                    mgr_slack = pulp.LpVariable(f"mgrslack_{d}", 0, self.min_manager)
                    problem += pulp.lpSum(mgr_workers) + mgr_slack >= self.min_manager
                    penalty += mgr_slack * 100000  # 管理者不在は超高ペナルティ

            # === 制約7: 週の勤務日数上限 ===
            # 1週間ごとにグループ化
            week_groups = self._group_dates_by_week()
            for s in self.staff_list:
                max_days = int(s.get('max_days_week', 5))
                for week_dates in week_groups:
                    week_shifts = []
                    for d in week_dates:
                        if d in self.dates:
                            for i in range(len(self.patterns)):
                                week_shifts.append(x[(s['id'], d, i)])
                    if week_shifts:
                        problem += pulp.lpSum(week_shifts) <= max_days

            # === 制約8: 1日の勤務時間上限 ===
            for s in self.staff_list:
                max_hours = float(s.get('max_hours_day', 8))
                for d in self.dates:
                    for i, p in enumerate(self.patterns):
                        duration = self._calc_duration(p['start'], p['end'])
                        if duration > max_hours:
                            problem += x[(s['id'], d, i)] == 0

            # === 目的関数: 評価の高いスタッフを優先 ===
            
            # 固定給スタッフは出勤しないとペナルティ（週5日=月約22日働くべき）
            for sid in monthly_staff:
                for d in self.dates:
                    if self._get_day_type(d) == 'closed':
                        continue
                    # 出勤しない日はペナルティ
                    not_working = 1 - pulp.lpSum(
                        [x[(sid, d, i)] for i in range(len(self.patterns))]
                    )
                    penalty += not_working * 10000  # 社員は出勤優先

            # 評価の高いスタッフを優先的に配置（低評価にコスト付与）
            for s in self.staff_list:
                sid = s['id']
                score = eval_score.get(sid, 3)
                # 評価が低いほどコストが高い（A=0, B=100, C=500, D=2000）
                cost_map = {4: 0, 3: 100, 2: 500, 1: 2000}
                usage_cost = cost_map.get(score, 100)
                
                for d in self.dates:
                    for i in range(len(self.patterns)):
                        penalty += x[(sid, d, i)] * usage_cost

            # === 労働基準法: 週6日以上の連勤防止 ===
            for s in self.staff_list:
                for idx in range(len(self.dates) - 6):
                    consecutive = self.dates[idx:idx + 7]
                    week_sum = []
                    for d in consecutive:
                        for i in range(len(self.patterns)):
                            week_sum.append(x[(s['id'], d, i)])
                    if week_sum:
                        problem += pulp.lpSum(week_sum) <= 6

            # === 求解 ===
            problem += penalty
            solver = pulp.PULP_CBC_CMD(msg=0, timeLimit=30)
            problem.solve(solver)

            status = pulp.LpStatus[problem.status]
            print(f"Solver status: {status}")

            if status == 'Optimal' or status == 'Not Solved':
                shifts = []
                for s in self.staff_list:
                    for d in self.dates:
                        for i, p in enumerate(self.patterns):
                            if pulp.value(x[(s['id'], d, i)]) == 1:
                                day_open, day_close = self._get_opening_hours(d)
                                real_start = max(p['start'], day_open)
                                real_end = min(p['end'], day_close)
                                dur = self._calc_duration(real_start, real_end)
                                brk = self._get_break_minutes(dur)

                                shifts.append({
                                    "staff_id": s['id'],
                                    "date": d,
                                    "start_time": real_start,
                                    "end_time": real_end,
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

    def _solve_fallback(self):
        """最適化失敗時のフォールバック"""
        shifts = []
        for d in self.dates:
            if self._get_day_type(d) == 'closed':
                continue
            
            req_num = self._get_required_staff(d)
            day_open, day_close = self._get_opening_hours(d)
            
            # 利用可能なスタッフ
            available = []
            for s in self.staff_list:
                ng = self._get_ng_dates(s)
                if d not in ng:
                    available.append(s)
            
            # 評価順にソート
            score_map = {'A': 4, 'B': 3, 'C': 2, 'D': 1}
            available.sort(
                key=lambda s: score_map.get(str(s.get('evaluation', 'B')).upper(), 3),
                reverse=True
            )
            
            # 固定給を先に配置
            selected = []
            for s in available:
                if len(selected) >= req_num:
                    break
                if str(s.get('salary_type', '')).lower() == 'monthly':
                    selected.append(s)
            
            # 残りを評価順で補充
            for s in available:
                if len(selected) >= req_num:
                    break
                if s not in selected:
                    selected.append(s)
            
            for s in selected:
                # 適切なパターンを選択（max_hours_day考慮）
                max_h = float(s.get('max_hours_day', 8))
                best_pattern = None
                for p in self.patterns:
                    dur = self._calc_duration(p['start'], p['end'])
                    if dur <= max_h:
                        if best_pattern is None or dur > self._calc_duration(best_pattern['start'], best_pattern['end']):
                            best_pattern = p
                
                if not best_pattern:
                    best_pattern = self.patterns[0] if self.patterns else {
                        'start': day_open, 'end': day_close
                    }
                
                real_start = max(best_pattern['start'], day_open)
                real_end = min(best_pattern['end'], day_close)
                dur = self._calc_duration(real_start, real_end)
                brk = self._get_break_minutes(dur)
                
                shifts.append({
                    "staff_id": s['id'],
                    "date": d,
                    "start_time": real_start,
                    "end_time": real_end,
                    "break_minutes": brk
                })
        
        return shifts

    def _group_dates_by_week(self):
        """日付リストを週ごとにグループ化"""
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
                # 同じ週（月曜始まり）
                if dt.isocalendar()[1] == prev_dt.isocalendar()[1] and dt.year == prev_dt.year:
                    current_week.append(d)
                else:
                    weeks.append(current_week)
                    current_week = [d]
        
        if current_week:
            weeks.append(current_week)
        
        return weeks

    def _get_break_minutes(self, duration_hours):
        """設定された休憩ルールに基づいて休憩時間を返す"""
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

    def _to_minutes(self, time_str):
        """HH:MM → 分に変換"""
        try:
            parts = str(time_str).split(':')
            return int(parts[0]) * 60 + int(parts[1])
        except:
            return 0

    def _calc_duration(self, start, end):
        """開始〜終了の時間（時間単位）を返す"""
        s_min = self._to_minutes(start)
        e_min = self._to_minutes(end)
        if e_min < s_min:
            e_min += 24 * 60
        return (e_min - s_min) / 60
