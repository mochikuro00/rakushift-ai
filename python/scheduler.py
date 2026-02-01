import pulp
import random

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

        # 店舗のシフトパターンを取得 (なければデフォルト作成)
        self.patterns = config.get('custom_shifts', [])
        
        # 営業時間 (デフォルト)
        self.op_limit = config.get('opening_time', '09:00')
        self.cl_limit = config.get('closing_time', '22:00')

        if not self.patterns:
            # デフォルトパターン: 早番・遅番・通し
            op = self.op_limit
            cl = self.cl_limit
            # 簡易的に真ん中で割る
            mid_h = (int(op.split(':')[0]) + int(cl.split(':')[0])) // 2
            mid_time = f"{mid_h:02d}:00"
            
            self.patterns = [
                {"name": "早番", "start": op, "end": mid_time},
                {"name": "遅番", "start": mid_time, "end": cl},
                {"name": "通し", "start": op, "end": cl}
            ]

    def solve(self):
        # 1. 数理最適化 (シフトパターン考慮)
        result = self._solve_optimized()
        
        # 2. 失敗したらフォールバック
        if not result:
            print("Fallback logic triggered.")
            result = self._solve_fallback()
            
        return result

    def _solve_optimized(self):
        try:
            problem = pulp.LpProblem("Shift_Optimization", pulp.LpMinimize)
            
            # 変数: x[staff_id][date][pattern_idx]
            # (誰が、いつ、どのシフトパターンで入るか)
            x = {}
            for s in self.staff_list:
                for d in self.dates:
                    for p_idx, pat in enumerate(self.patterns):
                        x[(s['id'], d, p_idx)] = pulp.LpVariable(f"x_{s['id']}_{d}_{p_idx}", 0, 1, pulp.LpBinary)

            # 制約1: 1人1日1パターンまで (重複禁止)
            for s in self.staff_list:
                for d in self.dates:
                    problem += pulp.lpSum([x[(s['id'], d, p_idx)] for p_idx in range(len(self.patterns))]) <= 1

            # 制約2: 必要人数 (パターン合計で判定)
            staff_req = self.config.get('staff_req', {})
            penalty = 0
            
            for d in self.dates:
                try: req_num = int(staff_req.get(d, 2))
                except: req_num = 2
                if req_num < 1: req_num = 1
                
                # その日の総出勤数
                daily_sum = pulp.lpSum([
                    x[(s['id'], d, p_idx)] 
                    for s in self.staff_list 
                    for p_idx in range(len(self.patterns))
                ])
                
                slack = pulp.LpVariable(f"slack_{d}", 0, req_num)
                problem += daily_sum + slack >= req_num
                penalty += slack * 10000

            # 制約3: NG日
            for s in self.staff_list:
                ng_dates = self._get_ng_dates(s)
                for d in self.dates:
                    if d in ng_dates:
                        for p_idx in range(len(self.patterns)):
                            problem += x[(s['id'], d, p_idx)] == 0

            # 制約4: 勤務時間上限 (労基法対策)
            # 各パターンの時間を計算して、スタッフの上限を超えないようにする
            for s in self.staff_list:
                try: max_hours = int(s.get('max_hours_day', 8))
                except: max_hours = 8
                
                for p_idx, pat in enumerate(self.patterns):
                    # 営業時間ではみ出しをカットした時間で計算
                    real_start = max(pat['start'], self.op_limit)
                    real_end = min(pat['end'], self.cl_limit)
                    duration = self._calc_duration(real_start, real_end)
                    
                    if duration > max_hours:
                        # 上限を超えるパターンは禁止 (コスト無限大)
                        for d in self.dates:
                            penalty += x[(s['id'], d, p_idx)] * 999999

            problem += penalty
            problem.solve(pulp.PULP_CBC_CMD(msg=0))

            if pulp.LpStatus[problem.status] in ['Optimal', 'Not Solved', 'Infeasible']:
                shifts = []
                for s in self.staff_list:
                    for d in self.dates:
                        for i, p in enumerate(self.patterns):
                            if pulp.value(x[(s['id'], d, i)]) == 1:
                                # 時間がはみ出さないようにクリップ
                                start_t = max(p['start'], self.op_limit)
                                end_t = min(p['end'], self.cl_limit)
                                
                                # 休憩時間の計算
                                dur = self._calc_duration(start_t, end_t)
                                brk = 60 if dur > 480 else (45 if dur > 360 else 0)

                                shifts.append({
                                    "staff_id": s['id'],
                                    "date": d,
                                    "start_time": start_t,
                                    "end_time": end_t,
                                    "break_minutes": brk
                                })
                return shifts
            return []
        except Exception as e:
            print(f"Solver Error: {e}")
            return []

    def _solve_fallback(self):
        # 安全装置: 営業時間内のランダムシフト
        shifts = []
        for d in self.dates:
            # NG日以外の人から選ぶ
            available = [s for s in self.staff_list if d not in self._get_ng_dates(s)]
            count = min(len(available), 3)
            selected = random.sample(available, count) if available else []
            
            for s in selected:
                # パターンがあればそれを使う、なければ営業時間フル
                pat = self.patterns[0] if self.patterns else {"start": self.op_limit, "end": self.cl_limit}
                
                # クリップ処理
                start_t = max(pat['start'], self.op_limit)
                end_t = min(pat['end'], self.cl_limit)
                
                shifts.append({
                    "staff_id": s['id'],
                    "date": d,
                    "start_time": start_t,
                    "end_time": end_t,
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
        # 日またぎ考慮 (終了 < 開始 なら +24h)
        if (eh * 60 + em) < (sh * 60 + sm):
            eh += 24
        return ((eh * 60 + em) - (sh * 60 + sm)) / 60
