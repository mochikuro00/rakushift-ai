import json
from ortools.sat.python import cp_model

class ShiftScheduler:
    def __init__(self, staff_list, config, dates, requests):
        self.staff_list = staff_list
        self.config = config
        self.dates = dates
        self.requests = requests
        self.model = cp_model.CpModel()
        self.solver = cp_model.CpSolver()
        
        # 15分単位のタイムスロット (0=00:00, 96=24:00)
        self.time_slots = range(0, 96) 
        # シフト変数: shifts[(staff_id, date, time_slot)] = 1 (勤務) or 0 (休み)
        self.shifts = {}

    def solve(self):
        print("数理モデルを構築中...")
        
        # 変数の定義
        for s in self.staff_list:
            for d in self.dates:
                for t in self.time_slots:
                    self.shifts[(s['id'], d, t)] = self.model.NewBoolVar(f'shift_{s["id"]}_{d}_{t}')

        # --- 制約条件の追加 ---

        # 1. 申請（希望休・勤務希望）の反映
        for req in self.requests:
            if req['status'] != 'approved':
                continue
            
            s_id = req['staff_id']
            d = req['dates']
            
            if d not in self.dates:
                continue

            if req['type'] == 'off' or req['type'] == 'holiday':
                # 休み希望: 全スロットを0にする
                for t in self.time_slots:
                    if (s_id, d, t) in self.shifts:
                        self.model.Add(self.shifts[(s_id, d, t)] == 0)
            
            elif req['type'] == 'work':
                # 勤務希望: 指定時間は1にする (厳密にするなら「勤務可能」とするが、ここでは強制出勤とする)
                start_parts = req.get('start_time', '09:00').split(':')
                end_parts = req.get('end_time', '18:00').split(':')
                start_slot = int(start_parts[0]) * 4 + int(start_parts[1]) // 15
                end_slot = int(end_parts[0]) * 4 + int(end_parts[1]) // 15
                
                for t in range(start_slot, end_slot):
                    if (s_id, d, t) in self.shifts:
                        self.model.Add(self.shifts[(s_id, d, t)] == 1)

        # 2. 1日の勤務時間制約 (最低勤務時間 〜 最大勤務時間)
        min_work_hours = self.config.get('min_work_hours', 4)
        min_slots = min_work_hours * 4
        
        for s in self.staff_list:
            max_hours = float(s.get('max_hours_day', 8))
            max_slots = int(max_hours * 4)
            
            for d in self.dates:
                # 1日の合計勤務スロット数
                daily_work = sum(self.shifts[(s['id'], d, t)] for t in self.time_slots)
                
                # 働かない(0) か、働くなら最低〜最大の間
                # これを表現するために、is_working フラグを作る
                is_working = self.model.NewBoolVar(f'is_working_{s["id"]}_{d}')
                
                # is_working == 0 => daily_work == 0
                self.model.Add(daily_work == 0).OnlyEnforceIf(is_working.Not())
                
                # is_working == 1 => min <= daily_work <= max
                self.model.Add(daily_work >= min_slots).OnlyEnforceIf(is_working)
                self.model.Add(daily_work <= max_slots).OnlyEnforceIf(is_working)

                # 連続勤務制約 (シフトの抜け防止: 101は禁止)
                # 簡易的な実装: 勤務開始と終了は1回ずつしか現れない
                # (より厳密な実装も可能だが、計算量を抑えるため省略)

        # 3. 人員配置要件 (ソフト制約に変更: ペナルティ方式)
        req_weekday = self.config['staff_req'].get('min_weekday', 2)
        req_weekend = self.config['staff_req'].get('min_weekend', 3)
        req_manager = self.config['staff_req'].get('min_manager', 1)
        
        opening_time = self.config.get('opening_time', '09:00')
        closing_time = self.config.get('closing_time', '22:00')
        op_h, op_m = map(int, opening_time.split(':'))
        cl_h, cl_m = map(int, closing_time.split(':'))
        op_slot = op_h * 4 + op_m // 15
        cl_slot = cl_h * 4 + cl_m // 15

        # ペナルティ変数の合計
        total_penalty = 0

        for d in self.dates:
            # 曜日判定 (簡易的)
            is_weekend = False 
            base_req = req_weekend if is_weekend else req_weekday
            
            for t in range(op_slot, cl_slot):
                # 総人数 (不足分を許容し、不足人数 * 100 のペナルティを科す)
                total_staff = sum(self.shifts[(s['id'], d, t)] for s in self.staff_list)
                
                # 不足人数変数 (shortage >= 0, shortage >= base_req - total_staff)
                shortage = self.model.NewIntVar(0, 10, f'shortage_{d}_{t}')
                self.model.Add(total_staff + shortage >= base_req)
                total_penalty += shortage * 100
                
                # 管理者人数 (同様に不足分を許容)
                managers = [s for s in self.staff_list if s['role'] in ['manager', 'leader']]
                if managers:
                    total_managers = sum(self.shifts[(m['id'], d, t)] for m in managers)
                    mgr_shortage = self.model.NewIntVar(0, 10, f'mgr_shortage_{d}_{t}')
                    self.model.Add(total_managers + mgr_shortage >= req_manager)
                    total_penalty += mgr_shortage * 500 # 管理者不足はより重いペナルティ

        # 目的関数: ペナルティの最小化
        self.model.Minimize(total_penalty)

        # --- 解の探索 ---
        print("最適解を探索中...")
        status = self.solver.Solve(self.model)

        if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
            print(f"解が見つかりました: {self.solver.StatusName(status)}")
            return self.extract_solution()
        else:
            print("条件を満たすシフトが存在しません。要件を緩和してください。")
            return []

    def extract_solution(self):
        result = []
        for s in self.staff_list:
            for d in self.dates:
                # 連続した勤務時間を抽出してオブジェクト化
                start_t = -1
                for t in self.time_slots:
                    if self.solver.Value(self.shifts[(s['id'], d, t)]) == 1:
                        if start_t == -1:
                            start_t = t
                    else:
                        if start_t != -1:
                            # 勤務終了
                            end_t = t
                            result.append({
                                "staff_id": s['id'],
                                "date": d,
                                "start_time": f"{start_t//4:02d}:{start_t%4*15:02d}",
                                "end_time": f"{end_t//4:02d}:{end_t%4*15:02d}",
                                "break_minutes": 60 # 簡易設定
                            })
                            start_t = -1
                # 日付またぎ対応などは必要に応じて追加
        return result

# --- 実行用サンプルデータ (本来はAPIやJSONから受け取る) ---
if __name__ == "__main__":
    # サンプルデータ
    staff_data = [
        {"id": "1", "name": "店長", "role": "manager", "max_hours_day": 8},
        {"id": "2", "name": "Aさん", "role": "leader", "max_hours_day": 8},
        {"id": "3", "name": "Bさん", "role": "staff", "max_hours_day": 8},
        {"id": "4", "name": "Cさん", "role": "staff", "max_hours_day": 4}, # 短時間
        {"id": "5", "name": "Dさん", "role": "staff", "max_hours_day": 8},
    ]
    
    config_data = {
        "min_work_hours": 4,
        "staff_req": {"min_weekday": 3, "min_manager": 1},
        "opening_time": "09:00",
        "closing_time": "22:00"
    }
    
    target_dates = ["2025-12-27"] # 対象日
    requests_data = [] # 申請データ

    scheduler = ShiftScheduler(staff_data, config_data, target_dates, requests_data)
    shifts = scheduler.solve()
    
    print(json.dumps(shifts, indent=2, ensure_ascii=False))
