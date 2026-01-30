import google.generativeai as genai
import json
import time

class AIShiftScheduler:
    def __init__(self, api_key):
        genai.configure(api_key=api_key)
        # コスト最優先: Gemini 2.0 Flash Lite (Preview/Exp)
        # ※正式名称が決まるまでは 'gemini-2.0-flash-exp' 等を使用
        self.model = genai.GenerativeModel('gemini-2.0-flash-exp')

    def generate(self, staff_list, config, dates, requests):
        # プロンプトの構築
        prompt = self._build_prompt(staff_list, config, dates, requests)
        
        try:
            # Geminiに問い合わせ
            response = self.model.generate_content(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.2, # 創造性より正確性重視
                    response_mime_type='application/json'
                )
            )
            
            # JSONパース
            result = json.loads(response.text)
            
            # 配列またはオブジェクト内のshiftsキーから取り出す
            shifts = result if isinstance(result, list) else result.get("shifts", [])
            
            # データ整形 (念のため)
            cleaned_shifts = []
            for s in shifts:
                if "staff_id" in s and "date" in s and "start_time" in s and "end_time" in s:
                    cleaned_shifts.append(s)
                    
            return cleaned_shifts

        except Exception as e:
            print(f"Gemini API Error: {e}")
            raise e

    def _build_prompt(self, staff_list, config, dates, requests):
        # データ軽量化（IDと名前、役割、制約のみにする）
        simple_staff = [{
            "id": s["id"], 
            "name": s["name"], 
            "role": s["role"],
            "max_hours": s.get("max_hours_day", 8),
            "max_days": s.get("max_days_week", 5)
        } for s in staff_list]

        simple_reqs = [{
            "staff_id": r["staff_id"],
            "date": r["dates"],
            "type": r["type"] # work/off
        } for r in requests if r["dates"] in dates]

        return f"""
        Role: Professional Shift Scheduler.
        Task: Create a shift schedule JSON for the following dates: {', '.join(dates)}.
        
        Constraints:
        1. Opening Hours: {config.get('opening_times', '09:00-22:00')}
        2. Required Staff: 
           - Weekday: {config['staff_req'].get('min_weekday', 2)}
           - Weekend: {config['staff_req'].get('min_weekend', 3)}
           - Manager: {config['staff_req'].get('min_manager', 1)}
        3. Shift Rules:
           - Min Work Hours: {config.get('min_work_hours', 4)} hours.
           - Max Work Hours: Respect staff's 'max_hours'.
           - No split shifts (continuous work only).
        
        Data:
        - Staff: {json.dumps(simple_staff, ensure_ascii=False)}
        - Requests (Fixed): {json.dumps(simple_reqs, ensure_ascii=False)}
        
        Output Format:
        JSON Array of objects:
        [
          {{ "staff_id": "...", "date": "YYYY-MM-DD", "start_time": "HH:MM", "end_time": "HH:MM", "break_minutes": 60 }}
        ]
        """
