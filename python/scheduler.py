import pulp

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests=[]):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests

    def solve(self):
        try:
            # 数理モデルの定義
            problem = pulp.LpProblem("Shift_Optimization", pulp.LpMinimize)
            
            # --- 1. 変数定義 ---
            # x[staff_id][date] (1=勤務, 0=休み)
            x = {}
            for s in self.staff_list:
                for d in self.dates:
                    x[(s['id'], d)] = pulp.LpVariable(f"x_{s['id']}_{d}", 0, 1, pulp.LpBinary)

            # --- 2. ランクごとのスタッフIDリスト作成 ---
            # evaluation: A(店長/責任者), B(通常), C(補充要員), D(研修)
            rank_a = [s['id'] for s in self.staff_list if s.get('evaluation') == 'A']
            rank_b = [s['id'] for s in self.staff_list if s.get('evaluation') == 'B']
            rank_c = [s['id'] for s in self.staff_list if s.get('evaluation') == 'C']
            rank_d = [s['id'] for s in self.staff_list if s.get('evaluation') == 'D']

            # --- 3. 制約条件 ---

            # 【制約A】 必要人数の確保（ソフト制約）
            staff_req = self.config.get('staff_req', {})
            slack_vars = {} # 不足人数
            
            for d in self.dates:
                req_num = int(staff_req.get(d, 2))
                if req_num < 1: req_num = 1

                daily_sum = pulp.lpSum([x[(s['id'], d)] for s in self.staff_list])
                
                slack = pulp.LpVariable(f"slack_{d}", 0, req_num)
                slack_vars[d] = slack
                
                problem += daily_sum + slack >= req_num

            # 【制約B】 NG日（希望休）には入れない
            for s in self.staff_list:
                ng_dates = s.get('unavailable_dates', [])
                if isinstance(ng_dates, str):
                    ng_dates = ng_dates.split(',') if ng_dates else []
                
                for d in self.dates:
                    if d in ng_dates:
                        problem += x[(s['id'], d)] == 0

            # 【制約C】 週（期間内）の勤務日数制限 (前回修正した安全策込み)
            for s in self.staff_list:
                raw_max = s.get('max_days_week')
                if raw_max is None or str(raw_max) == '0' or raw_max == '':
                    max_days = 5
                else:
                    try: max_days = int(raw_max)
                    except: max_days = 5

                limit = max_days * (len(self.dates) / 7.0)
                problem += pulp.lpSum([x[(s['id'], d)] for d in self.dates]) <= limit + 1.9

            # 【制約D】 ★重要★ 「D(研修)は、A(責任者)がいない日はNG」
            # 論理: Dが出勤(1)なら、Aの合計は1以上でなければならない
            # 式: x[D, d] <= Sum(x[A, d])
            for d in self.dates:
                # その日のAランクの合計勤務数
                sum_a_on_day = pulp.lpSum([x[(aid, d)] for aid in rank_a])
                
                for did in rank_d:
                    # Dランクのスタッフ一人ひとりに対して、「Aの合計以下」を強制
                    # これにより、Aが0人なら、Dは強制的に0(休み)になる
                    problem += x[(did, d)] <= sum_a_on_day

            # --- 4. 目的関数（優先順位の調整） ---
            # コスト（ペナルティ）を最小化する
            # 不足ペナルティ: 1000点 (最優先で埋める)
            # Cランク採用コスト: 100点 (できれば入れたくない)
            # Bランク採用コスト: 10点 (普通)
            # Aランク採用コスト: 0点 (積極的に入れたい)
            # Dランク採用コスト: 10点 (Aがいれば入ってOK)
            
            penalty = 0
            
            # 1. 人数不足のペナルティ
            penalty += pulp.lpSum([slack_vars[d] * 1000 for d in self.dates])
            
            # 2. ランク別の採用コスト
            for d in self.dates:
                # Cランクがシフトに入るとペナルティ加算
                penalty += pulp.lpSum([x[(cid, d)] * 100 for cid in rank_c])
                
                # B, Dランクは少しだけ加算（Aよりは優先度下げるため）
                penalty += pulp.lpSum([x[(bid, d)] * 10 for bid in rank_b])
                penalty += pulp.lpSum([x[(did, d)] * 10 for did in rank_d])
                
                # Aランクは加算なし（0点）なので、最適化計算はAを優先的に選ぼうとする

            problem += penalty

            # --- 5. 計算実行 ---
            problem.solve(pulp.PULP_CBC_CMD(msg=0))

            # 結果作成
            status = pulp.LpStatus[problem.status]
            if status == 'Optimal' or status == 'Not Solved' or status == 'Infeasible':
                shifts = []
                open_time = self.config.get('opening_time', '09:00')
                close_time = self.config.get('closing_time', '22:00')

                for s in self.staff_list:
                    for d in self.dates:
                        if pulp.value(x[(s['id'], d)]) == 1:
                            shifts.append({
                                "staff_id": s['id'],
                                "date": d,
                                "start_time": open_time,
                                "end_time": close_time,
                                "break_minutes": 60
                            })
                return shifts
            else:
                return []

        except Exception as e:
            print(f"Scheduler Logic Error: {e}")
            return []
