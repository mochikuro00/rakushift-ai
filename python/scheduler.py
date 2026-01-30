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
            problem = pulp.LpProblem("Active_Team_Optimization", pulp.LpMinimize)
            
            # --- 1. 変数定義 & ランク分け ---
            x = {}
            
            # ランク別リスト
            rank_a = [] # A: 店長/エース (戦力値: 3)
            rank_b = [] # B: 戦力 (戦力値: 2)
            rank_c = [] # C: 補充 (戦力値: 1)
            rank_d = [] # D: 新人 (戦力値: 0.5 - 育成対象)

            for s in self.staff_list:
                for d in self.dates:
                    x[(s['id'], d)] = pulp.LpVariable(f"x_{s['id']}_{d}", 0, 1, pulp.LpBinary)

                # ランク判定（評価や役職から自動判別）
                role = str(s.get('role', '')).lower()
                eval_val = str(s.get('evaluation', '')).upper()
                sid = s['id']

                if eval_val == 'A' or '店長' in role or 'manager' in role:
                    rank_a.append(sid)
                elif eval_val == 'B' or 'leader' in role:
                    rank_b.append(sid)
                elif eval_val == 'C':
                    rank_c.append(sid)
                elif eval_val == 'D' or '研修' in role or 'バイト' in role:
                    rank_d.append(sid)
                else:
                    rank_b.append(sid) # デフォルトはB

            # メンター役（AとB）のリスト
            mentors = rank_a + rank_b

            # --- 2. 制約条件 & ペナルティ ---
            penalty = 0

            # 【基本1】 NG日（希望休）は絶対守る
            for s in self.staff_list:
                ng_dates = s.get('unavailable_dates', [])
                if isinstance(ng_dates, str):
                    ng_dates = ng_dates.split(',') if ng_dates else []
                for d in self.dates:
                    if d in ng_dates:
                        problem += x[(s['id'], d)] == 0

            # 【基本2】 週の勤務日数（やんわり守る）
            for s in self.staff_list:
                # 0日設定でも週5とみなす安全策
                raw_max = s.get('max_days_week')
                try: max_days = int(raw_max) if raw_max and int(raw_max) > 0 else 5
                except: max_days = 5

                limit = max_days * (len(self.dates) / 7.0)
                
                # 超過したらペナルティ (絶対禁止にはしない)
                over_work = pulp.LpVariable(f"over_{s['id']}", 0, len(self.dates))
                problem += pulp.lpSum([x[(s['id'], d)] for d in self.dates]) <= limit + over_work
                penalty += over_work * 1000

            # 【現場活性化ルール1】 必要人数の確保
            staff_req = self.config.get('staff_req', {})
            for d in self.dates:
                try: req_num = int(staff_req.get(d, 2))
                except: req_num = 2
                if req_num < 1: req_num = 1

                daily_sum = pulp.lpSum([x[(s['id'], d)] for s in self.staff_list])
                
                # 不足したら特大ペナルティ
                slack = pulp.LpVariable(f"slack_{d}", 0, req_num)
                problem += daily_sum + slack >= req_num
                penalty += slack * 50000 # 最優先事項

            # 【現場活性化ルール2】 「新人守護」 (OJTロジック)
            # Dが入る日は、必ずAかBが1人以上いること。
            # いない場合はペナルティ
            for d in self.dates:
                # その日のメンター(A+B)の合計数
                mentor_sum = pulp.lpSum([x[(mid, d)] for mid in mentors])
                
                for did in rank_d:
                    # Dが出勤(1) なのに メンターが0 だとペナルティ
                    # 簡易表現: 「Dの出勤」が「メンターの出勤 + 1」より大きくなるとペナルティ
                    # (厳密な条件分岐は重くなるので、Dを入れるコストを下げることで調整)
                    pass
                
                # メンターが0人の日に、Dを入れると大幅減点する変数を追加
                # Dの合計 > メンターの合計 * 10 (メンターがいればDは10人までOK)
                d_sum = pulp.lpSum([x[(did, d)] for did in rank_d])
                
                # メンター不足変数
                mentor_lack = pulp.LpVariable(f"mlack_{d}", 0, len(rank_d))
                problem += d_sum <= mentor_sum * 5 + mentor_lack # メンター1人につきD5人まで
                penalty += mentor_lack * 5000 # メンターなしのD出勤は極力避ける

            # 【現場活性化ルール3】 ランク別優先度 (コスト調整)
            # A, B は積極的に入れる(コスト0)
            # C はあまり入れない(コストあり)
            # D はA,Bがいれば入れる(コスト小)
            for d in self.dates:
                penalty += pulp.lpSum([x[(cid, d)] * 100 for cid in rank_c]) # Cは控えめに
                penalty += pulp.lpSum([x[(did, d)] * 10 for did in rank_d])  # Dは普通

            # --- 3. 計算実行 ---
            problem += penalty
            problem.solve(pulp.PULP_CBC_CMD(msg=0))

            # --- 4. 結果出力 ---
            shifts = []
            open_time = self.config.get('opening_time', '09:00')
            close_time = self.config.get('closing_time', '22:00')

            # 解があってもなくても、取れるだけのデータでシフトを作る
            for s in self.staff_list:
                for d in self.dates:
                    if pulp.value(x[(s['id'], d)]) and pulp.value(x[(s['id'], d)]) > 0.5:
                        shifts.append({
                            "staff_id": s['id'],
                            "date": d,
                            "start_time": open_time,
                            "end_time": close_time,
                            "break_minutes": 60
                        })
            return shifts

        except Exception as e:
            print(f"Scheduler Logic Error: {e}")
            return []
