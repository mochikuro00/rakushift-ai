import sys
import os
import random
import time

# パスの追加
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'python')))
from scheduler import ShiftScheduler

def generate_random_staff(count=10):
    staff = []
    roles = ["hall", "kitchen", "manager", "rookie"]
    for i in range(count):
        staff.append({
            "id": f"staff_{i}",
            "name": f"Staff {i}",
            "role": random.choice(roles),
            "pref_start": "09:00",
            "pref_end": "22:00",
            "contract_type": random.choice(["hourly", "monthly"]),
            "shift_priority": random.choice(["high", "normal", "low"])
        })
    return staff

def generate_random_config():
    return {
        "opening_time": "09:00",
        "closing_time": "22:00",
        "staff_req": {
            "min_weekday": random.randint(1, 3),
            "min_manager": 1
        },
        "custom_shifts": [
            {"start": "09:00", "end": "15:00"},
            {"start": "17:00", "end": "22:00"}
        ]
    }

def run_stress_test(iterations=10000):
    print(f"🚀 Starting 10,000 iterations stress test on AI Scheduler...")
    start_time = time.time()
    success = 0
    errors = 0
    
    dates = ["2026-06-01", "2026-06-02"]
    
    for i in range(iterations):
        staff = generate_random_staff(random.randint(5, 15))
        config = generate_random_config()
        
        try:
            scheduler = ShiftScheduler(staff, config, dates)
            # ログ抑制のために一時的に標準出力を/dev/nullへ
            import sys, os
            original_stdout = sys.stdout
            sys.stdout = open(os.devnull, 'w')
            
            shifts = scheduler._solve_milp()
            
            sys.stdout.close()
            sys.stdout = original_stdout
            
            success += 1
        except Exception as e:
            sys.stdout = original_stdout
            errors += 1
            print(f"Iteration {i} failed: {e}")
            break
            
        if (i + 1) % 2500 == 0:
            print(f"✅ {i + 1} / {iterations} completed...")
            
    end_time = time.time()
    print("-" * 30)
    print("🎯 STRESS TEST RESULTS")
    print("-" * 30)
    print(f"Total Iterations: {iterations}")
    print(f"Success: {success}")
    print(f"Errors: {errors}")
    print(f"Time Elapsed: {end_time - start_time:.2f} seconds")
    print(f"Error Rate: {(errors/iterations)*100:.2f}%")
    print("-" * 30)

if __name__ == "__main__":
    run_stress_test(1000)
