import pulp
import random

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

    def solve(self):
        # メインの計算ロジック（高精度）を実行
        result = self._solve_optimized()
        
        # もし計算に失敗して空っぽだったら、予備のロジック（確実に出す）を実行
        if not result or len(result) == 0:
            print("Optimization failed. Switching to fallback logic.")
            result = self._solve_fallback()
            
        return result

    def _solve_optimized(self):
        try:
            problem = pulp.LpProblem("Shift_Optimization", pulp.LpMinimize)
            x = {}
            
            # 変数定義
            for s in self.staff_list:
                for d in self.dates:
                    x[(s['id'], d)] = pulp.LpVariable(f"x_{s['id']}_{d}", 0, 1, pulp.LpBinary)

            # ランク判定
            rank_a = []
            rank_d = []
            for s in self.staff_list:
                eval_val = str(s.get('evaluation', '')).upper()
                role = str(s.get('role', '')).lower()
                if eval_val == 'A' or '店長' in role:
                    rank_a.append(s['id'])
                elif eval_val == 'D':
                    rank_d.append(s['id'])

            penalty = 0

            # 1. NG日 (ハード制約) - 安全対策済み
            for s in self.staff_list:
                raw_ng = s.get('unavailable_dates')
                ng_dates = []
                
                if raw_ng:
                    if isinstance(raw_ng, list):
                        ng_dates = raw_ng
                    elif isinstance(raw_ng, str):
                        ng_dates = raw_ng.split(',')
                
                # 空白除去などのクリーニング
                ng_dates = [str(d).strip() for d in ng_dates if d]

                for d in self.dates:
                    if d in ng_dates:
                        problem += x[(s['id'], d)] == 0

            # 2. 必要人数 (ソフト制約)
            staff_req = self.config.get('staff_req', {})
            for d in self.dates:
                try: req_num = int(staff_req.get(d, 2))
                except: req_num = 2
                
                daily_sum = pulp.lpSum([x[(s['id'], d)] for s in self.staff_list])
                slack = pulp.LpVariable(f"slack_{d}", 0, req_num)
                problem += daily_sum + slack >= req_num
                penalty += slack * 10000

            # 3. ランクDはAとセット (ソフト制約)
            for d in self.dates:
                sum_a = pulp.lpSum([x[(aid, d)] for aid in rank_a])
                for did in rank_d:
                    # Aが0人でDが入るとペナルティ
                    penalty += x[(did, d)] * 100
                penalty -= sum_a * 100

            # 4. 勤務日数制限 (ソフト制約)
            for s in self.staff_list:
                try: max_days = int(s.get('max_days_week', 5))
                except: max_days = 5
                limit = max_days * (len(self.dates) / 7.0)
                over = pulp.LpVariable(f"over_{s['id']}", 0, len(self.dates))
                problem += pulp.lpSum([x[(s['id'], d)] for d in self.dates]) <= limit + over
                penalty += over * 5000

            problem += penalty
            problem.solve(pulp.PULP_CBC_CMD(msg=0))

            if pulp.LpStatus[problem.status] in ['Optimal', 'Not Solved', 'Infeasible']:
                shifts = []
                open_time = self.config.get('opening_time', '09:00')
                close_time = self.config.get('closing_time', '22:00')
                
                for s in self.staff_list:
                    for d in self.dates:
                        val = pulp.value(x[(s['id'], d)])
                        if val and val > 0.5:
                            shifts.append({
                                "staff_id": s['id'],
                                "date": d,
                                "start_time": open_time,
                                "end_time": close_time,
                                "break_minutes": 60
                            })
                return shifts
            return []
        except Exception as e:
            print(f"Solver Error: {e}")
            return []

    def _solve_fallback(self):
        # 【安全装置】 計算が破綻した場合の強制割り当てロジック
        shifts = []
        open_time = self.config.get('opening_time', '09:00')
        close_time = self.config.get('closing_time', '22:00')
        
        # 1日ごとに
        for d in self.dates:
            # 働けるスタッフを探す
            available = []
            for s in self.staff_list:
                raw_ng = s.get('unavailable_dates')
                ng_dates = []
                if raw_ng:
                    if isinstance(raw_ng, list): ng_dates = raw_ng
                    elif isinstance(raw_ng, str): ng_dates = raw_ng.split(',')
                ng_dates = [str(date).strip() for date in ng_dates]

                if d not in ng_dates:
                    available.append(s['id'])
            
            # とりあえずランダムに2〜3人入れる
            count = min(len(available), 3)
            selected = random.sample(available, count) if available else []
            
            for sid in selected:
                shifts.append({
                    "staff_id": sid,
                    "date": d,
                    "start_time": open_time,
                    "end_time": close_time,
                    "break_minutes": 60
                })
        
        return shifts
