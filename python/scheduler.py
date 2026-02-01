import pulp
import random

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

        # 1. シフトパターン取得
        self.patterns = config.get('custom_shifts', [])
        
        # 2. 営業時間 (デフォルト)
        self.op_limit = config.get('opening_time', '09:00')
        self.cl_limit = config.get('closing_time', '22:00')

        if not self.patterns:
            op = self.op_limit
            cl = self.cl_limit
            mid_h = (int(op.split(':')[0]) + int(cl.split(':')[0])) // 2
            mid_time = f"{mid_h:02d}:00"
            self.patterns = [
                {"name": "早番", "start": op, "end": mid_time},
                {"name": "遅番", "start": mid_time, "end": cl},
                {"name": "通し", "start": op, "end": cl}
            ]

    def solve(self):
        result = self._solve_optimized()
        if not result:
            print("Fallback logic triggered.")
            result = self._solve_fallback()
        return result

    def _solve_optimized(self):
        try:
            problem = pulp.LpProblem("Shift_Optimization", pulp.LpMinimize)
            
            # --- 変数定義 ---
            # x[staff_id][date][pattern_idx]
            x = {}
            for s in self.staff_list:
                for d in self.dates:
                    for i, p in enumerate(self.patterns):
                        x[(s['id'], d, i)] = pulp.LpVariable(f"x_{s['id']}_{d}_{i}", 0, 1, pulp.LpBinary)

            # --- ランク判定 ---
            rank_a = []
            rank_b = []
            rank_c = []
            rank_d = []
            for s in self.staff_list:
                role = str(s.get('role', '')).lower()
                eval_val = str(s.get('evaluation', '')).upper()
                sid = s['id']
                if eval_val == 'A' or '店長' in role or 'manager' in role: rank_a.append(sid)
                elif eval_val == 'B': rank_b.append(sid)
                elif eval_val == 'C': rank_c.append(sid)
                elif eval_val == 'D' or 'バイト' in role: rank_d.append(sid)
                else: rank_b.append(sid) # デフォルトB

            penalty = 0

            # --- 制約1: 1日1回まで ---
            for s in self.staff_list:
                for d in self.dates:
                    problem += pulp.lpSum([x[(s['id'], d, i)] for i in range(len(self.patterns))]) <= 1

            # --- 制約2: 時間帯ごとの必要人数確保 ---
            staff_req = self.config.get('staff_req', {})
            op_h = int(self.op_limit.split(':')[0])
            cl_h = int(self.cl_limit.split(':')[0])
            
            for d in self.dates:
                try: req_num = int(staff_req.get(d, 2))
                except: req_num = 2
                if req_num < 1: req_num = 1
                
                # 時間帯(h)ごとにチェック
                for h in range(op_h, cl_h):
                    workers_at_h = []
                    for s in self.staff_list:
                        for i, p in enumerate(self.patterns):
                            ph_start = int(p['start'].split(':')[0])
                            ph_end = int(p['end'].split(':')[0])
                            if ph_start <= h < ph_end:
                                workers_at_h.append(x[(s['id'], d, i)])
                    
                    if workers_at_h:
                        current_sum = pulp.lpSum(workers_at_h)
                        slack = pulp.LpVariable(f"slack_{d}_{h}", 0, req_num)
                        problem += current_sum + slack >= req_num
                        penalty += slack * 10000  # 不足は大減点

            # --- 制約3: NG日 ---
            for s in self.staff_list:
                ng_dates = self._get_ng_dates(s)
                for d in self.dates:
                    if d in ng_dates:
                        for i in range(len(self.patterns)):
                            problem += x[(s['id'], d, i)] == 0

            # --- 制約4: 勤務時間上限 & 営業時間外チェック ---
            for s in self.staff_list:
                try: max_hours = int(s.get('max_hours_day', 8))
                except: max_hours = 8
                
                for i, p in enumerate(self.patterns):
                    # 営業時間クリップ後の時間で計算
                    real_start = max(p['start'], self.op_limit)
                    real_end = min(p['end'], self.cl_limit)
                    duration = self._calc_duration(real_start, real_end)
                    
                    # 上限超え or パターン自体が営業時間外なら禁止
                    if duration > max_hours or p['start'] < self.op_limit or p['end'] > self.cl_limit:
                        for d in self.dates:
                            penalty += x[(s['id'], d, i)] * 999999

            # --- 制約5: ランク別ロジック ---
            # D(新人)が入る時間帯には、必ずA(店長)かB(中堅)がいること
            # (時間帯ごとにチェックするのは重いので、その日の合計で簡易判定)
            for d in self.dates:
                mentor_sum = pulp.lpSum([x[(mid, d, i)] for mid in (rank_a + rank_b) for i in range(len(self.patterns))])
                d_sum = pulp.lpSum([x[(did, d, i)] for did in rank_d for i in range(len(self.patterns))])
                
                # メンターが0人なのにDが入るとペナルティ
                # (Dの人数 <= メンター * 5 + 不足分)
                mlack = pulp.LpVariable(f"mlack_{d}", 0, len(rank_d))
                problem += d_sum <= mentor_sum * 5 + mlack
                penalty += mlack * 5000

            # Cランク(補充)の使用コスト
            for d in self.dates:
                for cid in rank_c:
                    penalty += pulp.lpSum([x[(cid, d, i)] for i in range(len(self.patterns))]) * 100

            # --- 計算実行 ---
            problem += penalty
            problem.solve(pulp.PULP_CBC_CMD(msg=0))

            if pulp.LpStatus[problem.status] in ['Optimal', 'Not Solved', 'Infeasible']:
                shifts = []
                for s in self.staff_list:
                    for d in self.dates:
                        for i, p in enumerate(self.patterns):
                            if pulp.value(x[(s['id'], d, i)]) == 1:
                                real_start = max(p['start'], self.op_limit)
                                real_end = min(p['end'], self.cl_limit)
                                dur = self._calc_duration(real_start, real_end)
                                brk = 60 if dur > 480 else (45 if dur > 360 else 0)

                                shifts.append({
                                    "staff_id": s['id'],
                                    "date": d,
                                    "start_time": real_start,
                                    "end_time": real_end,
                                    "break_minutes": brk
                                })
                return shifts
            return []
        except Exception as e:
            print(f"Solver Error: {e}")
            return []

    def _solve_fallback(self):
        # 安全装置
        shifts = []
        for d in self.dates:
            available = [s['id'] for s in self.staff_list] 
            selected = random.sample(available, min(len(available), 3))
            for sid in selected:
                shifts.append({
                    "staff_id": sid,
                    "date": d,
                    "start_time": self.op_limit,
                    "end_time": self.cl_limit,
                    "break_minutes": 60
                })
        return shifts

    def _get_ng_dates(self, staff):
        raw = staff.get('unavailable_dates')
        if not raw: return []
        if isinstance(raw, list): return [str(d).strip() for d in raw]
        return [str(d).strip() for d in raw.split(',')]

    def _calc_duration(self, start, end):
        sh, sm = map(int, start.split(':'))
        eh, em = map(int, end.split(':'))
        if (eh * 60 + em) < (sh * 60 + sm): eh += 24
        return ((eh * 60 + em) - (sh * 60 + sm)) / 60
